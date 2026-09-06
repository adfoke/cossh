import { useCallback } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import { Tooltip } from "@heroui/react";
import type { WindowState } from "../types";

/**
 * 窗口操作按键（画布节点级）：最小化 / 最大化 / 关闭。
 * 状态写在 node.data 上，跟着画布一起持久化，最小化后仍可拖拽标题栏。
 */
export function useWindow(nodeId: string) {
  const rf = useReactFlow();
  const patch = useCallback(
    (win: WindowState) => rf.updateNodeData(nodeId, { win }),
    [rf, nodeId],
  );
  return {
    patch,
    minimize: (cur: WindowState) => patch(cur === "min" ? "normal" : "min"),
    maximize: (cur: WindowState) => patch(cur === "max" ? "normal" : "max"),
    close: () => rf.deleteElements({ nodes: [{ id: nodeId }] as Node[] }),
    bringFront: () => rf.setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId }))),
  };
}

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <Tooltip.Trigger>{children}</Tooltip.Trigger>
      <Tooltip.Content>
        <Tooltip.Arrow />
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}

const btn =
  "grid h-6 w-6 place-items-center rounded-md text-[var(--muted)] transition hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)]";

/** 最小化/最大化/关闭三颗按钮，放在节点标题栏右侧 */
export function WindowButtons({ id, data }: { id: string; data: { win?: WindowState } }) {
  const w = (data.win as WindowState | undefined) ?? "normal";
  const { minimize, maximize, close, bringFront } = useWindow(id);
  return (
    <div className="nodrag flex shrink-0 items-center gap-0.5" onDoubleClick={(e) => e.stopPropagation()}>
      <Tip label={w === "min" ? "还原" : "最小化"}>
        <button
          aria-label="minimize"
          className={btn}
          onClick={() => {
            bringFront();
            minimize(w);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M2 8.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </Tip>
      <Tip label={w === "max" ? "退出最大化" : "最大化"}>
        <button
          aria-label="maximize"
          className={btn}
          onClick={() => {
            bringFront();
            maximize(w);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </Tip>
      <Tip label="关闭窗口">
        <button
          aria-label="close"
          className={`${btn} hover:bg-rose-500/15 hover:text-rose-500`}
          onClick={close}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </Tip>
    </div>
  );
}

/** 最小化时替掉正文：只留一个可点开的提示条 */
export function MinimizedBody({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="nowheel flex flex-1 items-center justify-center gap-2 px-3 py-2 text-xs text-[var(--muted)] hover:bg-[var(--background-tertiary)]"
    >
      已最小化 · {label} · 点我展开
    </button>
  );
}
