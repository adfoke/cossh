// 前端节点共享类型：改造后画布上只有一种节点——真 PTY 终端窗
export type WindowState = "normal" | "max" | "min";

export type TermNodeData = {
  title: string;
  /** 窗口状态：normal 默认 / max 最大化 / min 最小化（持久化在 node.data，随画布保存） */
  win?: WindowState;
  /** 一次性自举命令：终端就绪后自动输入执行，发完即从 data 抹除（刷新不重跑） */
  runOnOpen?: string;
  /** 观察窗标记：来自「远端 tmux 被驱动」事件；每次就绪自动 attach（与 runOnOpen 不同，跨刷新常驻），
   *  且其 PTY 带 SSHX_NO_OBSERVE 抑制，防止 attach 命令再触发上报形成回声环 */
  observeHost?: string;
  observeSession?: string;
  observeUser?: string;
}

/* ── 状态卡：/api/status 的视图镜像（字段与 server/src/status.ts 对齐） ── */
export interface StatusDisk { mount: string; totalMb: number; usedMb: number; pct: number }
export interface StatusNet { name: string; rxRateKbps: number | null; txRateKbps: number | null }
export interface StatusProc { pid: number; user: string; cpuPct: number; memPct: number; command: string }
export interface StatusView {
  ok: boolean;
  host: string;
  at: number;
  err?: string;
  os?: string;
  hostname?: string;
  user?: string;
  uptimeSec?: number;
  load?: number[];
  cpus?: number;
  cpuPct?: number | null;
  memTotalKb?: number;
  memUsedKb?: number;
  memUsedPct?: number | null;
  disks?: StatusDisk[];
  nets?: StatusNet[];
  procs?: StatusProc[];
  docker?: { running: number; total: number } | null;
}

export type StatusNodeData = {
  title: string;
  /** ssh 目标（[user@]host），状态卡每次轮询都拿它打 /api/status */
  host: string;
  win?: WindowState;
  /** 暂停轮询：卡片定格在最后一次成功数据（排查时不想被刷新打断） */
  paused?: boolean;
}
