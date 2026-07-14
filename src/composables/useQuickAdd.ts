// 全局快速添加 composable —— 模块级共享状态
// 任何位置（侧边栏按钮、键盘快捷键、命令面板）都可唤起快速添加弹窗，
// 并通过 `open(defaultListId?)` 指定默认选中的清单

import { ref } from "vue";

const visible = ref(false);
const defaultListId = ref<string | null>(null);

export function useQuickAdd() {
  function open(listId?: string | null) {
    defaultListId.value = listId ?? null;
    visible.value = true;
  }

  function close() {
    visible.value = false;
    defaultListId.value = null;
  }

  return {
    visible,
    defaultListId,
    open,
    close,
  };
}
