// 日历视图共享 composable —— FullCalendar 接入 + 真实任务数据
// 行为契约：
//   loadEvents(rangeStart, rangeEnd) → 拉取该范围内所有未完成任务，转 EventInput
//   taskToEvent(Task) → 单个任务 → FullCalendar event
//   useCalendarCreateAction(getApi) → + 按钮：取 view.currentStart 作为默认日期，唤起 QuickAddDialog

import { ref, onMounted, onUnmounted } from "vue";
import type { CalendarOptions, EventInput, CalendarApi } from "@fullcalendar/core";
import type { Task } from "@/types";
import { getTasksByDueRange } from "@/api/db";
import { useQuickAdd } from "@/composables/useQuickAdd";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";

// ─── 类型 ───────────────────────────────────────────────

/** 日历事件扩展字段（保留任务 ID 等元数据，便于 eventClick 时打开详情面板） */
export interface CalendarTaskEvent extends EventInput {
  /** 任务 ID（必填） */
  id: string;
  /** 是否已完成 */
  done: boolean;
  /** 优先级（0-3），用于颜色与排序 */
  priority: number;
  /** 父任务 ID（用于分组展示；null = 根任务） */
  parentId: string | null;
}

export type CalendarStatus = "idle" | "loading" | "success" | "error";

/** 日历视图类型 */
export type CalendarViewId = "week" | "month" | "year";

/** 视图类型 → FullCalendar initialView */
export const FC_VIEW: Record<CalendarViewId, "timeGridWeek" | "dayGridMonth" | "dayGridYear"> = {
  week: "timeGridWeek",
  month: "dayGridMonth",
  year: "dayGridYear",
};

// ─── 日期工具（纯函数）──────────────────────────────────

/** Date | string -> 本地时间字面量 "YYYY-MM-DDTHH:mm:ss"（与 SQLite schema 一致） */
export function toLocalIso(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 本地日期 -> YYYY-MM-DD（仅日期部分） */
export function toIsoDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 本地日期 -> "YYYY-MM-DDT00:00:00"（当天零点的完整本地时间字面量）
 *
 * 用途：日历视图把"那天全天"喂给 QuickAddDialog 时需要完整字面量，
 * 因为 DueDateChip 内部的 formatDueDate / parseLocalIso 依赖 [T ] 分隔的时分秒，
 * 纯 "YYYY-MM-DD" 字符串无法被 parseLocalIso 正则匹配，会导致 chip 退回占位。
 */
export function toIsoDateAtStartOfDay(d: Date | string): string {
  return `${toIsoDate(d)}T00:00:00`;
}

// ─── 任务 → FullCalendar 事件 转换（纯函数）───────────────

/** 优先级 → 颜色（与现有任务列表保持一致） */
const PRIORITY_EVENT_COLOR: Record<number, string> = {
  0: "var(--jt-text-tertiary)",  // 灰色
  1: "#3B82F6",                  // 蓝
  2: "#F59E0B",                  // 橙
  3: "#EF4444",                  // 红
};

/** 把本地字面量判别成"全天"还是"时间段"
 *  - 长度 = 10（"YYYY-MM-DD"）= 全天
 *  - 长度 > 10 且时间部分为 "00:00:00" = 全天（凌晨边界，含拖选的多日全天范围）
 *  - 长度 > 10 且时间部分非零 = 时间段 */
function isAllDayLiteral(literal: string): boolean {
  if (literal.length <= 10) return true;
  const m = literal.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return false;
  const t = `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
  return t === "00:00:00";
}

/** 从本地字面量提取日期字段，转成本地 Date 对象 */
function dateLiteralToDate(literal: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(literal);
  if (!m) return new Date(literal);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 把 Task 转换为 FullCalendar 事件
 *
 * @param task 任务
 * @param selectedId 当前选中任务 ID；匹配时给事件加 `jt-task-event--selected` class
 *                   让 CSS 实现日历上的选中高亮（与详情面板打开态同步） */
export function taskToEvent(task: Task, selectedId: string | null = null): CalendarTaskEvent | null {
  if (!task.dueStartAt || !task.dueEndAt) return null;
  const startLiteral = task.dueStartAt;
  const endLiteral = task.dueEndAt;
  const allDay = isAllDayLiteral(startLiteral) && isAllDayLiteral(endLiteral);

  // FullCalendar 全天事件：
  //   - start 用 YYYY-MM-DD（FC 全天事件会忽略时间分量，但带 T 的形式也接受）
  //   - end 是排他的：start=7/1, end=7/5 实际占 7/1/7/2/7/3/7/4 四天
  //   我们的本地字面量是"含端点"语义（7/1-7/4 表示 4 天），所以全天时 end 要 +1 天给 FC
  //
  // 关键点：保留 start 字符串原样（兼容可能存在的时间分量），让 FC 自己识别日期部分
  let fcEnd = endLiteral;
  if (allDay) {
    const nextDay = dateLiteralToDate(endLiteral);
    nextDay.setDate(nextDay.getDate() + 1);
    fcEnd = toIsoDate(nextDay);
  }

  const event: CalendarTaskEvent = {
    id: task.id,
    title: task.title,
    start: startLiteral,
    end: fcEnd,
    allDay,
    priority: task.priority,
    done: task.done,
    parentId: task.parentId,
  };

  if (task.done) {
    // 已完成：灰色 + 删除线样式
    event.color = "#A8A299";
    event.classNames = ["jt-task-event", "jt-task-event--done"];
  } else if (task.parentId) {
    // 子任务：浅一点
    event.color = PRIORITY_EVENT_COLOR[task.priority] ?? PRIORITY_EVENT_COLOR[0];
    event.classNames = ["jt-task-event", "jt-task-event--subtask"];
  } else {
    event.color = PRIORITY_EVENT_COLOR[task.priority] ?? PRIORITY_EVENT_COLOR[0];
    event.classNames = ["jt-task-event", `jt-task-event--p${task.priority}`];
  }

  // 选中态：与 taskStore.selectedTaskId 同步
  if (selectedId && task.id === selectedId) {
    event.classNames = [...(event.classNames ?? []), "jt-task-event--selected"];
  }

  // 可拖动：根任务 + 未完成才允许拖（与 TaskListItem.canDrag 一致）
  // FC per-event 覆盖全局 editable；null 表示用默认
  const draggable = canDragTask(task);
  event.startEditable = draggable;
  event.durationEditable = draggable;

  return event;
}

/** 任务是否可拖（与 TaskListItem.canDrag 保持一致：根 + 未完成）
 *  - !done：已完成不应再被移动
 *  - !parentId：子任务的 due 跟随父任务语义，单独改会导致父子日期不一致 */
export function canDragTask(task: Task): boolean {
  return !task.done && !task.parentId;
}

// ─── FullCalendar options 工厂 ──────────────────────────

/**
 * 创建 FullCalendar options —— 用于周/月/年视图
 * 顶部 headerToolbar 关闭，由 CalendarToolbar.vue 提供
 * @param initialView timeGridWeek / dayGridMonth / dayGridYear
 * @param initialDate 初始聚焦日期（默认今天）
 * @param events 事件数组（由父组件提供，会随数据变化更新）
 */
export function createCalendarOptions(
  initialView: "timeGridWeek" | "dayGridMonth" | "dayGridYear",
  initialDate: string,
  events: CalendarTaskEvent[],
): CalendarOptions {
  return {
    initialView,
    initialDate,
    locale: "zh-cn",
    firstDay: 1,
    // 自定义 headerToolbar（CalendarToolbar 提供），隐藏 FullCalendar 自带的
    headerToolbar: false,
    buttonText: {
      today: "今天",
      month: "月",
      week: "周",
      day: "日",
    },
    events,
    height: "calc(100vh - 56px - 16px * 2)",
    expandRows: true,
    nowIndicator: true,
    // 开启事件拖拽 + 改时长；具体哪些事件可拖由 taskToEvent 写入的
    // event.startEditable / durationEditable（per-event）控制
    editable: true,
    // 不限制每天显示的事件数：月视图一天 4-5 个任务时不需要折叠成 "+N More"，
    // 格子会自动撑高（搭配 expandRows: true）
    dayMaxEventRows: false,
    // 关闭默认的点击/选择交互由父组件接管；eventClick 在 view 层配置
  };
}

// ─── 模块级事件总线：任务变更通知 ─────────────────────────
// 任意位置（QuickAddDialog / TaskDetailPanel / SearchPalette 等）新建 / 更新 / 删除 / 勾选
// 任务后，调用 `notifyTaskChanged()`，所有挂载中的日历视图会自动 reload。

type TaskChangedListener = () => void;
const taskChangedListeners = new Set<TaskChangedListener>();

/** 通知所有日历视图"任务已变更"，请重新拉取当前可视范围 */
export function notifyTaskChanged(): void {
  for (const fn of taskChangedListeners) {
    try {
      fn();
    } catch (e) {
      console.error("[useCalendarView] task:changed listener failed:", e);
    }
  }
}

/** 内部：日历视图挂载时订阅任务变更，卸载时取消订阅 */
function subscribeTaskChanged(fn: TaskChangedListener): () => void {
  taskChangedListeners.add(fn);
  return () => {
    taskChangedListeners.delete(fn);
  };
}

// ─── 数据加载 composable ─────────────────────────────────

/**
 * 视图专属数据加载 + 状态暴露
 *  - `events`：当前范围内的任务事件
 *  - `status` / `error`：加载状态
 *  - `loadRange(start, end)`：手动拉取（也用于 FullCalendar `datesSet` 钩子）
 *
 * @param selectedIdGetter 接收一个"返回当前选中任务 ID"的 getter；
 *                         选中态会反映到每个 event 的 classNames 上，
 *                         选中变化时不需要重拉数据库，只重新 map 一遍 events
 */
export function useCalendarEvents(
  selectedIdGetter: () => string | null = () => null,
) {
  const events = ref<CalendarTaskEvent[]>([]);
  const status = ref<CalendarStatus>("idle");
  const error = ref<string | null>(null);

  /** 把 task 列表 + 当前选中 ID 转为 event 列表（事件本身 + 选中态 class） */
  function mapTasks(tasks: Task[]): CalendarTaskEvent[] {
    const selectedId = selectedIdGetter();
    return tasks
      .map((t) => taskToEvent(t, selectedId))
      .filter((e): e is CalendarTaskEvent => e !== null);
  }

  /** FullCalendar datesSet 回调风格直接传入 */
  async function loadRange(rangeStart: Date, rangeEnd: Date): Promise<void> {
    status.value = "loading";
    error.value = null;
    try {
      const tasks = await getTasksByDueRange(
        toLocalIso(rangeStart),
        toLocalIso(rangeEnd),
        false, // includeDone = false：默认隐藏已完成
      );
      events.value = mapTasks(tasks);
      status.value = "success";
    } catch (e) {
      console.error("[useCalendarEvents] 加载失败:", e);
      error.value = e instanceof Error ? e.message : String(e);
      status.value = "error";
    }
  }

  async function reload(): Promise<void> {
    // 重拉依赖父组件 manage（一般 reload 由 datesSet 触发，无需手工）
    if (currentRange.value) {
      await loadRange(currentRange.value.start, currentRange.value.end);
    }
  }

  /** 选中态变化时只重算 classNames（不重拉 DB） */
  function applySelection(): void {
    const selectedId = selectedIdGetter();
    events.value = events.value.map((e) => {
      const isSelected = selectedId !== null && e.id === selectedId;
      // taskToEvent 总把 classNames 设为数组；如果有遗漏的外部输入兜底成 []
      const base = Array.isArray(e.classNames) ? e.classNames : [];
      const classNames = base.filter((c: string) => c !== "jt-task-event--selected");
      if (isSelected) classNames.push("jt-task-event--selected");
      // 引用变化触发响应式
      return { ...e, classNames };
    });
  }

  /** FullCalendar 当前可视范围（由 datesSet 钩子写入） */
  const currentRange = ref<{ start: Date; end: Date } | null>(null);

  function handleDatesSet(arg: { start: Date; end: Date }): void {
    currentRange.value = { start: arg.start, end: arg.end };
    void loadRange(arg.start, arg.end);
  }

  // 自动订阅任务变更：新建 / 更新 / 删除 / 勾选后，日历当前可视范围自动重拉
  // 这样 QuickAddDialog 创建带日期任务后无需手动刷新就能看到
  onMounted(() => {
    const unsubscribe = subscribeTaskChanged(() => {
      void reload();
    });
    onUnmounted(unsubscribe);
  });

  return { events, status, error, currentRange, loadRange, reload, handleDatesSet, applySelection };
}

/**
 * 返回一个 `onCreate` 处理函数：取当前 FullCalendar 视图区间起点，作为预填日期
 * 然后直接调用模块级 `useQuickAdd().open(null, date)` 唤起 QuickAddDialog
 *
 * 走模块级共享状态而非 provide/inject，避免组件树深度+router-view 节点之间的传递坑。
 */
export function useCalendarCreateAction(
  getApi: () => CalendarApi | null,
): () => void {
  return () => {
    const api = getApi();
    const anchor = api?.view.currentStart ?? new Date();
    const iso = toIsoDateAtStartOfDay(anchor);
    useListStore().loadLists();
    useQuickAdd().open(null, iso);
  };
}

/**
 * 处理 FullCalendar eventClick —— 打开右侧详情面板
 */
export function onCalendarEventClick(
  clickInfo: { event: { id: string } },
): void {
  useTaskStore().selectTask(clickInfo.event.id);
}

/**
 * 处理 FullCalendar eventDrop / eventResize —— 拖拽事件后把新的 start / end
 * 持久化到任务 due_start_at / due_end_at。
 *
 * 流程：
 *   1. 校验 event.start / event.end 都非空
 *   2. 校验任务仍可拖（防御：FC event 自身在拖后可能被改写）
 *   3. 调 taskStore.updateTask 写库
 *      - store 内部已自动同步 currentTasks / subtasks / subtaskCache / selectedTaskObj
 *      - 并 notifyTaskChanged → 当前日历视图的 useCalendarEvents 会 reload
 *   4. 失败时 revert FC DOM（DB 不会被改）
 *
 * 静默成功，不弹任何提示。
 */
export async function onCalendarEventChange(info: {
  event: { id: string; start: Date | null; end: Date | null };
  oldEvent: { start: Date | null; end: Date | null };
  revert: () => void;
}): Promise<void> {
  const { event, oldEvent, revert } = info;
  if (!event.start || !event.end || !oldEvent.start || !oldEvent.end) {
    revert();
    return;
  }
  const taskStore = useTaskStore();
  // 在 store 内查找任务（currentTasks / subtasks / subtaskCache / selectedTask 之一）
  const t =
    taskStore.openTasks.find((x) => x.id === event.id) ??
    taskStore.subtasks.find((x) => x.id === event.id) ??
    Object.values(taskStore.subtaskCache)
      .flat()
      .find((x) => x.id === event.id) ??
    (taskStore.selectedTask?.id === event.id ? taskStore.selectedTask : null);
  if (!t || !canDragTask(t)) {
    revert();
    return;
  }
  // 把 FC 的 Date 转回本地时间字面量
  const newStart = toLocalIso(event.start);
  const newEnd = toLocalIso(event.end);
  try {
    await taskStore.updateTask(event.id, {
      dueStartAt: newStart,
      dueEndAt: newEnd,
    });
    // 拖拽成功 → 关闭详情面板（避免面板里"原日期"和新位置不一致造成认知负担）
    if (taskStore.selectedTaskId === event.id) {
      taskStore.selectTask(null);
    }
  } catch (e) {
    console.error("[onCalendarEventChange] 更新任务日期失败:", e);
    revert();
  }
}

/**
 * 处理 FullCalendar dateClick —— 点击日历空白处唤起 QuickAddDialog，
 * 预填点击的那天作为全天任务（start = end = 那天）
 */
export function onCalendarDateClick(info: { date: Date }): void {
  useListStore().loadLists();
  const iso = toIsoDateAtStartOfDay(info.date);
  useQuickAdd().open(null, iso, iso);
}

/**
 * 处理 FullCalendar select —— 用户拖选一段时间后唤起 QuickAddDialog。
 * 跨天拖选：start ~ end 范围；单格点击拖选：start === end。
 *
 * 注意：FullCalendar 的 selectInfo.end 是**排他的**（即"下一天"），
 * 我们在传给任务前回退一天，对齐任务区间"含端点"的语义。
 */
export function onCalendarSelect(info: { start: Date; end: Date }): void {
  useListStore().loadLists();
  const startIso = toIsoDateAtStartOfDay(info.start);
  // end 是 FC 排他 end（= 拖选最后一天 +1）；转回"含端点"
  const endRaw = new Date(info.end);
  endRaw.setDate(endRaw.getDate() - 1);
  const endIso = toIsoDateAtStartOfDay(endRaw);
  // 全天任务：start/end 都给了
  useQuickAdd().open(null, startIso, endIso);
}
