// Codex CLI 配置读写：合并式更新 ~/.codex/config.toml（自定义 provider）+ ~/.codex/.env（密钥）
// 铁律：① 用户已有的其它配置键必须原样保留；② API key 只进 .env（0600），任何读取接口不回显。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const ENV_PATH = path.join(CODEX_DIR, ".env");

export const PROVIDER_ID = "sshx";
const KEY_ENV = "OPENAI_API_KEY";

export interface CodexConfigView {
  configured: boolean;
  baseUrl: string;
  model: string;
  modelProvider: string;
  wireApi: string;
  hasKey: boolean;
  keyEnvName: string;
  configPath: string;
  envPath: string;
}

export interface CodexConfigInput {
  baseUrl: string;
  apiKey?: string; // 空/缺省 = 保持已存的 key 不动
  model?: string;
  wireApi?: string;
}

type Table = Record<string, unknown>;

function readToml(): Table {
  try {
    return parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Table;
  } catch {
    return {}; // 只读视图：不存在/坏了都当空配置展示（写入路径另有备份保护）
  }
}

/** 写入前用这个：解析失败说明现文件是坏的 → 先备份原文件再基于空表重建，绝不静默覆盖 */
function readTomlSafe(): Table {
  try {
    return parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Table;
  } catch (e) {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak-" + Date.now());
    }
    return {};
  }
}

/** dotenv 风格逐行解析（只认 KEY=VALUE，忽略注释/空行；值里不含换行） */
function readEnvFile(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out.set(m[1], m[2]);
    }
  } catch {
    /* 没有文件 */
  }
  return out;
}

function writeEnvFile(env: Map<string, string>): void {
  const body = [...env.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const tmp = ENV_PATH + ".tmp";
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
  fs.chmodSync(ENV_PATH, 0o600);
}

export function readCodexConfig(): CodexConfigView {
  const cfg = readToml();
  const mps = cfg["model_providers"] as Record<string, Table> | undefined;
  const p = mps?.[PROVIDER_ID];
  const env = readEnvFile();
  return {
    configured: !!p,
    baseUrl: String(p?.["base_url"] ?? ""),
    model: String(cfg.model ?? ""),
    modelProvider: String(cfg.model_provider ?? ""),
    wireApi: String(p?.["wire_api"] ?? "responses"),
    hasKey: env.has(KEY_ENV) || !!process.env[KEY_ENV],
    keyEnvName: KEY_ENV,
    configPath: CONFIG_PATH,
    envPath: ENV_PATH,
  };
}

export function saveCodexConfig(input: CodexConfigInput): CodexConfigView | { error: string } {
  const baseUrl = (input.baseUrl ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) return { error: "API 地址需要是 http(s):// 开头的完整 URL" };
  const wireApi = input.wireApi === "chat" ? "chat" : input.wireApi === "responses" ? "responses" : "";
  if (!wireApi) return { error: "wire_api 只能是 responses 或 chat" };
  const model = (input.model ?? "").trim();
  if (model && /\s/.test(model)) return { error: "模型名不能含空格" };
  const apiKey = (input.apiKey ?? "").trim();
  if (apiKey && /[\s\r\n]/.test(apiKey)) return { error: "API key 不能含空白字符" };

  fs.mkdirSync(CODEX_DIR, { recursive: true, mode: 0o700 });

  // ── config.toml：只动 model / model_provider / [model_providers.sshx] 三处，其余原样保留 ──
  const cfg = readTomlSafe();
  if (model) cfg.model = model;
  cfg.model_provider = PROVIDER_ID;
  const mps = ((cfg["model_providers"] as Record<string, Table> | undefined) ??= {});
  mps[PROVIDER_ID] = {
    ...(mps[PROVIDER_ID] ?? {}), // 保留用户可能手加的 extra_headers 等
    name: "Configured by SSHX canvas",
    base_url: baseUrl,
    env_key: KEY_ENV,
    wire_api: wireApi,
  };
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, stringify(cfg), { mode: 0o644 });
  fs.renameSync(tmp, CONFIG_PATH);

  // ── .env：仅在填了新 key 时覆盖 OPENAI_API_KEY，其它变量原样保留；留空 = 不动 ──
  if (apiKey) {
    const env = readEnvFile();
    env.set(KEY_ENV, apiKey);
    writeEnvFile(env);
  }
  return readCodexConfig();
}

/* ── 模型列表：POST /api/codex/models 的后端。走 curl 子进程（对境外直连常失败的环境，
   服务端进程配 SSHX_PROXY（或标准 https_proxy）则直连不通自动退该代理）；
   Authorization 经 curl 配置文件从 stdin 喂入，
   key 不落 argv（ps 看不见）。base_url 支持带/不带 /v1 双候选探测。 ── */

interface CurlResult {
  ok: boolean;
  status?: number; // HTTP 错误码（--fail-with-body 下 curl exit 22）
  body?: unknown;
  err?: string; // 传输层失败（拒绝连接/超时…）
}

function curlModels(url: string, apiKey: string, proxy: string | null, timeoutS: number): Promise<CurlResult> {
  return new Promise((resolve) => {
    const child = spawn("curl", ["-sS", "--fail-with-body", "--max-time", String(timeoutS), "-K", "-", url], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 配置文件里的字符串值转义双引号/反斜杠即可（key 已在入口校验无空白）
    const cfg = `header = "Authorization: Bearer ${apiKey.replace(/["\\]/g, "")}"\n` + (proxy ? `proxy = "${proxy}"\n` : "");
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => resolve({ ok: false, err: e.message }));
    child.on("close", (code) => {
      if (code === 0) {
        try {
          resolve({ ok: true, body: JSON.parse(out) });
        } catch {
          resolve({ ok: false, err: "响应不是 JSON" });
        }
        return;
      }
      const m = err.match(/returned error: (\d{3})/);
      if (m) {
        let body: unknown;
        try {
          body = JSON.parse(out);
        } catch {
          /* keep undefined */
        }
        resolve({ ok: false, status: Number(m[1]), body });
        return;
      }
      resolve({ ok: false, err: err.trim() || `curl exit ${code}` });
    });
    child.stdin.write(cfg);
    child.stdin.end();
  });
}

/** 把 OpenAI/Anthropic/中转网关的五花八门返回归一成 id 列表 */
function extractModelIds(body: unknown): string[] {
  const b = body as Record<string, unknown>;
  const arr = (Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : Array.isArray(b) ? b : []) as unknown[];
  const ids = arr
    .map((m) => {
      if (typeof m === "string") return m;
      const o = m as Record<string, unknown>;
      return String(o?.id ?? o?.name ?? o?.model ?? "");
    })
    .filter((x) => x.length > 0);
  return [...new Set(ids)];
}

export async function fetchCodexModels(
  baseUrl: string,
  apiKeyProvided?: string,
): Promise<{ models: string[] } | { error: string }> {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return { error: "先填有效的 API 地址" };
  const key = (apiKeyProvided ?? "").trim() || readEnvFile().get(KEY_ENV) || process.env[KEY_ENV] || "";
  if (!key) return { error: "还没有 API key（表单里填一个，或先保存过一次）" };

  const candidates = /\/v1$/i.test(base) ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
  let lastErr = "";
  // 代理兜底完全由服务端环境决定：没配就只试直连，绝不猜某个端口
  const proxyFallback = process.env.SSHX_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY || null;
  for (const url of candidates) {
    let r = await curlModels(url, key, null, 8);
    if (!r.ok && r.err && proxyFallback) r = await curlModels(url, key, proxyFallback, 12); // 直连不通退配置代理
    if (r.ok) {
      const models = extractModelIds(r.body);
      if (models.length === 0) return { error: "接口返回了空模型列表" };
      return { models };
    }
    if (r.status === 401 || r.status === 403) return { error: `Key 无效（HTTP ${r.status}）` };
    lastErr = r.status ? `HTTP ${r.status}` : (r.err ?? "未知错误");
  }
  return { error: proxyFallback
    ? `拉取失败：${lastErr}（直连与 ${proxyFallback} 代理都试过）`
    : `拉取失败：${lastErr}（直连失败；如本机需代理访问模型 API，给 server 进程设 SSHX_PROXY=http://127.0.0.1:<port> 后重试）` };
}
