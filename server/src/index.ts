// sshx 本地服务：HTTP 健康检查 + WebSocket 真 PTY（node-pty）
// 只绑定 127.0.0.1：每个终端窗就是这台机器上的一个真实 shell，绝不对外网暴露。
import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { attachPty, beatStale, killAllPtys, liveCount } from "./pty.ts";
import { getStatus, isValidStatusHost } from "./status.ts";

const PORT = Number(process.env.SSHX_PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "64kb" }));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ptys: liveCount() });
});

/* ── 服务器状态卡：单次 ssh 采集脚本 → 指标 JSON（缓存+连接复用，详见 status.ts 头注） ── */
app.get("/api/status", async (req, res) => {
  const host = String(req.query.host ?? "").trim();
  // 它会被拼进 ssh argv——不过白名单直接 400，绝不把脏字符串递给子进程
  if (!isValidStatusHost(host)) {
    res.status(400).json({ ok: false, host, at: Date.now(), err: "invalid host" });
    return;
  }
  const data = await getStatus(host, { fresh: req.query.fresh === "1" });
  res.json(data);
});

/* 生产单端口模式：web 侧 npm run build 产出 web/dist 后，本服务直接托管静态资源——
   一个进程 = 页面 + API + WS，开 http://127.0.0.1:PORT 即用（前端 ws 同源自动跟随）。 */
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
const hasDist = existsSync(path.join(distDir, "index.html"));
if (hasDist) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/ws")) {
      res.sendFile(path.join(distDir, "index.html"));
    } else next();
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/pty" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  (ws as { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => ((ws as { isAlive?: boolean }).isAlive = true));
  attachPty(ws, url.searchParams);
});

// 双保险清扫：TCP ping 两拍无 pong，或应用层 hb 断流 15s（页面已死但网络进程还在应答）→ terminate
const sweep = setInterval(() => {
  for (const c of wss.clients) {
    if ((c as { isAlive?: boolean }).isAlive === false || beatStale(c, 15_000)) {
      c.terminate();
      continue;
    }
    (c as { isAlive?: boolean }).isAlive = false;
    c.ping();
  }
}, 5_000);
wss.on("close", () => clearInterval(sweep));

// 进程退出时收割所有 shell，不留孤儿进程
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killAllPtys();
    process.exit(0);
  });
}
process.on("exit", killAllPtys);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sshx] pty server → http://127.0.0.1:${PORT} (local only)`);
  if (hasDist) console.log(`[sshx] 生产模式：已托管 web/dist（同源 = 页面+API+WS 一个端口）`);
  else console.log(`[sshx] 提示：未找到 web/dist —— 先 npm run build 或直接 npm run dev（双端口热更新）`);
});
