import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { fetchCodexModels, getCodexConfig, saveCodexConfig } from "../api";
import { useUI } from "../uiStore";
import { Overlay } from "./Overlay";

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--background-tertiary)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--focus)]";
const labelCls = "mb-1 block text-xs font-semibold text-[var(--muted)]";

/**
 * Codex CLI 配置窗：写 ~/.codex/config.toml 的自定义 provider + ~/.codex/.env 的 key。
 * key 只写不回显——输入框永远 placeholder「已保存」，留空 = 保持不动。
 */
export function CodexConfigOverlay() {
  const { overlay, close } = useUI();
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [wireApi, setWireApi] = useState("responses");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [paths, setPaths] = useState({ config: "", env: "" });
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsErr, setModelsErr] = useState("");
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (overlay !== "codex") return;
    setMsg(null);
    setModels(null);
    setModelsErr("");
    void getCodexConfig().then((c) => {
      setBaseUrl(c.baseUrl);
      setModel(c.model);
      setWireApi(c.wireApi || "responses");
      setHasKey(c.hasKey);
      setConfigured(c.configured);
      setPaths({ config: c.configPath, env: c.envPath });
      setApiKey("");
    });
  }, [overlay]);

  if (overlay !== "codex") return null;

  const doFetch = async () => {
    setFetching(true);
    setModels(null);
    setModelsErr("");
    try {
      const r = await fetchCodexModels({ baseUrl, apiKey });
      setModels(r.models);
    } catch (e) {
      setModelsErr((e as Error).message);
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await saveCodexConfig({ baseUrl, apiKey, model, wireApi });
      setHasKey(r.hasKey);
      setConfigured(r.configured);
      setApiKey("");
      setMsg({ kind: "ok", text: "已写入 ~/.codex（下次启动 codex 即生效）" });
      setTimeout(close, 900);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay title="配置 Codex API" onClose={close} width={520}>
      <div className="space-y-3 text-sm">
        <p className="text-xs leading-5 text-[var(--muted)]">
          {configured ? "已配置过，保存将合并更新（其余配置键原样保留）。" : "首次配置：写入自定义 provider。"}
          目标文件：{paths.config} 与 {paths.env}
        </p>
        <div>
          <label className={labelCls} htmlFor="codex-base-url">
            API 地址（base_url，OpenAI 兼容端点，含 /v1）
          </label>
          <input
            id="codex-base-url"
            className={inputCls}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="codex-api-key">
            API Key{hasKey ? "（已保存，留空保持不变）" : ""}
          </label>
          <input
            id="codex-api-key"
            type="password"
            autoComplete="off"
            className={inputCls}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? "••••••••  留空 = 不修改" : "sk-…"}
          />
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className={labelCls} htmlFor="codex-model">
              模型（可选）
            </label>
            <input
              id="codex-model"
              className={inputCls}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-5-codex"
            />
          </div>
          <Button
            id="codex-fetch-models"
            size="sm"
            variant="secondary"
            isDisabled={fetching || !baseUrl.trim()}
            onPress={() => void doFetch()}
          >
            {fetching ? "拉取中…" : "↓ 获取"}
          </Button>
          <div className="w-40">
            <label className={labelCls} htmlFor="codex-wire-api">
              协议
            </label>
            <select id="codex-wire-api" className={inputCls} value={wireApi} onChange={(e) => setWireApi(e.target.value)}>
              <option value="responses">responses</option>
              <option value="chat">chat</option>
            </select>
          </div>
        </div>
        {models && (
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-auto rounded-lg border border-[var(--border)] p-2">
            {models.map((m) => (
              <button
                key={m}
                type="button"
                data-model-chip={m}
                onClick={() => {
                  setModel(m);
                  setMsg({ kind: "ok", text: `已选模型 ${m}，记得保存` });
                }}
                className={`rounded-md border px-2 py-0.5 text-xs transition ${
                  m === model
                    ? "border-[var(--focus)] bg-[var(--focus)]/15 text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--background-tertiary)]"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        {modelsErr && <div className="text-xs text-rose-500" data-test="models-err">{modelsErr}</div>}
        {msg && (
          <div className={`text-xs ${msg.kind === "ok" ? "text-emerald-500" : "text-rose-500"}`}>{msg.text}</div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onPress={close}>
            取消
          </Button>
          <Button variant="primary" isDisabled={saving || !baseUrl.trim()} onPress={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
