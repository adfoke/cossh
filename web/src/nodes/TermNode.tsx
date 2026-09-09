import { useEffect, useRef, useState } from "react";
import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ptySocketUrl } from "../api";
import { registerTerm, touchTerm } from "../termBus";
import { MinimizedBody, useWindow, WindowButtons } from "../lib/window";
import type { TermNodeData, WindowState } from "../types";

type TermFlowNode = Node<TermNodeData, "term">;
type Link = "connecting" | "live" | "closed" | "error";

/**
 * 真 PTY 终端窗：xterm.js ↔ WebSocket ↔ node-pty（本机 shell）。
 * 与旧「观察窗」的本质区别：这里不是 tmux 快照镜像，而是字节级双向管道，
 * vim/htop/ssh 等全屏程序都能直接用。
 */
export function TermNode({ id, data, selected }: NodeProps<TermFlowNode>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runSentRef = useRef(false); // StrictMode 双挂载也只允许自举命令发一次
  const { updateNodeData } = useReactFlow();
  const [link, setLink] = useState<Link>("connecting");
  const [errMsg, setErrMsg] = useState("");
  const [pid, setPid] = useState<number | null>(null);
  // termBus 要的活标题：data 变了不重跑 effect，用 ref 保证注入面板拿到的标题是新鲜的
  const titleRef = useRef(data.title);
  titleRef.current = data.title;

  // 挂载即开一个 PTY；deps 故意为空——改标题/最小化/最大化都不能重连，
  // 否则敲一半的命令会被自己的 UI 操作掐死
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // 自举命令两来源：一次性 runOnOpen（发完即焚）/ 观察窗 attach（observeHost 在，每次就绪都跑，
    // 刷新后也要重新贴上去围观）
    const observeCmd =
      data.observeHost && data.observeSession
        ? `ssh -t ${data.observeUser ? data.observeUser + "@" : ""}${data.observeHost} tmux new -As ${data.observeSession}`
        : undefined;
    const runOnce = data.runOnOpen ?? observeCmd;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: "#0c0e13", foreground: "#d7dce4", cursor: "#7dd3fc" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    // 回归脚本读屏钩子：canvas 渲染下 DOM 无文本，从内部 buffer 取（对运行行为零影响）
    (el as unknown as { __xterm?: Terminal }).__xterm = term;

    const enc = new TextEncoder();
    let disposed = false;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(ptySocketUrl(term.cols, term.rows, !!data.observeHost));
      ws.binaryType = "arraybuffer";
    } catch {
      setLink("error");
      setErrMsg("WebSocket 创建失败");
    }

    // termBus 注册：快捷命令面板经它注入本窗；开窗即 touch（新窗 = 默认注入目标）
    const unregister = registerTerm(id, {
      title: () => titleRef.current,
      write: (t) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(t));
      },
      isLive: () => ws !== null && ws.readyState === WebSocket.OPEN,
    });
    touchTerm(id);

    if (ws) {
      ws.onopen = () => {
        if (disposed) return;
        setLink("live");
        term.focus();
        // 一次性自举命令（如「安装 Codex」）：等登录 shell 的 rc 跑完再喂，
        // 投递即销毁 node.data 里的字段——刷新/重开不会再跑第二遍
        if (runOnce && !runSentRef.current) {
          runSentRef.current = true;
          updateNodeData(id, { runOnOpen: undefined });
          window.setTimeout(() => {
            if (!disposed && ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(runOnce + "\r"));
          }, 400);
        }
      };
      ws.onclose = () => {
        if (!disposed) setLink((l) => (l === "live" || l === "connecting" ? "closed" : l));
      };
      ws.onerror = () => {
        if (disposed) return;
        setErrMsg("连不上本机 PTY 服务（server 起了吗？npm run dev）");
        setLink("error");
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as {
              type: string;
              pid?: number;
              message?: string;
              exitCode?: number | null;
            };
            if (msg.type === "hello") setPid(msg.pid ?? null);
            else if (msg.type === "error") {
              setErrMsg(msg.message ?? "PTY 异常");
              setLink("error");
            } else if (msg.type === "exit") {
              term.writeln(`\x1b[2m[shell 已退出 · code ${msg.exitCode ?? 0}]\x1b[0m`);
              setLink("closed");
            }
          } catch {
            /* 忽略坏帧 */
          }
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
        }
      };
    }

    // 键盘输入 → binary 帧 → PTY stdin（文本帧被协议保留给 JSON 控制）
    const inputDisp = term.onData((raw) => {
      touchTerm(id); // 敲了字 = 用户正在用它，注入顺位顶到第一
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(raw));
    });

    // 窗口尺寸 → resize 控制帧 → pty.resize（全屏程序的重绘靠它）
    let sizeTimer = 0;
    const scheduleSize = () => {
      try {
        fit.fit();
      } catch {
        /* 容器隐藏/销毁竞态 */
      }
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(() => {
        if (ws?.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }, 80);
    };
    // 应用层心跳：页面消失后 hb 断流，服务端 15s 内收割 PTY（防半开连接僵尸）
    const hbTimer = window.setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "hb" }));
    }, 5000);
    const ro = new ResizeObserver(scheduleSize);
    ro.observe(el);

    return () => {
      disposed = true;
      window.clearInterval(hbTimer);
      ro.disconnect();
      window.clearTimeout(sizeTimer);
      inputDisp.dispose();
      unregister();
      ws?.close();
      term.dispose();
    };
  }, []);

  const { patch: patchWin } = useWindow(id);
  const win = (data.win as WindowState | undefined) ?? "normal";
  const minimized = win === "min";

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl border bg-[var(--surface)] shadow-xl ${
        minimized ? "h-auto w-[760px]" : win === "max" ? "h-[680px] w-[1100px]" : "h-[420px] w-[760px]"
      } ${selected ? "border-[var(--focus)] ring-2 ring-[var(--focus)]/30" : "border-[var(--border)]"}`}
    >
      {/* 工具条本身是拖拽把手；控件与终端体各自 nodrag */}
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5 text-xs">
        <span className="text-sm">🖥️</span>
        <span className="mr-1 font-semibold">{data.title}</span>
        {pid !== null && (
          <span
            className="rounded-md bg-[var(--background-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]"
            title="本机 shell 进程 pid"
          >
            ⌗{pid}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--muted)]">
          <span
            className={`h-2 w-2 rounded-full ${
              link === "live"
                ? "bg-emerald-500"
                : link === "closed"
                  ? "bg-amber-500"
                  : link === "error"
                    ? "bg-rose-500"
                    : "bg-[var(--muted)]"
            }`}
          />
          {link === "live" ? "PTY" : link === "closed" ? "已退出" : link === "error" ? "失败" : "连接中"}
        </span>
        <WindowButtons id={id} data={data} />
      </div>

      {minimized && <MinimizedBody label={data.title} onOpen={() => patchWin("normal")} />}
      {/* 终端画面（最小化只隐藏不卸载：保住 ws、缓冲和正在跑的前台进程）
          nowheel：React Flow 见到它就把滚轮让给 xterm——鼠标在终端里 = 只滚终端，
          不再顺带缩放画布（双指滑动同时滚+缩放就是这个没挡） */}
      <div className={`nowheel relative min-h-0 flex-1 bg-[#0c0e13] ${minimized ? "hidden" : ""}`}>
        <div
          ref={containerRef}
          className="term-host nodrag"
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={() => touchTerm(id)}
        />
        {link === "error" && errMsg && (
          <div className="absolute right-2 bottom-2 left-2 rounded-lg bg-rose-500/15 px-2 py-1 text-[10px] text-rose-400">{errMsg}</div>
        )}
      </div>
    </div>
  );
}
