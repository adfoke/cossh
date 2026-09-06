// sshx 本地服务：HTTP 健康检查 + WebSocket 真 PTY（node-pty）
// 只绑定 127.0.0.1：每个终端窗就是这台机器上的一个真实 shell，绝不对外网暴露。
import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { attachPty, beatStale, killAllPtys, liveCount } from "./pty.ts";
import { fetchCodexModels, readCodexConfig, saveCodexConfig, type CodexConfigInput } from "./codexConfig.ts";
import { clearObserve, observeSince, reportObserve } from "./observe.ts";
import { agentsRuleState, writeAgentsRule } from "./codexAgents.ts";

const PORT = Number(process.env.SSHX_PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "64kb" }));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ptys: liveCount() });
});

/* Codex CLI 配置面：GET 永远脱敏（只有 hasKey），POST 合并写 config.toml/.env；
   /api/codex/models = 服务端代理拉模型列表（避开 CORS，key 只进不出） */
app.post("/api/codex/models", async (req, res) => {
  const { baseUrl, apiKey } = req.body as { baseUrl?: string; apiKey?: string };
  const r = await fetchCodexModels(String(baseUrl ?? ""), String(apiKey ?? ""));
  if ("error" in r) return res.status(502).json({ error: r.error });
  res.json(r);
});
app.get("/api/codex/config", (_req, res) => {
  res.json(readCodexConfig());
});
app.post("/api/codex/config", (req, res) => {
  const r = saveCodexConfig(req.body as CodexConfigInput);
  if ("error" in r) return res.status(400).json({ error: r.error });
  res.json(r);
});

/* codex 全局规矩：幂等标记块写入 ~/.codex/AGENTS.md（远端 tmux 共享工位协议） */
app.get("/api/codex/agents", (_req, res) => res.json(agentsRuleState()));
app.post("/api/codex/agents", (_req, res) => {
  const r = writeAgentsRule();
  if ("error" in r) return res.status(500).json({ error: r.error });
  res.json({ ok: true, ...r });
});

/* 观察事件面：ssh shim POST 上报；画布 GET since 游标拉新 */
app.post("/api/observe", (req, res) => {
  const accepted = reportObserve(req.body as { host?: string; session?: string; by?: string });
  res.json({ ok: accepted });
});
app.get("/api/observe/since", (req, res) => {
  res.json(observeSince(Number(req.query.id ?? 0)));
});
app.post("/api/observe/clear", (_req, res) => {
  clearObserve();
  res.json({ ok: true });
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
