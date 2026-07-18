// 日历视图共享 composable —— FullCalendar 接入 + 假数据 + 公共 actions
// 本期先用假数据评估视觉，后续接入真实任务数据
import type { CalendarOptions, EventInput, CalendarApi } from "@fullcalendar/core";
import { useQuickAdd } from "@/composables/useQuickAdd";
import { useListStore } from "@/stores/list";

/** 演示用假数据 —— 覆盖全天/时间段/跨天/已完成 等场景 */
export const SAMPLE_EVENTS: EventInput[] = [
  // 全天任务
  { id: "1", title: "年度复盘", start: "2026-07-15", allDay: true, color: "#4F46E5" },
  { id: "2", title: "整理笔记", start: "2026-07-16", allDay: true },
  { id: "3", title: "妈妈生日 🎂", start: "2026-07-18", allDay: true, color: "#EC4899" },

  // 时间段任务
  { id: "4", title: "团队周会", start: "2026-07-14T10:00", end: "2026-07-14T11:30", color: "#10B981" },
  { id: "5", title: "代码评审", start: "2026-07-14T14:00", end: "2026-07-14T15:00" },
  { id: "6", title: "周报撰写", start: "2026-07-16T19:30", end: "2026-07-16T21:00", color: "#F59E0B" },
  { id: "7", title: "阅读《代码大全》", start: "2026-07-16T20:00", end: "2026-07-16T22:00" },

  // 跨天任务
  { id: "8", title: "外出旅行", start: "2026-07-20", end: "2026-07-23", allDay: true, color: "#8B5CF6" },

  // 已完成
  { id: "9", title: "✓ 上周已完成的复盘", start: "2026-07-10T09:00", end: "2026-07-10T10:00", color: "#A8A299" },

  // 月视图散布任务
  { id: "10", title: "练听力", start: "2026-07-08", allDay: true },
  { id: "11", title: "存钱", start: "2026-07-09", allDay: true },
  { id: "12", title: "练双人", start: "2026-07-09T19:30", end: "2026-07-09T21:00" },
  { id: "13", title: "买猫砂", start: "2026-07-12T14:00", end: "2026-07-12T14:30" },
  { id: "14", title: "Tap 练习", start: "2026-07-12T17:00", end: "2026-07-12T18:30", color: "#3B82F6" },
  { id: "15", title: "回邮件", start: "2026-07-13T16:00", end: "2026-07-13T16:30" },
  { id: "16", title: "整理 SOP", start: "2026-07-17T15:00", end: "2026-07-17T17:00" },
  { id: "17", title: "健身房", start: "2026-07-17T20:00", end: "2026-07-17T21:30", color: "#EF4444" },
];

/**
 * 创建 FullCalendar options —— 用于周/月/年视图
 * 顶部 headerToolbar 关闭，由 CalendarToolbar.vue 提供
 * @param initialView dayGridMonth / timeGridWeek / dayGridYear
 * @param initialDate 初始聚焦日期（默认今天）
 */
export function createCalendarOptions(
  initialView: "dayGridMonth" | "timeGridWeek" | "dayGridYear",
  initialDate?: string,
): CalendarOptions {
  return {
    initialView,
    initialDate: initialDate ?? "2026-07-15",
    locale: "zh-cn",
    firstDay: 1,
    // 自定义 headerToolbar（CalendarToolbar 提供），这里隐藏 FullCalendar 自带的
    headerToolbar: false,
    buttonText: {
      today: "今天",
      month: "月",
      week: "周",
      day: "日",
    },
    events: SAMPLE_EVENTS,
    height: "calc(100vh - 56px - 16px * 2)",
    expandRows: true,
    nowIndicator: true,
    dayMaxEventRows: 3,
  };
}

/**
 * 把 Date 转成本地时区的 YYYY-MM-DD（避免 toISOString 带来的 UTC 偏移问题）
 */
export function toIsoDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 返回一个 `onCreate` 处理函数：取当前 FullCalendar 视图区间起点，作为预填日期
 * 然后直接调用模块级 `useQuickAdd().open(null, date)` 唤起 QuickAddDialog
 *
 * 走模块级共享状态而非 provide/inject，避免组件树深度+router-view 节点之间的传递坑。
 *
 * @param getApi 父组件暴露的 `() => CalendarApi | null`（用于取 view.currentStart）
 */
export function useCalendarCreateAction(
  getApi: () => CalendarApi | null,
): () => void {
  return () => {
    // 月视图：currentStart = 当月 1 号；周视图：本周第一天；年视图：1 月 1 日
    const api = getApi();
    const anchor = api?.view.currentStart ?? new Date();
    const iso = toIsoDate(anchor);
    // 提前加载清单（QuickAddDialog 依赖清单数据决定默认选中项）
    useListStore().loadLists();
    useQuickAdd().open(null, iso);
  };
}
