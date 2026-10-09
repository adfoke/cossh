import { Button, useTheme } from "@heroui/react";
import { useUI } from "../uiStore";

export function TopBar({ onAddTerm }: { onAddTerm: () => void }) {
  const openOverlay = useUI((s) => s.openOverlay);
  const { theme, resolvedTheme, setTheme } = useTheme("dark");

  return (
    <div className="pointer-events-none absolute top-3 left-3 right-3 z-40 flex items-start justify-between">
      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--overlay)]/95 px-2.5 py-2 shadow-xl backdrop-blur">
        <span className="mr-1 pl-1 text-sm font-black tracking-wider">
          SSHX<span className="ml-1 font-normal text-[var(--muted)]">终端画布</span>
        </span>
        <i className="mx-1 h-5 w-px bg-[var(--border)] not-italic" />
        <Button size="sm" variant="danger" onPress={() => openOverlay("notice")}>
          须知
        </Button>
        <Button size="sm" variant="primary" onPress={onAddTerm}>
          ＋终端
        </Button>
        <Button size="sm" variant="secondary" onPress={() => openOverlay("status")}>
          📈 状态卡
        </Button>
        <Button size="sm" variant="secondary" onPress={() => openOverlay("quick")} aria-label="快捷命令面板">
          ⚡ 快捷
        </Button>
        <Button size="sm" variant="ghost" onPress={() => openOverlay("help")}>
          用法
        </Button>
      </div>

      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--overlay)]/95 px-2 py-2 shadow-xl backdrop-blur">
        <Button
          size="sm"
          variant="ghost"
          aria-label="切换主题"
          onPress={() => setTheme((resolvedTheme ?? theme) === "dark" ? "light" : "dark")}
        >
          {(resolvedTheme ?? theme) === "dark" ? "🌙" : "☀️"}
        </Button>
      </div>
    </div>
  );
}
