// 日历视图共享 composable —— FullCalendar 接入 + 真实任务数据
// 行为契约：
//   loadEvents(rangeStart, rangeEnd) → 拉取该范围内所有未完成任务，转 EventInput
//   taskToEvent(Task) → 单个任务 → FullCalendar event
//   useCalendarCreateAction(getApi) → + 按钮：取 view.currentStart 作为默认日期，唤起 QuickAddDialog

import { ref, onMounted, onUnmounted } from "vue";
import type { CalendarOptions, EventInput, CalendarApi, EventMountArg } from "@fullcalendar/core";
// 中文语言包：FC v6 的 locale 模块 export default 一个 LocaleInput 对象，
// 需显式加到 options.locales 数组里（不能靠 side-effect import 自动注册）。
// 这样 allDayText/按钮文本/moreLinkText 等才会中文化。
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
/**
 * locales 数组必须用稳定的模块级常量。
 * 若放在 createCalendarOptions 内每次新建数组（[zhCnLocale]），FC vue3 组件会因
 * locales 引用变化触发完整重渲染循环（.fc 的 fallthrough attrs 每帧重设），
 * 叠加 daygrid 的 flushScrollReset，导致年视图滚动被反复拉回当月位置（颤抖）。
 */
const FC_LOCALES = [zhCnLocale];
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
  /** 原始 DB 日期字面量（含端点语义；FC 全天事件 end 排他，需存原始值供 resize） */
  origStart: string;
  /** 原始 DB 结束日期字面量（含端点语义） */
  origEnd: string;
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
    // 强制 'block' 渲染：FC v6 dayGridMonth 对非全天的"单格内"事件
    // (如时间段单天任务) 默认走 .fc-daygrid-dot-event 路径（圆点形式），
    // 那个组件不带 .fc-h-event class，drag detection 走的是 .fc-h-event，
    // 所以 dot 形式的事件**根本不能拖**。
    // 强制 'block' 让所有事件统一走 .fc-daygrid-block-event 路径，
    // 都能正常拖动改日期。
    display: "block",
    priority: task.priority,
    done: task.done,
    parentId: task.parentId,
    // 原始 DB 日期字面量（含端点语义）。FC 全天事件的 end 是排他的（lastDay+1），
    // resize 时需要原始 DB 日期，存 extendedProps 避开 FC 转换
    origStart: task.dueStartAt,
    origEnd: task.dueEndAt,
  };

  if (task.done) {
    // 已完成：中性灰 + 删除线样式（与浅色主题中性调对齐）
    event.color = "#A1A1AA";
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
  // 头部 resize 由全局 eventResizableFromStart 控制（非 per-event）

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
    // 提供可用的 locale 列表（zh-cn 语言包对象）。
    // FC 会从中找 code === locale 的那个，应用其 allDayText / buttonText 等翻译。
    // 必须用模块级常量 FC_LOCALES（引用稳定），否则每次 options 重建会触发 FC 重渲染循环。
    locales: FC_LOCALES,
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
    // 不在每次视图刷新时重置滚动位置（FC 默认 scrollTimeReset: true 会把滚动拉回 scrollTime 06:00）。
    // 我们的事件总线会在任务变更时 reload（触发 FC 视图刷新），若开启 reset，
    // 用户向上滚动时间轴时会立刻被拉回 6:00，出现"抖动、滚不过去"。
    // 关闭后：滚动位置由用户掌控，仅初次进入/真正切换日期时才滚到 scrollTime。
    scrollTimeReset: false,
    // 开启事件拖拽 + 改时长；具体哪些事件可拖由 taskToEvent 写入的
    // event.startEditable / durationEditable（per-event）控制
    editable: true,
    // 显式开启 resize（默认 true，但显式设避免任何覆盖链路导致 undefined）：
    //   - eventDurationEditable：允许拖尾端改 end
    //   - eventStartEditable：允许拖拽移动（与 per-event startEditable 配合）
    //   - eventResizableFromStart：允许拖头端改 start（默认 false）
    eventDurationEditable: true,
    eventStartEditable: true,
    eventResizableFromStart: true,
    // 全天事件（daygrid）自定义 resize 手柄：FC v6 daygrid 不渲染原生 resizer，
    // 这里在事件挂载后注入自定义手柄 div，绑 mousedown 实现按天 resize
    eventDidMount: attachResizeHandles,
    // 单天任务在 dayGridMonth 上 hit area 很小，FC 默认要求长按 1s 才进 drag
    // 用户体验差：缩短到 200ms，几乎是"按下就能拖"
    // 多日任务 hit area 大，不会触发这个阈值，所以不冲突
    eventLongPressDelay: 200,
    // 不限制每天显示的事件数：月视图一天 4-5 个任务时不需要折叠成 "+N More"，
    // 格子会自动撑高（搭配 expandRows: true）
    dayMaxEventRows: false,
    // 关闭默认的点击/选择交互由父组件接管；eventClick 在 view 层配置
  };
}

// ─── 自定义 resize 手柄（全天事件用）─────────────────────
// FullCalendar v6 的 daygrid（月/年视图 + 周视图全天区）不渲染 resizer，
// 只有 timegrid 时间段事件才有。我们的任务都是全天事件，落在 daygrid，
// 所以没有原生 resize 手柄。
// 这里用 eventDidMount 注入两个自定义手柄 div（左=改 start、右=改 end），
// 绑 mousedown 自己实现按天 resize（参照 TimelineView 横条的 ew-resize 范式）。
// 命中区域：事件左右各 10px；hover 事件时手柄白色高亮（CSS 在 theme.css）。

/** resize 拖拽中的状态 */
interface ResizeState {
  /** 被拖的任务 id */
  taskId: string;
  /** 拖的是哪端 */
  edge: "start" | "end";
  /** 原开始日期（本地字面量） */
  origStart: string;
  /** 原结束日期（本地字面量） */
  origEnd: string;
  /** 事件 harness 元素（实时改宽度用） */
  harness: HTMLElement;
  /** harness 原始 style（mouseup 恢复用） */
  origHarnessStyle: string;
  /** 锚点日期（origStart 或 origEnd，计算位移的日期基准） */
  anchorDate: string;
  /** 鼠标按下时的 x 坐标（位移的像素基准——手柄在事件边缘，格子 left 作
   *  锚点会偏 1 格，导致预览条瞬间多长 1 格） */
  startX: number;
  /** 最后一次 mousemove 的有效 x 坐标（mouseup 用——鼠标可能在日历外松开，
   *  松手坐标不在格子上会导致 deltaDays 异常） */
  lastMoveX: number;
  /** 单元格宽度（px） */
  cellWidth: number;
}

let resizeState: ResizeState | null = null;
/** 拖拽预览气泡元素（实时显示目标日期） */
let previewTip: HTMLDivElement | null = null;

/** 实时更新事件横条宽度（视觉跟手）。
 *  FC daygrid harness 用 absolute 定位在起始格子内：
 *    - left: 0（默认）+ right: -N（负值，延伸到右边 N px）
 *    - 宽度 = cellWidth + N（harness 自适应）
 *  拖 end：改 right（更负=更长，往回收=更短）
 *  拖 start：改 left（起点移动），right 保持不变（右边缘不动）
 *    - 拖右（deltaDays>0，缩短）：left 增加 → 起点右移
 *    - 拖左（deltaDays<0，延长）：left 减少 → 起点左移
 *  deltaDays > 0 延长，< 0 缩短。 */
function previewBarWidth(st: ResizeState, deltaDays: number): void {
  const px = deltaDays * st.cellWidth;
  const origRight = parseFloat(st.origHarnessStyle.match(/right:\s*(-?[\d.]+)/)?.[1] ?? "0");
  const origLeft = parseFloat(st.origHarnessStyle.match(/left:\s*(-?[\d.]+)/)?.[1] ?? "0");
  if (st.edge === "end") {
    // 拖 end：right 联动（更负=更长）
    st.harness.style.right = (origRight - px) + "px";
  } else {
    // 拖 start：left 联动（起点移动），right 保持（右边缘不动）
    st.harness.style.left = (origLeft + px) + "px";
  }
}

/** 全天事件 resize：mousedown 手柄 → mousemove 实时预览（横条+文字）→ mouseup 写库 */
function onResizeHandleMouseDown(
  e: MouseEvent,
  taskId: string,
  edge: "start" | "end",
  getDates: () => { origStart: string; origEnd: string },
): void {
  e.preventDefault();
  e.stopPropagation();
  // mousedown 时从 FC 事件对象读最新日期（FC 数据更新后 DOM 复用、闭包过期，
  // 必须用 getEventById 保证 anchor 是拖拽前的最新值）
  const { origStart, origEnd } = getDates();
  // 找 harness 元素 + 锚点格子 + 单元格宽度
  const eventEl = (e.currentTarget as HTMLElement).closest(".fc-event") as HTMLElement | null;
  const harness = eventEl?.closest(".fc-daygrid-event-harness") as HTMLElement | null;
  if (!eventEl || !harness) return;
  // 锚点：用事件原始日期（不 hit-test，避免手柄在格子边缘时命中相邻格子）。
  // start 锚点 = origStart 那天；end 锚点 = origEnd 那天。
  const anchorDate = edge === "start" ? toIsoDate(origStart) : toIsoDate(origEnd);
  // 单元格宽度：优先取锚点格子；锚点日期不在当前视图（跨周/跨月事件）时
  // 兜底取任意可见格子，再不行用 200px。绝不能提前 return（否则拖不动）。
  const anchorCell = document.querySelector(`[data-date="${anchorDate}"]`) as HTMLElement | null;
  const anyCell = document.querySelector("[data-date]") as HTMLElement | null;
  const cellWidth = anchorCell?.offsetWidth ?? anyCell?.offsetWidth ?? 200;
  resizeState = {
    taskId, edge, origStart, origEnd,
    harness, origHarnessStyle: harness.getAttribute("style") ?? "",
    anchorDate, startX: e.clientX, lastMoveX: e.clientX, cellWidth,
  };
  // 拖拽中让事件横条 pointer-events:none，使 elementFromPoint 能穿透到下方日期格子
  eventEl.style.pointerEvents = "none";
  // 创建预览气泡（参照 TimelineView 横条的 .gantt__bar-tip）
  previewTip = document.createElement("div");
  previewTip.className = "jt-resizer-tip";
  document.body.appendChild(previewTip);
  // 双监听 pointer + mouse：不同浏览器对 pointerdown preventDefault 是否抑制
  // 兼容 mouse 事件行为不一（WKWebView 不抑制），都挂上保证后续移动/松开能收到
  document.addEventListener("pointermove", onResizeMouseMove);
  document.addEventListener("pointerup", onResizeMouseUp);
  document.addEventListener("mousemove", onResizeMouseMove);
  document.addEventListener("mouseup", onResizeMouseUp);
}

/** 用鼠标 x 坐标算位移天数（纯几何，不依赖 elementsFromPoint）。
 *  deltaDays = round((mouseX - startX) / cellWidth)。
 *  startX 是 mousedown 时鼠标 x（手柄位置），这样按下瞬间位移=0，
 *  移动 1 格 = 1 天。不受鼠标 y 坐标 / 事件遮挡影响。 */
function deltaDaysFromX(st: ResizeState, clientX: number): number {
  return Math.round((clientX - st.startX) / st.cellWidth);
}

/** 把锚点日期 + 位移天数 → 目标日期字面量 YYYY-MM-DD */
function targetDateFromDelta(st: ResizeState, deltaDays: number): string {
  const d = new Date(st.anchorDate + "T00:00:00");
  d.setDate(d.getDate() + deltaDays);
  return toIsoDate(d);
}

/** mousemove：实时改横条宽度 + 显示目标日期气泡 */
function onResizeMouseMove(e: MouseEvent): void {
  if (!resizeState || !previewTip) return;
  document.body.style.cursor = "ew-resize";
  // 记录最后有效位置（mouseup 可能在日历外，松手坐标不可靠）
  resizeState.lastMoveX = e.clientX;
  const deltaDays = deltaDaysFromX(resizeState, e.clientX);
  const targetDate = targetDateFromDelta(resizeState, deltaDays);
  // 实时改横条宽度（视觉跟手）
  previewBarWidth(resizeState, deltaDays);
  // 气泡跟随鼠标，显示目标日期 + 起止预览
  let text: string;
  if (resizeState.edge === "start") {
    text = `开始 → ${targetDate}\n（结束 ${toIsoDate(resizeState.origEnd)}）`;
  } else {
    text = `结束 → ${targetDate}\n（开始 ${toIsoDate(resizeState.origStart)}）`;
  }
  previewTip.textContent = text;
  previewTip.style.left = e.clientX + 14 + "px";
  previewTip.style.top = e.clientY + 14 + "px";
}

/** mouseup：用几何计算的目标日期写库（只更新被拖的一端） */
async function onResizeMouseUp(): Promise<void> {
  document.removeEventListener("pointermove", onResizeMouseMove);
  document.removeEventListener("pointerup", onResizeMouseUp);
  document.removeEventListener("mousemove", onResizeMouseMove);
  document.removeEventListener("mouseup", onResizeMouseUp);
  document.body.style.cursor = "";
  const st = resizeState;
  resizeState = null;
  previewTip?.remove();
  previewTip = null;
  if (!st) return;

  // 无条件恢复 pointer-events（mousedown 时设了 none，不恢复则事件再也点不动）。
  // 注意：**不恢复 harness 原始 style**——拖拽结束时 harness 已处于最终预览宽度，
  // 写库成功后 FC reload 会重渲染成新宽度；若在此恢复原始宽度，FC 重渲染前会
  // 闪出旧长条（"一瞬间变长又缩短"）。只有未拖 / 超范围 / 写库失败才需要恢复。
  const eventEl = st.harness.querySelector(".fc-event") as HTMLElement | null;
  if (eventEl) eventEl.style.pointerEvents = "";
  // 恢复 harness 原始 style（非写库路径：未拖、超范围钳制、写库失败）
  const restoreOriginal = (): void => {
    st.harness.setAttribute("style", st.origHarnessStyle);
  };

  // 用几何计算目标日期（不用 mouseup 坐标——鼠标可能在日历外松开，
  // 用最后一次 mousemove 的有效位置更可靠）
  const deltaDays = deltaDaysFromX(st, st.lastMoveX);
  if (deltaDays === 0) {
    restoreOriginal();
    return;
  }
  const targetDateStr = targetDateFromDelta(st, deltaDays);

  const taskStore = useTaskStore();
  try {
    if (st.edge === "start") {
      const targetDate = new Date(targetDateStr + "T00:00:00");
      const newStart = toLocalIso(targetDate);
      if (newStart > st.origEnd) {
        restoreOriginal();
        return;
      }
      await taskStore.updateTask(st.taskId, { dueStartAt: newStart });
    } else {
      const endOfDay = new Date(targetDateStr + "T00:00:00");
      endOfDay.setHours(23, 59, 59, 0);
      const newEnd = toLocalIso(endOfDay);
      if (newEnd < st.origStart) {
        restoreOriginal();
        return;
      }
      await taskStore.updateTask(st.taskId, { dueEndAt: newEnd });
    }
    if (taskStore.selectedTaskId === st.taskId) {
      taskStore.selectTask(null);
    }
  } catch (err) {
    restoreOriginal();
    console.error("[calendar resize] 更新失败:", err);
  }
}

/**
 * eventDidMount：给可拖的全天事件注入自定义 resize 手柄。
 * - 不可拖（已完成/子任务）跳过
 * - 全天事件（daygrid）才需要（timegrid 时间段事件有 FC 原生 resizer）
 */
export function attachResizeHandles(arg: EventMountArg): void {
  const { el, event, view } = arg;
  const done = event.extendedProps?.done ?? false;
  const parentId = event.extendedProps?.parentId ?? null;
  // 已完成 / 子任务不可 resize（与可拖规则一致）
  if (done || parentId) return;
  // 从 extendedProps 读原始 DB 日期（避开 FC 全天 end 排他转换）
  const startLiteral = event.extendedProps?.origStart;
  const endLiteral = event.extendedProps?.origEnd;
  if (!startLiteral || !endLiteral) return;

  // FC 事件数据更新（拖拽写库 → reload）后 eventDidMount 不会重新触发（DOM 复用），
  // 闭包里缓存的日期会过期——第二次拖拽会拿旧 anchor 日期，天数算错。
  // 因此不把日期写死进闭包：每次 mousedown 时从 FC 事件对象实时读最新值
  // （getEventById 返回的是 FC 内部事件存储的最新数据），读不到才兜底闭包值。
  const getDates = (): { origStart: string; origEnd: string } => {
    const latest = view.calendar.getEventById(event.id);
    const ep = latest?.extendedProps ?? {};
    if (ep.origStart && ep.origEnd) {
      return { origStart: ep.origStart, origEnd: ep.origEnd };
    }
    return { origStart: startLiteral, origEnd: endLiteral };
  };

  // 左手柄（改 start）
  const startHandle = document.createElement("div");
  startHandle.className = "jt-resizer-handle jt-resizer-handle--start";
  bindResizeHandle(startHandle, event.id, "start", getDates);
  el.appendChild(startHandle);

  // 右手柄（改 end）
  const endHandle = document.createElement("div");
  endHandle.className = "jt-resizer-handle jt-resizer-handle--end";
  bindResizeHandle(endHandle, event.id, "end", getDates);
  el.appendChild(endHandle);
}

/** 给 resize 手柄绑定启动逻辑。
 *  FC 的 interaction 插件用 PointerDragging 监听 **pointerdown**（不是 mousedown），
 *  绑在事件元素 .fc-event-draggable 上。手柄在其内部，pointerdown 会冒泡触发
 *  FC 整体移动（eventDrop）。
 *  因此手柄必须在 capture 阶段拦截 pointerdown（stopImmediatePropagation 阻止
 *  传播到 FC 的 document 监听）+ preventDefault，并自行启动 resize。
 *  兼容不支持 Pointer Events 的环境：mousedown 同样处理（防重复启动用标志）。
 *  @param getDates mousedown 时取最新日期的回调（从 FC 事件对象实时读，
 *                  避免 FC 复用 DOM 时闭包日期过期） */
function bindResizeHandle(
  handle: HTMLElement,
  taskId: string,
  edge: "start" | "end",
  getDates: () => { origStart: string; origEnd: string },
): void {
  const start = (e: MouseEvent): void => {
    // 无论是否已启动 resize，都必须拦截传播 + 阻止默认——
    // 真实浏览器中 pointerdown 之后还会派发兼容的 mousedown，
    // 若此时直接 return 而不拦截，mousedown 会冒泡到 .fc 根触发 FC 整体拖拽。
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    // 防重复启动：pointerdown + mousedown 双触发时第二次跳过。
    // 不能用闭包标志（FC reload 复用事件元素时闭包残留 true，第二次拖不动），
    // 用全局 resizeState（mouseup 后置 null）判断。
    if (resizeState) return;
    onResizeHandleMouseDown(e, taskId, edge, getDates);
  };
  // capture + stopImmediatePropagation：在 FC 的 document pointerdown 监听之前拦截
  handle.addEventListener("pointerdown", start, true);
  handle.addEventListener("mousedown", start, true);
}


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

/** 订阅任务变更（卸载时需调用返回的取消函数）。TimelineView 等非日历视图也用此刷新 */
export function subscribeTaskChanged(fn: TaskChangedListener): () => void {
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

  /**
   * 当前视图标题（由 datesSet 钩子写入，来自 FC 原生 view.title）。
   * 配合 zh-cn locale 输出中文（如 "2026年7月" / "2026年7月13日 - 19日"），
   * 跳转 / 翻页 / 点今天后自动同步，无需各视图手写格式化。
   */
  const title = ref<string>("");

  /** FC datesSet 回调参数类型（含 view.title） */
  interface DatesSetArg {
    start: Date;
    end: Date;
    view: { title: string };
  }

  function handleDatesSet(arg: DatesSetArg): void {
    currentRange.value = { start: arg.start, end: arg.end };
    title.value = arg.view.title;
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

  return { events, status, error, currentRange, title, loadRange, reload, handleDatesSet, applySelection };
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
 *   5. 写库成功后若拖到可视范围外（如月视图拖到下个月），调 api.gotoDate 跳到新位置
 *      触发 datesSet → handleDatesSet 自动 reload 新 range，让事件被 SQL 查到
 *      （否则按当前 range 查询会漏掉新位置的事件）
 *
 * @param getApi 可选：返回 FullCalendar API；用于拖到 range 外时跳转可视范围
 *
 * 静默成功，不弹任何提示。
 */
export async function onCalendarEventChange(info: {
  event: {
    id: string;
    start: Date | null;
    end: Date | null;
    extendedProps?: { done?: boolean; parentId?: string | null };
  };
  oldEvent: { start: Date | null; end: Date | null };
  revert: () => void;
}, getApi?: () => CalendarApi | null): Promise<void> {
  const { event, oldEvent, revert } = info;
  // start 必须存在（拖拽/缩放都会产生新 start）；end 可能为 null：
  //   - 任务本身是开放区间（DB dueEndAt 为 null）
  //   - 或 DB 里 end ≤ start（倒挂），FC 解析时会丢弃 end（core parseSingle line 2096）
  // 此时不能简单 revert，否则用户看到"拖动了但时间没变"。
  if (!event.start || !oldEvent.start) {
    revert();
    return;
  }
  // 直接用 event 自带的 extendedProps 校验可拖（不依赖 taskStore.currentTasks）
  // 日历视图的事件不在任何清单的 currentTasks 里，从 store 查会得到 undefined → 误 revert
  const done = event.extendedProps?.done ?? false;
  const parentId = event.extendedProps?.parentId ?? null;
  if (done || parentId) {
    revert();
    return;
  }
  // 把 FC 的 start / end 规范成本地 Date（FC v6 对全天事件可能给 Date 或
  // "YYYY-MM-DD" 字符串；时间段一定是 Date；统一处理）
  const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
  const startDate = toDate(event.start);

  // 计算新的 dueEndAt：
  //   - oldEvent.end 为 null（FC 丢弃了 end）：保持任务的 end 不变（传 undefined 跳过更新）
  //     这样倒挂数据/开放区间任务至少 start 能被正确拖动
  //   - oldEvent.end 存在：end 平移同样的 delta，并按全天语义回退一天（FC end 排他）
  let newEnd: string | undefined;
  if (event.end && oldEvent.end) {
    const endDate = toDate(event.end);
    const oldEndDate = toDate(oldEvent.end);
    // 判断是否全天：两端时间分量都是 0:00（FC 全天事件 start/end 都是当天 0:00）
    const isAllDay =
      startDate.getHours() === 0 &&
      startDate.getMinutes() === 0 &&
      oldEndDate.getHours() === 0 &&
      oldEndDate.getMinutes() === 0;
    // FC 全天事件 end 是排他的（= lastDay + 1），我们的字面量是"含端点"，回退一天
    let endForDb = endDate;
    if (isAllDay) {
      const prev = new Date(endDate);
      prev.setDate(prev.getDate() - 1);
      endForDb = prev;
    }
    newEnd = toLocalIso(endForDb);
  }
  const newStart = toLocalIso(startDate);
  const taskStore = useTaskStore();
  try {
    // 只传需要更新的字段；end 为空时仅更新 start
    const patch: { dueStartAt: string; dueEndAt?: string } = { dueStartAt: newStart };
    if (newEnd !== undefined) patch.dueEndAt = newEnd;
    await taskStore.updateTask(event.id, patch);
    // 拖拽成功 → 关闭详情面板（避免面板里"原日期"和新位置不一致造成认知负担）
    if (taskStore.selectedTaskId === event.id) {
      taskStore.selectTask(null);
    }
    // 拖到可视范围外时跳转 FC 视图，触发 datesSet → handleDatesSet reload 新 range
    // 解决"按当前 range SQL 漏查新位置事件"导致的事件消失问题
    //
    // 注意：判断"是否在可视范围"必须同时考虑 start 和 end，不能只看 start。
    // eventResize（拖尾部改 end）时 start 不变，用户可能已切到 end 所在的那一周，
    // 若只判断 start，会把"start 不在当前周"误判为拖出范围，导致跳回 start 那周
    // （用户看到"改完 end 后页面跳回开始的周"）。
    // 只有整个任务（start 和 end 都）不在可视范围时才需要跳转。
    const api = getApi?.();
    if (api) {
      const view = api.view;
      const startInRange =
        startDate >= view.currentStart && startDate < view.currentEnd;
      // end 可能不存在（开放区间/倒挂数据被 FC 丢弃），此时只用 start 判断
      const endInRange =
        event.end !== null &&
        toDate(event.end) >= view.currentStart &&
        toDate(event.end) < view.currentEnd;
      if (!startInRange && !endInRange) {
        api.gotoDate(startDate);
      }
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
