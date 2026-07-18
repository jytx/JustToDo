// 全局快速添加 composable —— 模块级共享状态
// 任何位置（侧边栏按钮、键盘快捷键、命令面板、日历视图）都可唤起快速添加弹窗，
// 通过 `open(listId?, date?)` 可指定默认清单与默认日期（YYYY-MM-DD）

import { ref } from "vue";

const visible = ref(false);
const defaultListId = ref<string | null>(null);
/** 默认日期（YYYY-MM-DD）；null 表示"今天" */
const defaultDate = ref<string | null>(null);

export function useQuickAdd() {
  function open(listId?: string | null, date?: string | null) {
    defaultListId.value = listId ?? null;
    defaultDate.value = date ?? null;
    visible.value = true;
  }

  function close() {
    visible.value = false;
    defaultListId.value = null;
    defaultDate.value = null;
  }

  return {
    visible,
    defaultListId,
    defaultDate,
    open,
    close,
  };
}
