// 同源相对路径：vite dev 已把 /api 与 /ws 代理到 127.0.0.1:8787
export const ptySocketUrl = (cols: number, rows: number, noObserve = false): string => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // dev（vite:5173）直连 server:8787：ws 无 CORS，绕开 vite 代理——
  // 它会在页面消失后把上游连接留成半开僵尸，服务端收不到 close、PTY 记录清不掉。
  const host = location.hostname === "localhost" ? "127.0.0.1" : location.hostname;
  const port = location.port === "5173" ? "8787" : location.port;
  return `${proto}//${host}:${port}/ws/pty?cols=${cols}&rows=${rows}${noObserve ? "&noobserve=1" : ""}`;
};

export interface Health {
  ok: boolean;
  ptys: number;
}

export const health = (): Promise<Health> =>
  fetch("/api/health")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch(() => ({ ok: false, ptys: 0 }));

/* ── Codex CLI 配置面（服务端合并写 ~/.codex，key 只进不出） ── */
export interface CodexConfigView {
  configured: boolean;
  baseUrl: string;
  model: string;
  modelProvider: string;
  wireApi: string;
  reasoningEffort: string;
  modelCatalog: boolean;
  hasKey: boolean;
  keyEnvName: string;
  configPath: string;
  envPath: string;
}

export const getCodexConfig = (): Promise<CodexConfigView> =>
  fetch("/api/codex/config").then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

export const saveCodexConfig = (body: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  wireApi: string;
  reasoningEffort?: string;
  useModelCatalog?: boolean;
  modelIds?: string[];
}): Promise<CodexConfigView> =>
  fetch("/api/codex/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as CodexConfigView;
  });

/** 服务端代理拉取模型列表：表单 key 留空时后端自动用已保存的 key */
export const fetchCodexModels = (body: { baseUrl: string; apiKey?: string }): Promise<{ models: string[] }> =>
  fetch("/api/codex/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as { models: string[] };
  });

export interface ObserveEvent {
  id: number;
  key: string;
  host: string;
  session: string;
  user: string;
  by: string;
  at: number;
}

/** 游标式拉取观察事件（ssh shim 上报「远端 tmux 正被驱动」) */
export const observeSince = (id: number): Promise<{ events: ObserveEvent[]; latest: number }> =>
  fetch(`/api/observe/since?id=${id}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch(() => ({ events: [] as ObserveEvent[], latest: id }));

/** 幂等写入 codex 全局规矩（~/.codex/AGENTS.md 标记块），返回落点路径 */
export const writeCodexAgents = (): Promise<{ ok: boolean; path: string; created: boolean }> =>
  fetch("/api/codex/agents", { method: "POST" }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j;
  });
