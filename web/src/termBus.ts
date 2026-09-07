// 终端窗注册总线：快捷命令面板要把命令「塞进用户正在敲的那个终端」，
// 但 ws 握在每个 TermNode 组件手里——用模块级注册表解耦，不拉全局 state。
// 焦点序（MRU）：最后一次 pointerdown/focus 的窗优先；它没了再顺位取下一个活着的。
export interface TermHandle {
  title: () => string;
  write: (s: string) => void;
  isLive: () => boolean;
}

const handles = new Map<string, TermHandle>();
let focusOrder: string[] = []; // 越靠前越"新鲜"

export function registerTerm(id: string, h: TermHandle): () => void {
  handles.set(id, h);
  focusOrder = [id, ...focusOrder.filter((x) => x !== id)];
  return () => {
    handles.delete(id);
    focusOrder = focusOrder.filter((x) => x !== id);
  };
}

export function touchTerm(id: string): void {
  focusOrder = [id, ...focusOrder.filter((x) => x !== id)];
}

/** 取当前注入目标：MRU 序里第一个还活着的窗 */
export function pickLiveTerm(): { id: string; handle: TermHandle } | null {
  for (const id of focusOrder) {
    const h = handles.get(id);
    if (h && h.isLive()) return { id, handle: h };
  }
  return null;
}
