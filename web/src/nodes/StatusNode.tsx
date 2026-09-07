// 状态监控卡（借鉴 ternssh 的 StatusWidget，但它是 Cloudflare 边缘轮询，我们只做「一次 ssh 跑采集脚本」）：
// 每个节点 = 一台机器的健康快照，5s 轮询 /api/status；服务端有 2s 缓存 + ControlMaster，
// 所以同主机的多张卡、连开多台都不会把目标机打出连接风暴。
import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { fetchStatus } from "../api";
import { MinimizedBody, useWindow, WindowButtons } from "../lib/window";
import type { StatusNodeData, StatusView, WindowState } from "../types";

type StatusFlowNode = Node<StatusNodeData, "status">;

const POLL_MS = 5_000;

const fmtGb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb / 1024 >= 10 ? 0 : 1)}G` : `${mb}M`);
const fmtKbGb = (kb: number) => fmtGb(Math.round(kb / 1024));
const fmtUptime = (sec?: number) => {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
};
const fmtRate = (kbps: number | null) => {
  if (kbps == null) return "—";
  if (kbps >= 1e6) return `${(kbps / 1e6).toFixed(1)}G`;
  if (kbps >= 1e3) return `${(kbps / 1e3).toFixed(1)}M`;
  if (kbps >= 10) return `${Math.round(kbps)}K`;
  return `${kbps.toFixed(1)}K`;
};

function barColor(pct: number) {
  return pct >= 85 ? "bg-rose-500" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500";
}

/** 用量条：label + 百分比 + 迷你进度条（ternssh MetricBar 的紧凑化） */
function Meter({ label, pct, right }: { label: string; pct: number | null; right: string }) {
  return (
    <div className="flex items-center gap-1.5" title={`${label} ${pct == null ? "" : `${pct}%`}`}>
      <span className="w-8 shrink-0 text-[var(--muted)]">{label}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--background-tertiary)]">
        {pct != null && (
          <span className={`block h-full rounded-full ${barColor(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} />
        )}
      </span>
      <span className="w-16 shrink-0 text-right tabular-nums">{pct == null ? "—" : `${pct}%`}</span>
      <span className="w-20 shrink-0 truncate text-right text-[var(--muted)]">{right}</span>
    </div>
  );
}

export function StatusNode({ id, data, selected }: NodeProps<StatusFlowNode>) {
  const [view, setView] = useState<StatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const { updateNodeData } = useReactFlow();
  const { patch: patchWin } = useWindow(id);
  const win = (data.win as WindowState | undefined) ?? "normal";
  const minimized = win === "min";
  const paused = !!data.paused;

  const pull = useCallback(async () => {
    if (busyRef.current) return; // 上一发 ssh 没回来就跳过这拍，绝不让轮询叠成串
    busyRef.current = true;
    setBusy(true);
    try {
      setView(await fetchStatus(data.host));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [data.host]);

  useEffect(() => {
    if (minimized || paused) return;
    void pull();
    const t = window.setInterval(() => void pull(), POLL_MS);
    return () => window.clearInterval(t);
  }, [pull, minimized, paused]);

  const ok = view?.ok === true;
  const stateLabel = paused ? "暂停" : busy ? "采集中" : ok ? "在线" : view ? "失联" : "连接中";
  const dot = paused || (!busy && !view) ? "bg-[var(--muted)]" : busy ? "bg-sky-400" : ok ? "bg-emerald-500" : "bg-rose-500";

  return (
    <div
      data-status-node={id}
      data-status-state={paused ? "paused" : busy ? "busy" : view ? (ok ? "ok" : "err") : "pending"}
      className={`flex w-[340px] flex-col overflow-hidden rounded-2xl border bg-[var(--surface)] font-mono text-[11px] shadow-xl ${
        minimized ? "h-auto" : ""
      } ${selected ? "border-[var(--focus)] ring-2 ring-[var(--focus)]/30" : "border-[var(--border)]"}`}
    >
      {/* 工具条=拖拽把手；按钮各自 nodrag（与 TermNode 同一套规则） */}
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5 text-xs">
        <span className="shrink-0">📈</span>
        <span
          className="truncate font-sans font-semibold"
          data-status-host={data.host}
          title={`${data.host} · 双击重命名 (F2)`}
        >
          {data.title}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-[var(--muted)]">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          {stateLabel}
        </span>
        <button
          aria-label={paused ? "resume-polling" : "pause-polling"}
          className="nodrag grid h-6 w-6 place-items-center rounded-md text-[var(--muted)] transition hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)]"
          title={paused ? "▶ 恢复轮询" : "⏸ 暂停轮询（定格当前数据）"}
          onClick={() => updateNodeData(id, { paused: !paused })}
        >
          {paused ? "▶" : "⏸"}
        </button>
        <WindowButtons id={id} data={data} />
      </div>

      {minimized && <MinimizedBody label={data.title} onOpen={() => patchWin("normal")} />}

      <div className={`flex flex-col gap-1.5 px-2.5 py-2 ${minimized ? "hidden" : ""}`}>
        {!view && !minimized && <div className="py-4 text-center text-[var(--muted)]">首采中（一次 ssh 往返）…</div>}
        {view && !view.ok && (
          <div className="rounded-lg bg-rose-500/15 px-2 py-1.5 text-rose-400" data-status-err>
            {view.err ?? "采集失败"}
          </div>
        )}
        {view?.ok && (
          <>
            <div className="flex items-center justify-between text-[10px] text-[var(--muted)]">
              <span className="truncate">
                {view.hostname ?? view.host} · {view.os ?? "?"} · {view.user ? `${view.user}@` : ""}
              </span>
              <span className="shrink-0 tabular-nums">up {fmtUptime(view.uptimeSec)}</span>
            </div>
            <Meter label="CPU" pct={view.cpuPct ?? null} right={`x${view.cpus ?? "?"} ${view.load?.[0] ?? "—"}`} />
            <Meter
              label="MEM"
              pct={view.memUsedPct ?? null}
              right={view.memTotalKb ? `${fmtKbGb(view.memTotalKb)} 总` : "—"}
            />
            {(view.disks ?? []).slice(0, 3).map((d) => (
              <Meter key={d.mount} label="DSK" pct={d.pct} right={`${d.mount.slice(0, 10)} ${fmtGb(d.totalMb)}`} />
            ))}
            {(view.nets ?? []).length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
                {view.nets!.slice(0, 4).map((n) => (
                  <span key={n.name} className="tabular-nums" title={`${n.name} 收发`}>
                    <b className="font-semibold text-[var(--foreground)]">{n.name}</b>{" "}
                    <span className="text-sky-400">↓{fmtRate(n.rxRateKbps)}</span>{" "}
                    <span className="text-violet-400">↑{fmtRate(n.txRateKbps)}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between pt-0.5 text-[10px] text-[var(--muted)]">
              <span>TOP 进程</span>
              {view.docker && <span>docker {view.docker.running}/{view.docker.total}</span>}
            </div>
            {(view.procs ?? []).slice(0, 5).map((p) => (
              <div key={p.pid} className="flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap" title={p.command}>
                <span className="w-8 shrink-0 text-right tabular-nums text-[var(--muted)]">{p.cpuPct}%</span>
                <span className="w-8 shrink-0 text-right tabular-nums text-[var(--muted)]">{p.memPct}%</span>
                <span className="truncate text-[var(--foreground)]">{p.command || p.user}</span>
              </div>
            ))}
            <div className="pt-1 text-right text-[10px] text-[var(--muted)] tabular-nums">
              {new Date(view.at).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );

}
