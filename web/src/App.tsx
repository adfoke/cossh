import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useViewport,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import { CodexConfigOverlay } from "./components/CodexConfigOverlay";
import { HelpOverlay } from "./components/HelpOverlay";
import { NoticeOverlay } from "./components/NoticeOverlay";
import { QuickCommandsOverlay } from "./components/QuickCommandsOverlay";
import { AddStatusOverlay } from "./components/AddStatusOverlay";
import { TopBar } from "./components/TopBar";
import { TermNode } from "./nodes/TermNode";
import { StatusNode } from "./nodes/StatusNode";
import { newId } from "./store";
import { observeSince, writeCodexAgents } from "./api";
import { useUI } from "./uiStore";
import type { StatusNodeData, TermNodeData } from "./types";

const LS = { nodes: "sshx.canvas.nodes", edges: "sshx.canvas.edges" };

const nodeTypes = { term: TermNode, status: StatusNode } satisfies NodeTypes;

/**
 * 安装 Codex CLI 的一次性命令（在真 PTY 窗里自动执行）：
 * 先查本机有没有 codex，没有才走 npm 全局装。
 * 代理不做任何硬编码：走用户 shell 自己的 npm 配置（.npmrc / *_proxy env）。
 */
export const CODEX_INSTALL_CMD = [
  'if command -v codex >/dev/null 2>&1; then',
  'echo "✅ codex 已装过：$(command -v codex)"; codex --version 2>&1 | head -n1;',
  'else echo "📦 未检测到 codex，npm 全局安装 @openai/codex …";',
  'npm install -g @openai/codex',
  '&& echo "✅ 安装完成" || echo "❌ 安装失败（见上方 npm 报错）"; codex --version 2>&1 | head -n1; fi',
].join(" ");

/** 画布上唯一的节点：真 PTY 终端窗 */
function makeTermNode(
  position: { x: number; y: number },
  opts?: { title?: string; runOnOpen?: string; observeHost?: string; observeSession?: string; observeUser?: string },
): Node {
  return {
    id: newId("term"),
    type: "term",
    position,
    data: {
      title: opts?.title ?? `终端 ${newId("t").slice(2, 6)}`,
      ...(opts?.runOnOpen ? { runOnOpen: opts.runOnOpen } : {}),
      ...(opts?.observeHost ? { observeHost: opts.observeHost, observeSession: opts.observeSession, observeUser: opts.observeUser } : {}),
    } satisfies TermNodeData,
  };
}

/** 状态卡节点工厂：host 是唯一必填语义，其余都有默认 */
function makeStatusNode(position: { x: number; y: number }, host: string, title: string): Node {
  return {
    id: newId("status"),
    type: "status",
    position,
    data: { title, host } satisfies StatusNodeData,
  };
}

/**
 * 读取持久化画布：只保留 term 节点（老版本的 host/chat 节点直接淘汰），
 * 并顺手清掉旧主机连线数据。data 里的历史字段（hostId/session 等）会被剥掉。
 */
function loadTermNodes(): Node[] {
  try {
    const raw = localStorage.getItem(LS.nodes);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Node[];
    return arr
      .filter((n) => (n?.type === "term" || n?.type === "status") && n?.position)
      .map((n): Node | null => {
        if (n.type === "status") {
          const d = n.data as Partial<StatusNodeData> | undefined;
          if (!d?.host) return null; // 没 host 的状态卡是残骸，淘汰
          return {
            id: n.id,
            type: "status" as const,
            position: n.position,
            selected: false,
            data: {
              title: String(d.title ?? d.host),
              host: d.host,
              win: d.win,
              paused: d.paused,
            } satisfies StatusNodeData,
          };
        }
        return {
          id: n.id,
          type: "term" as const,
          position: n.position,
          selected: false,
          data: {
            title: String((n.data as Partial<TermNodeData>)?.title ?? "终端"),
            win: (n.data as TermNodeData)?.win,
            observeHost: (n.data as TermNodeData)?.observeHost,
            observeSession: (n.data as TermNodeData)?.observeSession,
            observeUser: (n.data as TermNodeData)?.observeUser,
          } satisfies TermNodeData,
        };
      })
      .filter((n): n is Node => n != null);
  } catch {
    return [];
  }
}

/**
 * 应用主题跟随：HeroUI useTheme 把结果写进 html（data-theme + class），
 * 但它的 resolvedTheme 是每实例私有 state，别处切换不会触发本组件重渲染。
 * 所以盯 DOM 属性变化，谁切的都能实时同步。
 */
function useAppTheme(): "light" | "dark" {
  const read = useCallback((): "light" | "dark" => {
    const el = document.documentElement;
    const t = el.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    if (el.classList.contains("light")) return "light";
    if (el.classList.contains("dark")) return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }, []);
  const [mode, setMode] = useState<"light" | "dark">(read);
  useEffect(() => {
    // 子组件（TopBar 的 useTheme）effect 比本组件先跑，主题可能已在 effect 窗口内被改写；
    // 注册监听前补读一次，避免错过那一次 mutation。
    setMode(read());
    const mo = new MutationObserver(() => setMode(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => mo.disconnect();
  }, [read]);
  return mode;
}

/** Auto 整理：按阅读序（先上后下、先左后右）把全部终端窗网格排布，animate 位移 + fitView */
function AutoArrangeControl({ onArranged }: { onArranged: () => void }) {
  const rf = useReactFlow();
  const arrange = useCallback(() => {
    const ns = rf.getNodes().filter((n) => n.type === "term");
    if (ns.length === 0) return;
    const order = [...ns].sort((a, b) =>
      Math.abs(a.position.y - b.position.y) > 60 ? a.position.y - b.position.y : a.position.x - b.position.x,
    );
    // 网格单元取全场最大窗体 + 间距：最大化/最小化窗都各自完整落格，互不重叠
    const cw = Math.max(...order.map((n) => n.measured?.width ?? 760)) + 48;
    const ch = Math.max(...order.map((n) => n.measured?.height ?? 420)) + 48;
    const cols = Math.ceil(Math.sqrt(order.length));
    const rows = Math.ceil(order.length / cols);
    const grid = new Map(
      order.map((n, i) => [
        n.id,
        { x: (i % cols) * cw - ((cols - 1) * cw) / 2, y: Math.floor(i / cols) * ch - ((rows - 1) * ch) / 2 },
      ]),
    );
    rf.setNodes((list) => list.map((n) => (grid.has(n.id) ? { ...n, position: grid.get(n.id)!, animate: true } : n)));
    window.setTimeout(() => void rf.fitView({ padding: 0.12, duration: 420 }), 80);
    onArranged(); // 位置属数据级变化：手动落一条历史，⌘Z 能退回整理前
  }, [rf, onArranged]);
  return (
    <button
      className="react-flow__controls-button"
      title="Auto 整理窗口（网格排布 + 适应视口，⌘Z 可撤销）"
      aria-label="auto-arrange"
      onClick={arrange}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <rect x="1" y="1" width="4.4" height="4.4" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="6.6" y="1" width="4.4" height="4.4" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="1" y="6.6" width="4.4" height="4.4" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="6.6" y="6.6" width="4.4" height="4.4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </button>
  );
}

/** 缩放百分比读数：跟在右下角 Controls 列尾部，随缩放控件一起动；点一下回到 100% */
function ZoomControl() {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const pct = Math.round(zoom * 100);
  return (
    <button
      className="zoom-badge react-flow__controls-button !text-[10px] leading-none tabular-nums cursor-pointer select-none"
      title={`当前缩放 ${pct}% · 点击恢复 100%`}
      aria-label={`缩放 ${pct}%，点击恢复 100%`}
      onClick={() => void rf.zoomTo(1, { duration: 240 })}
    >
      {pct}%
    </button>
  );
}

function Canvas() {
  const rf = useReactFlow();
  const colorMode = useAppTheme();
  // dev-only e2e 钩子：回归脚本用 __sshxRf.getNodes()/setNodes() 做确定性寻的（生产构建不暴露）
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__sshxRf = rf;
  }, [rf]);
  const [nodes, setNodes, onNodesChange] = useNodesState(loadTermNodes());
  const saveTimer = useRef<number | undefined>(undefined);
  const jitter = useRef(0);

  // 旧版本残留的连线持久化键：清一次
  useEffect(() => {
    localStorage.removeItem(LS.edges);
  }, []);

  // 画布持久化（防抖）
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(LS.nodes, JSON.stringify(nodes.map((n) => ({ ...n, selected: false }))));
    }, 400);
  }, [nodes]);

  /* ───────────── 撤销/重做 + 快捷操作 ───────────── */
  // 快照约定：baseline = 上一次"落定"的画布；past/future 为双栈。
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const past = useRef<Node[][]>([]);
  const future = useRef<Node[][]>([]);
  const baseline = useRef<Node[] | null>(null);
  const skipHistory = useRef(false);

  const snap = useCallback((): Node[] => {
    const cleanN = nodesRef.current.map((n) => ({ ...n, selected: false }));
    return structuredClone(cleanN);
  }, []);

  const idsSig = (ns: Node[]) => ns.map((n) => n.id).join(",");
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /** 变更落定后调用（拖拽结束/改名等数据级变化）；结构性变化由 effect 兜底 */
  const commitSoon = useCallback(() => {
    window.setTimeout(() => {
      const next = snap();
      if (!baseline.current || sameJson(next, baseline.current)) return;
      past.current.push(baseline.current);
      if (past.current.length > 80) past.current.shift();
      future.current = [];
      baseline.current = next;
    }, 0);
  }, [snap]);

  // 增删节点 → 自动落一条历史；跳过 undo/redo 自身触发的变化
  useEffect(() => {
    const cur = snap();
    if (!baseline.current) {
      baseline.current = cur;
      return;
    }
    if (skipHistory.current) {
      skipHistory.current = false;
      baseline.current = cur;
      return;
    }
    if (idsSig(cur) !== idsSig(baseline.current)) {
      past.current.push(baseline.current);
      if (past.current.length > 80) past.current.shift();
      future.current = [];
      baseline.current = cur;
    }
  }, [nodes, snap]);

  const restore = useCallback(
    (ns: Node[]) => {
      skipHistory.current = true;
      setNodes(ns);
    },
    [setNodes],
  );
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !baseline.current) return;
    future.current.push(baseline.current);
    baseline.current = prev;
    restore(prev);
  }, [restore]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !baseline.current) return;
    past.current.push(baseline.current);
    baseline.current = next;
    restore(next);
  }, [restore]);

  const renameNode = useCallback(
    (nodeId: string) => {
      const n = rf.getNode(nodeId);
      if (!n) return;
      const cur = String((n.data as Record<string, unknown>).title ?? "");
      const t = window.prompt("重命名窗口", cur);
      if (!t || !t.trim() || t.trim() === cur) return;
      rf.updateNodeData(nodeId, { title: t.trim() });
      commitSoon();
    },
    [rf, commitSoon],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const ui = useUI.getState();
      const meta = e.metaKey || e.ctrlKey;
      // ⌘K 快捷命令：toggle 语义，能穿透弹层（自己开着时再按即关）
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (ui.overlay === "quick") ui.close();
        else ui.openOverlay("quick");
        return;
      }
      if (ui.overlay) return; // 弹层自己的 Esc 由 Overlay 处理
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "F2") {
        const sel = nodesRef.current.filter((n) => n.selected);
        if (sel.length === 1) renameNode(sel[0].id);
      } else if (e.key === "?") {
        ui.openOverlay("help");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, renameNode]);

  /** 在视口中心附近落一个新终端（抖动防完全重叠） */
  const addTerminal = useCallback(
    (opts?: { title?: string; runOnOpen?: string; observeHost?: string; observeSession?: string; observeUser?: string }) => {
      const c = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      jitter.current = (jitter.current + 48) % 340;
      rf.addNodes(makeTermNode({ x: c.x - 240 + jitter.current, y: c.y - 180 + jitter.current }, opts));
    },
    [rf],
  );
  const installCodex = useCallback(
    () => addTerminal({ title: "安装 Codex CLI", runOnOpen: CODEX_INSTALL_CMD }),
    [addTerminal],
  );
  const addStatusNode = useCallback(
    (host: string, title: string) => {
      const c = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      jitter.current = (jitter.current + 48) % 340;
      rf.addNodes(makeStatusNode({ x: c.x + 40 + jitter.current, y: c.y - 160 + jitter.current }, host, title));
    },
    [rf],
  );
  /** 规矩写入走 REST（服务端幂等标记块），成功后开个窗把块内容 sed 出来验货 */
  const writeCodexRules = useCallback(async () => {
    try {
      const r = await writeCodexAgents();
      addTerminal({
        title: "Codex 规矩",
        runOnOpen: `sed -n '/sshx:remote-tmux:start/,/sshx:remote-tmux:end/p' ${JSON.stringify(r.path)} && echo "✅ ${r.created ? "已创建" : "已更新"}（重复点击只替换标记块，不堆重复）"`,
      });
    } catch (e) {
      window.alert(`写入失败：${(e as Error).message}`);
    }
  }, [addTerminal]);

  /* ───── 观察事件轮询：ssh shim 报「远端 tmux 被驱动」→ 自动拉起 👀 观察窗 ───── */
  const observeCursor = useRef(0);
  useEffect(() => {
    const t = window.setInterval(() => {
      void observeSince(observeCursor.current).then(({ events, latest }) => {
        observeCursor.current = latest; // 对齐权威游标；服务端重启会 stale 重放，key 去重兜底
        for (const e of events) {
          const dup = rf
            .getNodes()
            .some((n) => (n.data as TermNodeData).observeHost === e.host && (n.data as TermNodeData).observeSession === e.session);
          if (dup) continue;
          addTerminal({
            title: `👀 ${e.user ? e.user + "@" : ""}${e.host}:${e.session}`,
            observeHost: e.host,
            observeSession: e.session,
            observeUser: e.user || undefined,
          });
        }
      });
    }, 1500);
    return () => window.clearInterval(t);
  }, [rf, addTerminal]);


  const empty = nodes.length === 0;

  const hint = useMemo(
    () => (
      <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
        <div className="pointer-events-auto max-w-md rounded-3xl border border-[var(--border)] bg-[var(--overlay)]/95 p-7 text-center shadow-2xl backdrop-blur">
          <div className="text-3xl">🖥️</div>
          <h2 className="mt-2 text-lg font-bold">SSHX · 无限画布上的真终端</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            点 <b>＋终端</b> 开一个本机真 PTY shell——不是快照镜像，是字节级双向管道：
            vim、htop、ssh 随便跑。开多少个窗口，就是多少个独立进程，
            在画布上随意摆位、<b>—</b> 最小化（进程不死）、<b>□</b> 最大化、关错了 <b>⌘Z</b> 找回。
            <b>📈 状态卡</b>盯远端机器健康，<b>⚡ 快捷命令（⌘K）</b>一键塞回你正在用的终端。
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              onClick={() => addTerminal()}
              className="rounded-xl bg-[var(--default)] px-5 py-2 text-sm font-semibold text-[var(--default-foreground)]"
            >
              ＋ 开第一个终端
            </button>
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">shell 跑在这台机器上（仅 127.0.0.1 服务，不对外）</p>
        </div>
      </div>
    ),
    [addTerminal],
  );

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        onNodeDragStop={commitSoon}
        onNodeDoubleClick={(_, n) => renameNode(n.id)}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        nodesConnectable={false}
        fitView
        minZoom={0.08}
        maxZoom={2.5}
        deleteKeyCode={["Delete", "Backspace"]}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.5} color="var(--separator)" />
        <Controls showInteractive={false} position="bottom-right">
          <AutoArrangeControl onArranged={commitSoon} />
          <ZoomControl />
        </Controls>
      </ReactFlow>
      <TopBar onAddTerm={() => addTerminal()} onInstallCodex={installCodex} onWriteCodexRules={() => void writeCodexRules()} />
      {empty && hint}
      <HelpOverlay />
      <NoticeOverlay />
      <CodexConfigOverlay />
      <QuickCommandsOverlay onNewTerminal={(cmd) => addTerminal({ title: "快捷命令", runOnOpen: cmd })} />
      <AddStatusOverlay onCreate={addStatusNode} />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
