// ⌘K 快捷命令面板：保存常用命令，一键注入「最后敲过字的那个活终端」；
// 没有活终端就退化为开一扇新窗跑（借用 runOnOpen 用后即焚链路）。
import { useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { pickLiveTerm } from "../termBus";
import { useQuickCommands, type QuickCmd } from "../quickStore";
import { useUI } from "../uiStore";
import { Overlay } from "./Overlay";

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--background-tertiary)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--focus)]";

export function QuickCommandsOverlay({ onNewTerminal }: { onNewTerminal: (cmd: string) => void }) {
  const overlay = useUI((s) => s.overlay);
  const close = useUI((s) => s.close);
  const items = useQuickCommands((s) => s.items);
  const add = useQuickCommands((s) => s.add);
  const update = useQuickCommands((s) => s.update);
  const remove = useQuickCommands((s) => s.remove);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<QuickCmd | "new" | null>(null);
  const [name, setName] = useState("");
  const [cmd, setCmd] = useState("");
  const [flash, setFlash] = useState("");

  // 面板收起 = 一切归零：下次 ⌘K 进来永远是列表，不会停在半路的编辑表单
  useEffect(() => {
    if (overlay !== "quick") {
      setEditing(null);
      setQuery("");
      setFlash("");
    }
  }, [overlay]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.name.toLowerCase().includes(q) || c.cmd.toLowerCase().includes(q));
  }, [items, query]);

  if (overlay !== "quick") return null;

  const run = (c: QuickCmd) => {
    const target = pickLiveTerm();
    if (target) {
      target.handle.write(c.cmd + "\r");
      close();
    } else {
      onNewTerminal(c.cmd);
      close();
    }
  };

  const startEdit = (c: QuickCmd | "new") => {
    setEditing(c);
    setName(c === "new" ? "" : c.name);
    setCmd(c === "new" ? "" : c.cmd);
    setFlash("");
  };

  const saveEdit = () => {
    const n = name.trim();
    const v = cmd.trim();
    if (!n || !v) return;
    if (editing === "new") add(n, v);
    else if (editing) update(editing.id, { name: n, cmd: v });
    setEditing(null);
    setFlash(`已保存「${n}」`);
  };

  if (editing) {
    return (
      <Overlay title={editing === "new" ? "⚡ 新建快捷命令" : "⚡ 编辑快捷命令"} onClose={close} width={520}>
        <div className="space-y-3 text-sm" data-qc-form>
          <div>
            <label className="mb-1 block text-xs font-semibold text-[var(--muted)]" htmlFor="qc-name">
              名字（面板里认它）
            </label>
            <input
              id="qc-name"
              data-qc-name
              autoFocus
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：看 docker 日志 / 磁盘清理三连"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-[var(--muted)]" htmlFor="qc-cmd">
              命令（将原样送进终端并回车）
            </label>
            <textarea
              id="qc-cmd"
              data-qc-cmd
              rows={3}
              className={`${inputCls} font-mono`}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder={"docker ps --format '{{.Names}}'"}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveEdit();
              }}
            />
          </div>
          <p className="text-xs leading-5 text-[var(--muted)]">
            执行时送进<b>你最后敲过字的那个终端窗</b>；一扇活的都没有就自动开新窗跑。多行命令 = 每行各一次回车。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={() => setEditing(null)}>
              返回
            </Button>
            <Button size="sm" variant="primary" isDisabled={!name.trim() || !cmd.trim()} onPress={saveEdit} aria-label="qc-save">
              保存（⌘↵）
            </Button>
          </div>
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay title="⚡ 快捷命令" onClose={close} width={520}>
      <div className="space-y-2 text-sm" data-qc-overlay>
        <div className="flex gap-2">
          <input
            data-qc-search
            autoFocus
            className={inputCls}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名字或命令… 回车执行首条匹配"
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) run(filtered[0]);
            }}
          />
          <Button size="sm" variant="secondary" aria-label="新建快捷命令" onPress={() => startEdit("new")}>
            ＋新建
          </Button>
        </div>
        {flash && (
          <div className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-500" data-qc-flash>
            {flash}
          </div>
        )}
        {filtered.length === 0 && (
          <div className="py-8 text-center text-xs text-[var(--muted)]">
            {items.length === 0 ? "还没有命令——点「＋新建」存第一条" : "没搜到，换个词"}
          </div>
        )}
        <div className="max-h-[46vh] space-y-1 overflow-y-auto">
          {filtered.map((c) => (
            <div
              key={c.id}
              data-qc-row
              className="group flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background-tertiary)]/60 px-2.5 py-2"
            >
              <button
                data-qc-run
                aria-label={`执行 ${c.name}`}
                className="shrink-0 rounded-lg bg-[var(--default)] px-2.5 py-1 text-xs font-bold text-[var(--default-foreground)] transition hover:brightness-110"
                onClick={() => run(c)}
                title="注入到当前聚焦终端"
              >
                ▶
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{c.name}</div>
                <div className="truncate font-mono text-[11px] text-[var(--muted)]">{c.cmd}</div>
              </div>
              <button
                aria-label="qc-edit"
                className="shrink-0 rounded-md px-1.5 py-1 text-xs text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--background-tertiary)]"
                onClick={() => startEdit(c)}
              >
                编辑
              </button>
              <button
                aria-label={`删除 ${c.name}`}
                className="shrink-0 rounded-md px-1.5 py-1 text-xs text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:bg-rose-500/15 hover:text-rose-500"
                onClick={() => remove(c.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[var(--muted)]">⌘K 随时唤起 · 面板数据存本机 localStorage</p>
      </div>
    </Overlay>
  );
}
