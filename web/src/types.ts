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
