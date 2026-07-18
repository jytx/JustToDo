// 全局快速添加 composable —— 模块级共享状态
// 任何位置（侧边栏按钮、键盘快捷键、命令面板、日历视图）都可唤起快速添加弹窗，
// 通过 `open(listId?, date?)` 或 `open(listId?, startDate, endDate?)`
// 指定默认清单与默认日期（YYYY-MM-DD）

import { ref } from "vue";

const visible = ref(false);
const defaultListId = ref<string | null>(null);
/** 任务开始日期 YYYY-MM-DD；null 表示"今天" */
const defaultStart = ref<string | null>(null);
/** 任务结束日期 YYYY-MM-DD；null = 与 start 同一天 = 全天单天 */
const defaultEnd = ref<string | null>(null);

export function useQuickAdd() {
  /** 一参形式：传单个日期字符串 */
  function open(listId?: string | null, date?: string | null): void;
  /** 三参形式：传开始日期 + 结束日期（用于拖选多天任务） */
  function open(listId: string | null | undefined, startDate: string, endDate?: string | null): void;
  function open(
    listId?: string | null,
    a?: string | null,
    b?: string | null,
  ): void {
    defaultListId.value = listId ?? null;
    // 单参 date：end = start
    // 三参 (startDate, endDate?)：a 是 start，b 是 end
    if (a == null) {
      defaultStart.value = null;
      defaultEnd.value = null;
    } else if (b == null) {
      defaultStart.value = a;
      defaultEnd.value = a;
    } else {
      defaultStart.value = a;
      defaultEnd.value = b;
    }
    visible.value = true;
  }

  function close(): void {
    visible.value = false;
    defaultListId.value = null;
    defaultStart.value = null;
    defaultEnd.value = null;
  }

  return {
    visible,
    defaultListId,
    defaultStart,
    defaultEnd,
    open,
    close,
  };
}
