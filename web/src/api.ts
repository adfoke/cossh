// 同源相对路径：vite dev 已把 /api 与 /ws 代理到 127.0.0.1:8787
export const ptySocketUrl = (cols: number, rows: number): string => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // dev（vite:5173）直连 server:8787：ws 无 CORS，绕开 vite 代理——
  // 它会在页面消失后把上游连接留成半开僵尸，服务端收不到 close、PTY 记录清不掉。
  const host = location.hostname === "localhost" ? "127.0.0.1" : location.hostname;
  const port = location.port === "5173" ? "8787" : location.port;
  return `${proto}//${host}:${port}/ws/pty?cols=${cols}&rows=${rows}`;
};

import type { StatusView } from "./types";

/** 状态卡轮询：一切失败（含 HTTP 层）都归一为 ok:false+err，卡片侧永不抛 */
export const fetchStatus = (host: string, fresh = false): Promise<StatusView> =>
  fetch(`/api/status?host=${encodeURIComponent(host)}${fresh ? "&fresh=1" : ""}`)
    .then(async (r) => {
      const j = (await r.json().catch(() => null)) as unknown;
      if (j && typeof j === "object" && "ok" in j) return j as StatusView;
      return { ok: false, host, at: Date.now(), err: `HTTP ${r.status}` } satisfies StatusView;
    })
    .catch((e: Error) => ({ ok: false, host, at: Date.now(), err: e?.message ?? String(e) }) satisfies StatusView);

export interface Health {
  ok: boolean;
  ptys: number;
}

export const health = (): Promise<Health> =>
  fetch("/api/health")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch(() => ({ ok: false, ptys: 0 }));
