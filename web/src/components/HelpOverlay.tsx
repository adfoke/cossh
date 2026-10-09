import { Kbd } from "@heroui/react";
import { useUI } from "../uiStore";
import { Overlay } from "./Overlay";

function Key({ children }: { children: React.ReactNode }) {
  return <Kbd variant="light">{children}</Kbd>;
}

export function HelpOverlay() {
  const { overlay, close } = useUI();
  if (overlay !== "help") return null;
  return (
    <Overlay title="怎么用" onClose={close} width={560}>
      <div className="space-y-3 text-sm leading-6">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--background-tertiary)] p-3">
          <b>① ＋终端，想要几个开几个</b>
          <p className="mt-1 text-[var(--muted)]">
            每个窗口都是这台机器上的一个<b>真 PTY shell</b>（xterm.js ↔ WebSocket ↔ node-pty），
            字节级双向管道——vim / htop / ssh / less 这类全屏程序都能直接跑。
            标题栏上的 ⌗ 数字就是它的进程 pid。
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--background-tertiary)] p-3">
          <b>② 摆到画布上顺手的位置</b>
          <p className="mt-1 text-[var(--muted)]">
            拖标题栏移动窗口，滚轮缩放画布、拖空白处平移。多机器作业建议一台机器一个窗口，排一排同屏看。
            <br />
            <b>📈 状态卡</b>：填 [user@]host，每 5s 一次 ssh 采集 CPU/内存/磁盘/网络速率/top 进程/docker；
            同主机多卡共享连接（ControlMaster 复用，不会轰炸目标机），⏸ 可定格排查。
            前提是本机 <code>ssh host</code> 免密直达——跳板 / ProxyCommand 隧道走系统 ~/.ssh/config，全透明。
            <br />
            <b>⚡ 快捷命令</b>：存常用命令；执行 = 塞进你<b>最后敲过字</b>的那个活终端，一扇活的都没有就自动开新窗跑。
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--background-tertiary)] p-3">
          <b>③ 窗口的三种状态</b>
          <p className="mt-1 text-[var(--muted)]">
            <Key>—</Key> 最小化：只收起画面，shell 进程和滚动缓冲都还活着；
            <Key>□</Key> 最大化：给全屏程序一个大画布；
            <Key>✕</Key> 关闭：进程退出——但窗位记在历史里，<Key>⌘Z</Key> 还能把窗口捞回来（进程得重开）。
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--background-tertiary)] p-3">
          <b>④ 持久化说明</b>
          <p className="mt-1 text-[var(--muted)]">
            窗口的布局、标题、窗口状态随画布存进 localStorage，刷新后自动原位重开 shell；
            正在跑的进程跨不过刷新（关掉页面即断开）。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-[var(--border)] bg-[var(--background-tertiary)] px-3 py-2 text-[11px] text-[var(--muted)]">
          <span className="flex items-center gap-1"><Key>Del</Key> 删窗口</span>
          <span className="flex items-center gap-1"><Key>⌘Z</Key> 撤销</span>
          <span className="flex items-center gap-1"><Key>⇧⌘Z</Key>/<Key>Ctrl+Y</Key> 重做</span>
          <span className="flex items-center gap-1"><Key>双击标题栏</Key>/<Key>F2</Key> 重命名</span>
          <span className="flex items-center gap-1"><Key>标题栏</Key> 拖动窗口 ·{" "}
            <Key>—</Key>/<Key>□</Key>/<Key>✕</Key> 最小化 / 最大化 / 关闭（最小化不丢终端进程，关错了{" "}
            <Key>⌘Z</Key> 找回）</span>
          <span className="flex items-center gap-1"><Key>⌘K</Key> 快捷命令面板（存/搜/一键注入）</span>
          <span className="flex items-center gap-1"><Key>?</Key> 本页</span>
          <span className="flex items-center gap-1"><Key>Esc</Key> 关闭弹层</span>
          <span>拖拽平移 · 滚轮缩放</span>
          <span className="flex items-center gap-1"><Key>⌗ Auto</Key> 右下角一键网格整理全部窗（<Key>⌘Z</Key> 退回整理前）</span>
        </div>
      </div>
    </Overlay>
  );
}
