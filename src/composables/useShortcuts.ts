// 全局快捷键 composable
// 注册搜索(Cmd+K)和快速添加(Cmd+Shift+A)快捷键
import { onMounted, onUnmounted } from "vue";

export function useShortcuts(callbacks: {
  onSearch?: () => void;
  onQuickAdd?: () => void;
  onToggleTheme?: () => void;
}) {
  function handler(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;

    // Cmd+K / Ctrl+K → 搜索
    if (mod && e.key === "k" && !e.shiftKey) {
      e.preventDefault();
      callbacks.onSearch?.();
      return;
    }

    // Cmd+Shift+A / Ctrl+Shift+A → 快速添加
    if (mod && e.shiftKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      callbacks.onQuickAdd?.();
      return;
    }

    // Cmd+Shift+L / Ctrl+Shift+L → 切换主题
    if (mod && e.shiftKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      callbacks.onToggleTheme?.();
      return;
    }
  }

  onMounted(() => window.addEventListener("keydown", handler));
  onUnmounted(() => window.removeEventListener("keydown", handler));
}
