// 观察事件总线：ssh shim 上报「某 host 的某 tmux 会话正在被驱动」→ 画布轮询拉新 → 自动开观察窗。
// 环形缓冲 + 递增 id：多标签页各自记游标，事件只增不删（同 key 去重）。
export interface ObserveEvent {
  id: number;
  key: string; // `${host} ${session}`：画布按 key 去重开窗
  host: string;
  session: string;
  user: string; // ssh 登录名（attach 命令要还原 user@host，缺了会以本机用户名登录被拒）
  by: string;
  at: number;
}

const RING: ObserveEvent[] = [];
const SEEN = new Set<string>();
let nextId = 1;

const HOST_RE = /^[A-Za-z0-9_.+-]{1,64}$/;
const SESS_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function reportObserve(input: { host?: string; session?: string; user?: string; by?: string }): boolean {
  const host = String(input.host ?? "");
  const session = String(input.session ?? "").split(":")[0]; // 去掉 window.pane 后缀
  const user = /^[A-Za-z0-9_.-]{1,32}$/.test(String(input.user ?? "")) ? String(input.user) : "";
  if (!HOST_RE.test(host) || !SESS_RE.test(session)) return false; // 会被拼进 shell 命令，字符集从严
  const key = `${host} ${session}`;
  if (SEEN.has(key)) return true; // 同会话只记一次事件
  SEEN.add(key);
  RING.push({ id: nextId++, key, host, session, user, by: String(input.by ?? ""), at: Date.now() });
  if (RING.length > 200) {
    const gone = RING.shift()!;
    SEEN.delete(gone.key);
  }
  return true;
}

/**
 * 游标拉取。响应恒带 latest：客户端处理完直接把游标对齐到 latest——
 * 服务端重启后 nextId 归 1，客户端旧游标 > latest 会命中 stale 分支重放整环
 * （已开着的窗由前端按 key 去重挡住，不会连爆）。
 */
export function observeSince(id: number): { events: ObserveEvent[]; latest: number } {
  if (!Number.isFinite(id) || id < 0) id = 0;
  const stale = id >= nextId; // 客户端游标比我的计数器还大 = 服务端换过纪元
  const list = stale ? RING.slice(-50) : RING.filter((e) => e.id > id).slice(0, 50);
  return { events: list, latest: nextId - 1 };
}

export function clearObserve(): void {
  RING.length = 0;
  SEEN.clear();
}
