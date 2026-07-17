// 全局快捷键 composable
// - Cmd/Ctrl+K → 搜索
// - Cmd/Ctrl+Shift+A → 快速添加
// - Cmd/Ctrl+Shift+L → 切换主题
// - Cmd/Ctrl+N → 新建任务（与顶部 +、Cmd+Shift+A 等价）
// - Cmd/Ctrl+Plus 或 = → 放大界面
// - Cmd/Ctrl+Minus → 缩小界面
// - Cmd/Ctrl+0 → 恢复 100%
//
// 注意：与 AppLayout 的 onNavigationKeydown 不同，这里不强制跳过输入框；
// 真实业务中"在输入框里按 Cmd+K"通常希望也能打开搜索面板（与 Things/Linear 等一致）。
import { onMounted, onUnmounted } from "vue";

export function useShortcuts(callbacks: {
  onSearch?: () => void;
  onQuickAdd?: () => void;
  onToggleTheme?: () => void;
  onNewTask?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}) {
  function handler(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // Cmd/Ctrl+Plus 或 = → 放大（浏览器惯例：不按 Shift 时 + 键也是 =）
    if (!e.shiftKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      callbacks.onZoomIn?.();
      return;
    }

    // Cmd/Ctrl+Minus → 缩小
    if (!e.shiftKey && e.key === "-") {
      e.preventDefault();
      callbacks.onZoomOut?.();
      return;
    }

    // Cmd/Ctrl+0 → 恢复 100%
    if (!e.shiftKey && e.key === "0") {
      e.preventDefault();
      callbacks.onZoomReset?.();
      return;
    }

    // Cmd/Ctrl+N → 新建任务
    if (
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "n" || e.key === "N")
    ) {
      e.preventDefault();
      callbacks.onNewTask?.();
      return;
    }

    // Cmd/Ctrl+K → 搜索
    if (e.key === "k" && !e.shiftKey) {
      e.preventDefault();
      callbacks.onSearch?.();
      return;
    }

    // Cmd/Ctrl+Shift+A → 快速添加
    if (e.shiftKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      callbacks.onQuickAdd?.();
      return;
    }

    // Cmd/Ctrl+Shift+L → 切换主题
    if (e.shiftKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      callbacks.onToggleTheme?.();
      return;
    }
  }

  onMounted(() => window.addEventListener("keydown", handler));
  onUnmounted(() => window.removeEventListener("keydown", handler));
}
