// UI 弹层状态（小颗粒 store，避免 App 巨型 state）
import { create } from "zustand";

export type OverlayName = "help" | "codex" | "notice" | null;

interface UIState {
  overlay: OverlayName;
  openOverlay: (name: Exclude<OverlayName, null>) => void;
  close: () => void;
}

export const useUI = create<UIState>((set) => ({
  overlay: null,
  openOverlay: (name) => set({ overlay: name }),
  close: () => set({ overlay: null }),
}));
