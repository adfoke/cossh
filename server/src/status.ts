// 服务器状态采集：GET /api/status?host= → 单次 ssh 跑 POSIX 采集脚本 → 结构化指标。
// 设计约束（都是踩过坑的）：
//  - host 严格白名单正则：它会被拼进 ssh argv，必须掐死注入面；
//  - ControlMaster 复用连接：5s 轮询如果每次新建 TCP，等于对目标机发动连接风暴（sshguard 实锤过）；
//  - 每 host 缓存 + in-flight 去重 + 最小刷新间隔：同主机多个状态卡共享一次 ssh；
//  - 失败也进缓存（短 TTL）：机器没配 key/挂了时不至于把 ssh 打成弹幕。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** [user@]host，只放行 ssh 友好字符；禁开头 '-' 防 ssh 选项注入 */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export const MIN_REFRESH_MS = 2_000; // 成功结果的最短复用间隔
const ERR_REFRESH_MS = 5_000; // 失败结果的静默窗口
const COLLECT_TIMEOUT_MS = 15_000;

export interface DiskUsage { mount: string; totalMb: number; usedMb: number; pct: number }
export interface NetUsage { name: string; rxBytes: number; txBytes: number; rxRateKbps: number | null; txRateKbps: number | null }
export interface ProcTop { pid: number; user: string; cpuPct: number; memPct: number; command: string }

export interface StatusResult {
  ok: boolean;
  host: string;
  at: number; // 采集完成时间戳（ms）
  err?: string;
  os?: string;
  hostname?: string;
  user?: string;
  uptimeSec?: number;
  load?: number[]; // 1/5/15
  cpus?: number;
  cpuPct?: number | null;
  memTotalKb?: number;
  memUsedKb?: number;
  memUsedPct?: number | null;
  disks?: DiskUsage[];
  nets?: NetUsage[];
  procs?: ProcTop[];
  docker?: { running: number; total: number } | null;
}

export function isValidStatusHost(host: string): boolean {
  return HOST_RE.test(host);
}

/* ───────────── 采集脚本（远端 sh -s，stdin 喂入 → 内部引号自由） ───────────── */

const COLLECT_SCRIPT = `
if [ -r /proc/stat ]; then
  echo "os=Linux"
  echo "hostname=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"
  echo "user=$(id -un 2>/dev/null)"
  echo "uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"
  echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
  echo "cpus=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null)"
  echo "mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"
  echo "mem_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
  echo "cpu_a=$(awk 'NR==1{out="";for(i=2;i<=NF;i++) out=out $i " "; print out}' /proc/stat)"
  sed 's/:/ /' /proc/net/dev 2>/dev/null | awk 'NR>2 && $1!="" && $1!="lo" {print "net_a "$1" "$2" "$10}'
  sleep 0.5
  echo "cpu_b=$(awk 'NR==1{out="";for(i=2;i<=NF;i++) out=out $i " "; print out}' /proc/stat)"
  sed 's/:/ /' /proc/net/dev 2>/dev/null | awk 'NR>2 && $1!="" && $1!="lo" {print "net_b "$1" "$2" "$10}'
  echo "gap=0.5"
else
  echo "os=Darwin"
  echo "hostname=$(hostname 2>/dev/null)"
  echo "user=$(id -un 2>/dev/null)"
  bt=$(sysctl -n kern.boottime 2>/dev/null | sed 's/.*sec = \\([0-9]*\\).*/\\1/')
  [ -n "$bt" ] && echo "uptime=$(( $(date +%s) - bt ))"
  echo "load=$(sysctl -n vm.loadavg 2>/dev/null | tr -cd '0-9. ')"
  echo "cpus=$(sysctl -n hw.ncpu 2>/dev/null)"
  echo "mem_bytes=$(sysctl -n hw.memsize 2>/dev/null)"
  vm_stat 2>/dev/null | awk '/page size of/{if (match($0,/[0-9]+/)) print "pagesize=" substr($0,RSTART,RLENGTH)} /Pages active:/{if (match($0,/[0-9]+/)) print "vm_active=" substr($0,RSTART,RLENGTH)} /Pages inactive:/{if (match($0,/[0-9]+/)) print "vm_inactive=" substr($0,RSTART,RLENGTH)} /Pages wired down:/{if (match($0,/[0-9]+/)) print "vm_wired=" substr($0,RSTART,RLENGTH)} /occupied by compressor:/{if (match($0,/[0-9]+/)) print "vm_compressed=" substr($0,RSTART,RLENGTH)}'
  echo "cpu_busy_a=$(top -l 2 -n 0 2>/dev/null | grep 'CPU usage' | tail -n 1 | awk '{gsub(/%/,"",$3); gsub(/%/,"",$5); print $3+$5}')"
  sleep 0.3
  echo "cpu_busy_b=$(top -l 2 -n 0 2>/dev/null | grep 'CPU usage' | tail -n 1 | awk '{gsub(/%/,"",$3); gsub(/%/,"",$5); print $3+$5}')"
  netstat -ibn 2>/dev/null | awk '/^en[0-9]/ && !seen[$1]++ {print "net_a "$1" "$7" "$10}'
  sleep 0.5
  netstat -ibn 2>/dev/null | awk '/^en[0-9]/ && !seen[$1]++ {print "net_b "$1" "$7" "$10}'
  echo "gap=0.5"
fi
df -P 2>/dev/null | awk 'NR>1 && ($1 ~ /^\\/dev\\// || $1 == "overlay") {print "disk "$6" "$2" "$3}'
ps aux 2>/dev/null | tail -n +2 | sort -k3 -rn | head -7 | awk '{cmd=$11; for(i=12;i<=NF && i<16;i++) cmd=cmd" "$i; print "proc "$2" "$3" "$4" "$1" "cmd}'
if command -v docker >/dev/null 2>&1; then
  echo "docker_run=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
  echo "docker_all=$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')"
fi
echo "done=1"
`;

/* ───────────── ssh 执行 ───────────── */

const CM_DIR = path.join(os.tmpdir(), "sshx-status-cm");

function runSsh(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      mkdirSync(CM_DIR, { recursive: true }); // 目录不存在 ssh 会静默退化直连（连接风暴的老路）
    } catch {
      /* 竞态无所谓 */
    }
    const args = [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=6",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${CM_DIR}/cm-%r@%h:%p`,
      "-o", "ControlPersist=120",
      "--", host,
      "sh -s",
    ];
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errbuf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ssh 超时（>${COLLECT_TIMEOUT_MS / 1000}s）`));
    }, COLLECT_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 256 * 1024) child.kill("SIGKILL"); // 防跑飞
    });
    child.stderr.on("data", (d: Buffer) => (errbuf += d.toString("utf8").slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ssh 启动失败：${(e as Error).message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ssh 退出码 ${code}：${(errbuf.trim().split("\n").slice(-1)[0] ?? "无 stderr").slice(0, 200)}`));
    });
    child.stdin.write(COLLECT_SCRIPT);
    child.stdin.end();
  });
}

/** 宽容数值：容忍 "12.5%" 这类带尾缀的（awk 版本差异保险） */
const pf = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const num = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};

function clampPct(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

/* ───────────── 解析：kv/多列行 → 结构化（含双采样差值） ───────────── */

export function parseCollectOutput(host: string, raw: string): StatusResult {
  const kv = new Map<string, string[]>();
  const push = (k: string, v: string) => {
    if (!v.trim()) return;
    const arr = kv.get(k) ?? [];
    arr.push(v.trim());
    kv.set(k, arr);
  };
  const get1 = (k: string) => kv.get(k)?.[0];
  const getN = (k: string) => kv.get(k) ?? [];

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(" ");
    const first = sp < 0 ? t : t.slice(0, sp);
    if (first === "net_a" || first === "net_b" || first === "disk" || first === "proc") {
      push(first, t.slice(sp + 1));
      continue;
    }
    const eq = t.indexOf("=");
    if (eq > 0) push(t.slice(0, eq), t.slice(eq + 1));
  }

  const osName = get1("os") ?? "";
  const result: StatusResult = { ok: true, host, at: Date.now(), os: osName };
  result.hostname = get1("hostname");
  result.user = get1("user");
  result.uptimeSec = num(get1("uptime")) ?? undefined;
  result.cpus = num(get1("cpus")) ?? undefined;
  const load = (get1("load") ?? "").split(/\s+/).map(num).filter((n): n is number => n != null);
  if (load.length) result.load = load.slice(0, 3);

  // ── CPU：Linux jiffies 双采样差值；macOS top 两拍取均值 ──
  const gap = num(get1("gap")) ?? 0.5;
  const cpuA = (get1("cpu_a") ?? "").split(/\s+/).map(num).filter((n) => n != null) as number[];
  const cpuB = (get1("cpu_b") ?? "").split(/\s+/).map(num).filter((n) => n != null) as number[];
  if (cpuA.length >= 5 && cpuB.length >= 5) {
    const sum = (a: number[]) => a.reduce<number>((s, n) => s + n, 0);
    const totalD = sum(cpuB) - sum(cpuA);
    const idleD = (cpuB[3] - cpuA[3]) + (cpuB[4] - cpuA[4]); // idle + iowait
    if (totalD > 0) result.cpuPct = clampPct((1 - idleD / totalD) * 100);
  } else {
    const a = pf(get1("cpu_busy_a"));
    const b = pf(get1("cpu_busy_b"));
    result.cpuPct = a != null && b != null ? clampPct((a + b) / 2) : clampPct((a ?? b ?? 0));
    if (a == null && b == null) result.cpuPct = null;
  }

  // ── 内存 ──
  const memTotal = num(get1("mem_total")); // Linux kB
  const memAvail = num(get1("mem_avail"));
  if (memTotal && memAvail != null) {
    result.memTotalKb = memTotal;
    result.memUsedKb = Math.max(0, memTotal - memAvail);
    result.memUsedPct = clampPct((result.memUsedKb / memTotal) * 100);
  } else if (osName === "Darwin") {
    const bytes = num(get1("mem_bytes"));
    const pagesize = num(get1("pagesize")) ?? 4096;
    const used = ["vm_active", "vm_wired", "vm_compressed"].reduce((s, k) => s + (num(get1(k)) ?? 0), 0);
    if (bytes && used > 0) {
      const totalKb = bytes / 1024;
      const usedKb = (used * pagesize) / 1024;
      result.memTotalKb = Math.round(totalKb);
      result.memUsedKb = Math.round(Math.min(usedKb, totalKb));
      result.memUsedPct = clampPct((Math.min(usedKb, totalKb) / totalKb) * 100);
    }
  }

  // ── 磁盘（awk 已滤成 "mount total1k used1k"） ──
  result.disks = getN("disk")
    .map((l) => {
      const [mount, total1k, used1k] = l.split(/\s+/);
      const tk = num(total1k);
      const uk = num(used1k);
      if (!mount || tk == null || uk == null || tk <= 0) return null;
      const totalMb = Math.round(tk / 1024);
      const usedMb = Math.round(uk / 1024);
      return { mount, totalMb, usedMb, pct: clampPct((uk / tk) * 100) } satisfies DiskUsage;
    })
    .filter((d): d is DiskUsage => d != null)
    .sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : b.pct - a.pct))
    .slice(0, 6);

  // ── 网络（双采样差值 → kbps） ──
  const netA = new Map<string, [number, number]>();
  const netB = new Map<string, [number, number]>();
  for (const [m, store] of [[getN("net_a"), netA], [getN("net_b"), netB]] as const) {
    for (const l of m) {
      const [name, rx, tx] = l.split(/\s+/);
      const r = num(rx);
      const t = num(tx);
      if (name && r != null && t != null) store.set(name, [r, t]);
    }
  }
  result.nets = [...netA.entries()]
    .map(([name, [rx, tx]]): NetUsage | null => {
      const b = netB.get(name);
      if (!b || gap <= 0) return null;
      return {
        name,
        rxBytes: b[0],
        txBytes: b[1],
        rxRateKbps: Math.round((Math.max(0, b[0] - rx) / gap) * 8) / 1000,
        txRateKbps: Math.round((Math.max(0, b[1] - tx) / gap) * 8) / 1000,
      } satisfies NetUsage;
    })
    .filter((n): n is NetUsage => n != null)
    .sort((a, b) => (b.rxRateKbps ?? 0) + (b.txRateKbps ?? 0) - ((a.rxRateKbps ?? 0) + (a.txRateKbps ?? 0)))
    .slice(0, 6);

  // ── 进程 top（"pid cpu mem user cmd..."） ──
  result.procs = getN("proc")
    .map((l) => {
      const [pid, cpu, mem, user, ...rest] = l.split(/\s+/);
      const p = num(pid);
      const c = num(cpu);
      const m = num(mem);
      if (p == null || c == null || m == null) return null;
      return { pid: p, user: user ?? "", cpuPct: c, memPct: m, command: rest.join(" ").slice(0, 60) } satisfies ProcTop;
    })
    .filter((p): p is ProcTop => p != null)
    .slice(0, 6);

  // ── docker ──
  const dr = num(get1("docker_run"));
  const da = num(get1("docker_all"));
  result.docker = dr != null || da != null ? { running: dr ?? 0, total: da ?? 0 } : null;

  if (get1("done") !== "1") result.err = "采集脚本未正常收尾（远端 sh 异常或输出被截断）";
  return result;
}

/* ───────────── 缓存 / 去重 ───────────── */

type CacheEntry = { at: number; data: StatusResult; inflight?: Promise<StatusResult> };
const cache = new Map<string, CacheEntry>();

export async function getStatus(host: string, opts?: { fresh?: boolean }): Promise<StatusResult> {
  const now = Date.now();
  const c = cache.get(host);
  if (!opts?.fresh && c) {
    const ttl = c.data.ok ? MIN_REFRESH_MS : ERR_REFRESH_MS;
    if (now - c.at < ttl) return c.data;
    if (c.inflight) return c.inflight;
  }
  if (c?.inflight && !opts?.fresh) return c.inflight;
  const entry: CacheEntry = c ?? { at: 0, data: { ok: false, host, at: 0 } };
  cache.set(host, entry);
  const p = (async (): Promise<StatusResult> => {
    let data: StatusResult;
    try {
      data = parseCollectOutput(host, await runSsh(host));
    } catch (e) {
      data = { ok: false, host, at: Date.now(), err: (e as Error).message };
    }
    entry.at = Date.now();
    entry.data = data;
    entry.inflight = undefined;
    return data;
  })();
  entry.inflight = p;
  return p;
}

/** 测试后门：清某主机/全部缓存 */
export function clearStatusCache(host?: string): void {
  if (host) cache.delete(host);
  else cache.clear();
}
