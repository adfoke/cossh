// 快捷命令库：localStorage 持久化的 {id,name,cmd} 列表（CRUD 即落盘）。
// 执行不落在这里——注入/兜底开窗的语义在面板组件里拿 termBus 做。
import { create } from "zustand";
import { newId } from "./store";

export interface QuickCmd {
  id: string;
  name: string;
  cmd: string;
}

const LS_KEY = "sshx.quickCommands";

function load(): QuickCmd[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as QuickCmd[];
    return Array.isArray(arr)
      ? arr
          .filter((c) => c && typeof c.cmd === "string" && typeof c.name === "string")
          .map((c) => ({ id: typeof c.id === "string" ? c.id : newId("q"), name: c.name, cmd: c.cmd }))
      : [];
  } catch {
    return [];
  }
}

interface QuickState {
  items: QuickCmd[];
  add: (name: string, cmd: string) => QuickCmd;
  update: (id: string, patch: Partial<Omit<QuickCmd, "id">>) => void;
  remove: (id: string) => void;
}

export const useQuickCommands = create<QuickState>((set, get) => {
  const persist = (items: QuickCmd[]) => {
    localStorage.setItem(LS_KEY, JSON.stringify(items));
    set({ items });
  };
  return {
    items: load(),
    add: (name, cmd) => {
      const item: QuickCmd = { id: newId("q"), name, cmd };
      persist([...get().items, item]);
      return item;
    },
    update: (id, patch) => persist(get().items.map((c) => (c.id === id ? { ...c, ...patch } : c))),
    remove: (id) => persist(get().items.filter((c) => c.id !== id)),
  };
});
