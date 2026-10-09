// ＋状态卡弹窗：只要一个 ssh 目标（[user@]host）。前提走系统 ssh——
// 免密、跳板、ProxyCommand 隧道全部透明复用：这里不养第二套凭据。
import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { useUI } from "../uiStore";
import { Overlay } from "./Overlay";

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--background-tertiary)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--focus)]";
const LS_RECENT = "sshx.statusHosts";

function recentHosts(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_RECENT) ?? "[]") as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function AddStatusOverlay({ onCreate }: { onCreate: (host: string, title: string) => void }) {
  const overlay = useUI((s) => s.overlay);
  const close = useUI((s) => s.close);
  const [host, setHost] = useState("");
  const [title, setTitle] = useState("");
  const recents = useMemo(recentHosts, []);

  if (overlay !== "status") return null;

  const submit = () => {
    const h = host.trim();
    if (!h) return;
    try {
      const list = [h, ...recentHosts().filter((x) => x !== h)].slice(0, 8);
      localStorage.setItem(LS_RECENT, JSON.stringify(list));
    } catch {
      /* 存储满就丢历史，别拦创建 */
    }
    onCreate(h, title.trim() || h);
    close();
  };

  return (
    <Overlay title="📈 新建状态卡" onClose={close} width={440}>
      <div className="space-y-3 text-sm" data-status-form>
        <div>
          <label className="mb-1 block text-xs font-semibold text-[var(--muted)]" htmlFor="status-host">
            目标机器（[user@]host，跟 ~/.ssh/config 走）
          </label>
          <input
            id="status-host"
            data-status-host-input
            autoFocus
            className={inputCls}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="ops@example.com"
          />
        </div>
        {recents.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {recents.map((h) => (
              <button
                key={h}
                className="rounded-full border border-[var(--border)] bg-[var(--background-tertiary)] px-2 py-0.5 font-mono text-[11px] text-[var(--muted)] transition hover:border-[var(--focus)] hover:text-[var(--foreground)]"
                onClick={() => setHost(h)}
              >
                {h}
              </button>
            ))}
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs font-semibold text-[var(--muted)]" htmlFor="status-title">
            卡片标题（留空 = 用 host）
          </label>
          <input
            id="status-title"
            data-status-title-input
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：build-01"
          />
        </div>
        <p className="text-xs leading-5 text-[var(--muted)]">
          每 5s 一次 <code className="font-mono">ssh</code> 采集（CPU/内存/磁盘/网络速率/top 进程/docker）。
          连接自动复用不轰炸；前提是本机 <code className="font-mono">ssh {host.trim() || "<host>"}</code> 能免密直达。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onPress={close}>
            取消
          </Button>
          <Button size="sm" variant="primary" isDisabled={!host.trim()} onPress={submit} data-status-create>
            创建
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
