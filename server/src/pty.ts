// 真 PTY 终端：每条 WS 连接 spawn 一个本机 shell（node-pty），双向裸字节转发。
// 协议：
//   客户端 → 服务端：binary 帧 = 键盘输入；text 帧 = JSON 控制（resize）
//   服务端 → 客户端：binary 帧 = PTY 输出；text 帧 = JSON 状态（exit/error）
// 安全前提：整个服务只绑 127.0.0.1，PTY 即本人本机 shell，不对外暴露。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";

// ssh PATH shim 目录：前置进每个 PTY 的 PATH，捕获「codex 在驱动远端 tmux」的信号
const SHIM_DIR = fileURLToPath(new URL("../shims", import.meta.url));
try {
  fs.chmodSync(SHIM_DIR + "/ssh", 0o755); // 防 npm 沙箱剥执行位（spawn-helper 同坑）
} catch {
  /* 文件缺失则放弃注入，不炸服务 */
}

const LIVE = new Map<number, IPty>(); // pid → 进程（服务端退出时统一收割）

export type Beatable = WebSocket & { __lastBeat?: number };
export const markBeat = (ws: WebSocket): void => {
  (ws as Beatable).__lastBeat = Date.now();
};
export const beatStale = (ws: WebSocket, ms: number): boolean => {
  const t = (ws as Beatable).__lastBeat;
  return t === undefined || Date.now() - t > ms;
};

export function liveCount(): number {
  return LIVE.size;
}

const clamp = (n: number, lo: number, hi: number, dft: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dft;

/** 供 index.ts 的 process 退出钩子调用：杀掉所有还活着的 shell */
export function killAllPtys(): void {
  for (const p of LIVE.values()) {
    try {
      p.kill();
    } catch {
      /* 已退出 */
    }
  }
  LIVE.clear();
}

export function attachPty(ws: WebSocket, search: URLSearchParams): void {
  const cols = clamp(Number(search.get("cols")), 20, 400, 80);
  const rows = clamp(Number(search.get("rows")), 4, 200, 24);
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const sendText = (obj: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  let pty: IPty;
  try {
    pty = nodePty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME ?? process.cwd(),
      env: {
        ...process.env,
        TERM_PROGRAM: "sshx-canvas",
        PATH: `${SHIM_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        // macOS 的 /etc/zprofile path_helper 会在登录 shell 里把 PATH 重排回系统序，
        // 光前置等于白做——用 ZDOTDIR 引导壳转源用户真实 rc 后，最后一步把 shim 顶回最前
        ZDOTDIR: `${SHIM_DIR}/zdot`,
        SSHX_REAL_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || "~",
        SSHX_SHIM_DIR: SHIM_DIR,
        SSHX_CONTROL_URL: `http://127.0.0.1:${process.env.SSHX_PORT ?? 8787}`,
        // 观察窗自己带抑制标记：它的 attach 命令再进 shim 就是回声环
        ...(search.get("noobserve") ? { SSHX_NO_OBSERVE: "1" } : {}),
      } as Record<string, string>,
    });
  } catch (e) {
    sendText({ type: "error", message: `PTY 启动失败：${(e as Error).message}` });
    ws.close();
    return;
  }
  LIVE.set(pty.pid, pty);
  // 应用层心跳时间戳：TCP 层 ping/pong 挡不住「页面已死但网络进程仍在应答」的半开连接，
  // 只有活着的文档才会持续发 hb；超时即 terminate → dispose 收割 PTY
  markBeat(ws);
  sendText({ type: "hello", pid: pty.pid, shell });

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, "utf8")); // binary 帧直推
  });
  pty.onExit(({ exitCode, signal }) => {
    LIVE.delete(pty.pid);
    sendText({ type: "exit", exitCode, signal });
    ws.close();
  });

  ws.on("message", (buf: Buffer, isBinary: boolean) => {
    if (isBinary) {
      pty.write(buf.toString("utf8")); // xterm onData 是文本；转成 stdin 喂给 PTY
      return;
    }
    try {
      const msg = JSON.parse(String(buf)) as { type: string; cols?: number; rows?: number };
      if (msg.type === "hb") {
        markBeat(ws);
        return;
      }
      if (msg.type === "resize") {
        pty.resize(clamp(Number(msg.cols), 20, 400, pty.cols), clamp(Number(msg.rows), 4, 200, pty.rows));
      }
    } catch {
      /* 忽略坏帧 */
    }
  });

  const dispose = () => {
    LIVE.delete(pty.pid);
    try {
      pty.kill();
    } catch {
      /* 已退出 */
    }
  };
  ws.on("close", dispose);
  ws.on("error", dispose);
}
