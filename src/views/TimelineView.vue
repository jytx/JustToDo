<script setup lang="ts">
// 时间线（甘特图）视图 —— 横轴=连续日期，每任务一行，横条按起止日期定位。
// 支持拖拽横条平移改日期、拖边缘改时长、点击看详情、点击空白建任务、天/周/月缩放。
// 只显示有日期的任务；颜色按优先级。
import { ref, computed, reactive, onMounted, onBeforeUnmount, watch } from "vue";
import { useTaskStore } from "@/stores/task";
import { getTasksByDueRange } from "@/api/db";
import type { Task, Priority } from "@/types";
import { parseLocalIso, dateToLocalIso } from "@/utils/date";
import { subscribeTaskChanged } from "@/composables/useCalendarView";
import { useBatchSelect } from "@/composables/useBatchSelect";
import { getViewPref, setViewPref } from "@/composables/useViewPrefs";
import MenuPopover from "@/components/MenuPopover.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";

const props = defineProps<{ id: string }>();

const taskStore = useTaskStore();
const { batchCtxMenu, onTaskRowSelect, onBatchContextMenu } = useBatchSelect();

/** 缩放粒度：day=每天一列，week=每周一列，month=每月一列 */
type Zoom = "day" | "week" | "month";
const zoom = ref<Zoom>("day");

/** 可视范围的起始日期（滚动到左边缘时往前扩展，初始为今天前 7 天） */
const rangeStart = ref<Date>(addDays(startOfDay(new Date()), -7));
/** 可视范围的列数（滚动到右边缘时往后扩展） */
const rangeCount = ref<number>(42);

/** 缩放对应的初始列数 */
const INITIAL_COUNT: Record<Zoom, number> = { day: 42, week: 16, month: 12 };

/** 各缩放的每列宽度（px）。day 每天一列 60px；week 每周一列 140px；
 *  month 每月一列 180px——列越宽代表的时间越长，避免挤在一起看不清 */
const COL_WIDTH_BY_ZOOM: Record<Zoom, number> = { day: 90, week: 200, month: 280 };

/** 当前缩放的每列宽度 */
const COL_WIDTH = computed(() => COL_WIDTH_BY_ZOOM[zoom.value]);

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 生成日期列数组（从 rangeStart 开始，共 rangeCount 列） */
const columns = computed(() => {
  const cols: { date: Date; label: string; sub: string; weekend: boolean; today: boolean }[] = [];
  const today = new Date();
  for (let i = 0; i < rangeCount.value; i++) {
    const d = columnStartDate(rangeStart.value, i);
    const next = columnStartDate(d, 1); // 本列跨度终点（排他）
    cols.push({
      date: d,
      label: columnLabel(d, zoom.value),
      sub: columnSub(d, zoom.value),
      weekend: zoom.value === "day" && (d.getDay() === 0 || d.getDay() === 6),
      // day 模式精确到天；week/month 判断今天是否落在该列跨度内
      today: today >= d && today < next,
    });
  }
  return cols;
});

/** 可视范围对应的字面量（用于 getTasksByDueRange） */
const rangeLiteral = computed(() => {
  const first = columns.value[0]?.date ?? rangeStart.value;
  const last = columns.value[columns.value.length - 1]?.date ?? rangeStart.value;
  return {
    start: toISO(first),
    end: toISO(addDays(last, columnSpanDays(zoom.value))),
  };
});

/** 加载范围内的任务（按当前清单过滤）。
 *  注意：不按 due_start_at 排序——拖拽改日期后行顺序应保持不变
 *  （只移动横条，不重排行），用 sort_order 保持稳定顺序。 */
/** 是否显示已完成任务（false 时只加载未完成）—— 从清单偏好恢复初始值 */
const showCompleted = ref<boolean>(getViewPref(props.id).showCompleted);

/** 任务列表更多菜单开关 */
const moreMenuOpen = ref(false);

/** 切换显示/隐藏已完成 + 持久化到清单偏好 */
function toggleShowCompleted(): void {
  showCompleted.value = !showCompleted.value;
  setViewPref(props.id, { showCompleted: showCompleted.value });
  moreMenuOpen.value = false;
}

// ─── 任务行垂直拖拽排序（专用手柄触发，改 sort_order） ───
/** 正在被拖动的任务 id */
const rowDragId = ref<string | null>(null);
/** 落点：目标行 id + 位置（before/after） */
const rowDropTarget = ref<{ id: string; pos: "before" | "after" } | null>(null);

/** 手柄 dragstart：记录被拖任务 */
function onRowDragStart(e: DragEvent, taskId: string): void {
  rowDragId.value = taskId;
  e.dataTransfer!.effectAllowed = "move";
  e.dataTransfer!.setData("text/plain", taskId);
}

/** 行 dragover：preventDefault 允许 drop + 按 clientY 中点算落点 */
function onRowDragOver(e: DragEvent, taskId: string): void {
  if (!rowDragId.value || rowDragId.value === taskId) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const pos: "before" | "after" = e.clientY - rect.top < rect.height / 2 ? "before" : "after";
  rowDropTarget.value = { id: taskId, pos };
}

/** 行 dragleave：清落点高亮（仅真正离开时） */
function onRowDragLeave(e: DragEvent, taskId: string): void {
  const related = e.relatedTarget as HTMLElement | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  if (rowDropTarget.value?.id === taskId) rowDropTarget.value = null;
}

/** 行 drop：重排 tasks 数组 + 持久化 sort_order */
async function onRowDrop(): Promise<void> {
  const dragId = rowDragId.value;
  const target = rowDropTarget.value;
  if (!dragId || !target || dragId === target.id) {
    clearRowDrag();
    return;
  }
  // 重排本地 tasks 数组
  const ids = tasks.value.map((t) => t.id).filter((id) => id !== dragId);
  const targetIdx = ids.indexOf(target.id);
  if (targetIdx === -1) { clearRowDrag(); return; }
  const insertIdx = target.pos === "before" ? targetIdx : targetIdx + 1;
  ids.splice(insertIdx, 0, dragId);
  // 按新顺序重建 tasks（保持 Task 对象）
  const map = new Map(tasks.value.map((t) => [t.id, t]));
  tasks.value = ids.map((id) => map.get(id)).filter((t): t is Task => !!t);
  clearRowDrag();
  // 持久化（含当前清单其他未在时间线显示的任务，persistTaskOrder 内部会处理全量重排）
  await taskStore.persistTaskOrder(ids);
}

/** 手柄 dragend：清状态 */
function onRowDragEnd(): void {
  clearRowDrag();
}

function clearRowDrag(): void {
  rowDragId.value = null;
  rowDropTarget.value = null;
}

/** 加载范围内的任务（按当前清单过滤）。
 *  注意：不按 due_start_at 排序——拖拽改日期后行顺序应保持不变
 *  （只移动横条，不重排行），用 sort_order 保持稳定顺序。 */
const tasks = ref<Task[]>([]);
async function loadTasks(): Promise<void> {
  const { start, end } = rangeLiteral.value;
  const all = await getTasksByDueRange(start, end, showCompleted.value);
  tasks.value = all
    .filter((t) => t.listId === props.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

onMounted(() => {
  void loadTasks();
  // 初始滚动到今天附近
  requestAnimationFrame(scrollToToday);
});
watch([rangeStart, rangeCount, zoom, () => props.id, showCompleted], loadTasks);
// 切换清单时从偏好恢复 showCompleted
watch(() => props.id, (newId) => {
  showCompleted.value = getViewPref(newId).showCompleted;
});

// 订阅任务变更（标题/时间/完成等修改后刷新，与其他视图的 notifyTaskChanged 总线联动）
const unsubscribe = subscribeTaskChanged(() => { void loadTasks(); });
onBeforeUnmount(unsubscribe);

// ─── 日期工具（纯函数） ───
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function toISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 缩放粒度下，第 index 列的开始日期 */
function columnStartDate(anchor: Date, index: number): Date {
  if (zoom.value === "day") return addDays(anchor, index);
  if (zoom.value === "week") return addDays(anchor, index * 7);
  // month
  return new Date(anchor.getFullYear(), anchor.getMonth() + index, 1);
}
/** 一列跨越的天数（用于 range end 计算 + 横条宽度） */
function columnSpanDays(z: Zoom): number {
  if (z === "day") return 1;
  if (z === "week") return 7;
  return 31; // month 近似
}
function columnLabel(d: Date, z: Zoom): string {
  if (z === "day") return `${d.getMonth() + 1}/${d.getDate()}`;
  if (z === "week") return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getMonth() + 1}月`;
}
function columnSub(d: Date, z: Zoom): string {
  if (z === "day") {
    const w = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    return `周${w}`;
  }
  if (z === "week") return "";
  return `${d.getFullYear()}`;
}

/** 工具栏标题 */
const toolbarTitle = computed(() => {
  const first = columns.value[0]?.date;
  const last = columns.value[columns.value.length - 1]?.date;
  if (!first || !last) return "";
  return `${first.getFullYear()}年${first.getMonth() + 1}月`;
});

/** 前/后/今天导航（平移可视范围，保持列数） */
function goPrev(): void {
  rangeStart.value = columnStartDate(rangeStart.value, -7);
}
function goNext(): void {
  rangeStart.value = columnStartDate(rangeStart.value, 7);
}
function goToday(): void {
  // 重置范围：让今天落在范围中间偏左，各缩放按列数前移（day 前移7天≈7列，
  // week 前移4列=4周，month 前移4列=4月），避免今天贴在开头无法居中
  const leadCols = zoom.value === "day" ? 7 : 4;
  rangeStart.value = columnStartDate(startOfDay(new Date()), -leadCols);
  rangeCount.value = INITIAL_COUNT[zoom.value];
  requestAnimationFrame(scrollToToday);
}

/** 滚动到今天所在位置 */
function scrollToToday(): void {
  const el = timelineScrollEl.value;
  if (!el) return;
  const firstCol = columns.value[0]?.date;
  if (!firstCol) return;
  // 算今天落在第几列（week/month 一列跨多天，不能直接用天数偏移）
  const today = new Date();
  let colIndex = -1;
  for (let i = 0; i < columns.value.length; i++) {
    const colStart = columns.value[i].date;
    const colEnd = columnStartDate(colStart, 1); // 下一列起点 = 本列终点（排他）
    if (today >= colStart && today < colEnd) {
      colIndex = i;
      break;
    }
  }
  if (colIndex === -1) {
    // 今天不在当前列范围（理论上 goToday 会重置范围，兜底用天数近似）
    const offset = daysBetween(firstCol, today);
    el.scrollLeft = Math.max(0, offset * dayWidth() - el.clientWidth / 2);
    return;
  }
  // 滚动到今天所在列居中
  el.scrollLeft = colIndex * COL_WIDTH.value - el.clientWidth / 2 + COL_WIDTH.value / 2;
}

/** 时间轴滚动容器 ref */
const timelineScrollEl = ref<HTMLElement | null>(null);
/** 左侧任务列滚动容器 ref */
const tasksScrollEl = ref<HTMLElement | null>(null);

/** 垂直滚动同步锁：同步对端 scrollTop 时置 true，避免 A→B→A 递归触发 */
let syncingScroll = false;
/** 把 source 的 scrollTop 同步给 target（仅垂直方向，横向各自独立） */
function syncVerticalScroll(source: HTMLElement, target: HTMLElement): void {
  if (syncingScroll) return;
  syncingScroll = true;
  target.scrollTop = source.scrollTop;
  syncingScroll = false;
}
/** 左侧任务列 scroll → 同步右侧时间轴的垂直滚动 */
function onTasksScroll(): void {
  const src = tasksScrollEl.value;
  const dst = timelineScrollEl.value;
  if (src && dst) syncVerticalScroll(src, dst);
}

/** 滚动到边缘时扩展范围（无限滚动） */
const EDGE_THRESHOLD = 200; // 距边缘 200px 触发扩展
function onTimelineScroll(): void {
  const el = timelineScrollEl.value;
  if (!el) return;
  // 垂直同步：把右侧的 scrollTop 反向同步给左侧任务列
  const tasks = tasksScrollEl.value;
  if (tasks) syncVerticalScroll(el, tasks);
  const nearLeft = el.scrollLeft < EDGE_THRESHOLD;
  const nearRight = el.scrollLeft + el.clientWidth > el.scrollWidth - EDGE_THRESHOLD;
  if (nearLeft) {
    // 往前扩展 14 列，同步调整 rangeStart 并保持滚动位置（视觉不跳）
    const extendCols = 14;
    rangeStart.value = columnStartDate(rangeStart.value, -extendCols);
    rangeCount.value += extendCols;
    // rangeStart 前移后列整体右移，需要把 scrollLeft 加上扩展的宽度避免画面跳动
    requestAnimationFrame(() => {
      el.scrollLeft += extendCols * COL_WIDTH.value;
    });
  } else if (nearRight) {
    // 往后扩展 14 列
    rangeCount.value += 14;
  }
}

/** 任务 → 横条样式（left/width 基于 day 缩放下的列偏移）。
 *  横条按"天"对齐（截断时刻），不因非 00:00 时刻偏移导致跨入前一天。 */
function barStyle(task: Task): { left: number; width: number } | null {
  const startRaw = parseLocalIso(task.dueStartAt);
  if (!startRaw) return null;
  // end 缺失时用 start 兜底（单点任务，横条占一天）
  const endRaw = parseLocalIso(task.dueEndAt) ?? startRaw;
  const firstColDate = columns.value[0]?.date;
  if (!firstColDate) return null;
  // 截断到天（忽略时分秒），保证横条按整天对齐，不因时刻跨日前一天
  const startDay = new Date(startRaw.getFullYear(), startRaw.getMonth(), startRaw.getDate());
  const endDay = new Date(endRaw.getFullYear(), endRaw.getMonth(), endRaw.getDate());
  const dayWidth = zoom.value === "day" ? COL_WIDTH.value : COL_WIDTH.value / columnSpanDays(zoom.value);
  const startOffset = daysBetween(firstColDate, startDay);
  const endOffset = daysBetween(firstColDate, endDay);
  // 宽度按"两端包含整天"计算（如 7/31~8/3 占满 4 列）。-2 留右侧视觉间隙；
  // 配合 .gantt__bar 的 border-box，width 含 padding，物理宽度精确不溢出到下一列
  const left = startOffset * dayWidth;
  const width = Math.max(dayWidth, (endOffset - startOffset + 1) * dayWidth - 2);
  return { left: Math.max(0, left), width };
}

/** 横条实际渲染样式：静态用 barStyle，拖拽中按模式叠加反馈
 *  - move：translateX(dx) 跟手平移（left/width 不变）
 *  - resize-start/end：重算 left/width（按预览日期），让边缘跟手伸缩 */
function dragBarStyle(task: Task): Record<string, string> {
  const base = barStyle(task);
  const color = PRIO_COLOR[task.priority ?? 0];
  const ds = dragState.value;
  if (!base || !ds || ds.taskId !== task.id) {
    return {
      left: (base?.left ?? 0) + "px",
      width: (base?.width ?? 0) + "px",
      backgroundColor: color,
    };
  }
  // 拖拽中
  if (ds.mode === "move") {
    return {
      left: base.left + "px",
      width: base.width + "px",
      backgroundColor: color,
      transform: `translateX(${ds.dx}px)`,
      cursor: "grabbing",
    };
  }
  // resize：按预览日期重算 left/width
  const dw = dayWidth();
  const firstCol = columns.value[0]?.date;
  if (!firstCol) return { left: base.left + "px", width: base.width + "px", backgroundColor: color };
  const origStart = parseLocalIso(ds.origStart) ?? new Date();
  const origEnd = parseLocalIso(ds.origEnd) ?? origStart;
  let newStart = origStart;
  let newEnd = origEnd;
  if (ds.mode === "resize-start") {
    newStart = addDays(origStart, ds.deltaDays);
    if (daysBetween(newStart, origEnd) < 0) newStart = origEnd;
  } else {
    newEnd = addDays(origEnd, ds.deltaDays);
    if (daysBetween(origStart, newEnd) < 0) newEnd = origStart;
  }
  const left = Math.max(0, daysBetween(firstCol, newStart) * dw);
  const span = daysBetween(newStart, newEnd);
  const width = Math.max(dw, (span + 1) * dw - 2);
  return { left: left + "px", width: width + "px", backgroundColor: color, cursor: "ew-resize" };
}

/** 两个日期的天数差（含端点：a=8/1, b=8/3 → 2） */
function daysBetween(a: Date, b: Date): number {
  const ms = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
    Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  return Math.round(ms / 86400000);
}

/** 今日竖线的 left（按天数偏移） */
const todayLeft = computed(() => {
  const firstColDate = columns.value[0]?.date;
  if (!firstColDate) return 0;
  const dayWidth = zoom.value === "day" ? COL_WIDTH.value : COL_WIDTH.value / columnSpanDays(zoom.value);
  const today = new Date();
  return daysBetween(firstColDate, today) * dayWidth;
});

/** 优先级 → 色值 */
const PRIO_COLOR: Record<Priority, string> = {
  0: "#9CA3AF",
  1: "#3B82F6",
  2: "#F59E0B",
  3: "#EF4444",
};

// ─── 交互 ───
/** 点击任务行/横条 → 转发给 onTaskRowSelect 处理修饰键（Shift/Cmd 多选、普通单选） */
function onBarClick(task: Task, e: MouseEvent): void {
  // 拖拽刚结束（wasDragging）→ 不触发，避免拖拽误触
  if (wasDragging) {
    wasDragging = false;
    return;
  }
  onTaskRowSelect(task.id, e);
}

/** 点击复选框切换完成状态 */
function onToggle(task: Task): void {
  taskStore.toggleTask(task.id, !task.done);
}

/** 点击空白格 → 在该日期建任务（归属当前清单） */
/** 双击空白格 → 在该日期建任务（单击不建，避免误触） */
async function onCellDblClick(colDate: Date): Promise<void> {
  const dayLiteral = `${toISO(colDate)}T00:00:00`;
  const created = await taskStore.createTask({
    title: "",
    listId: props.id,
    dueStartAt: dayLiteral,
    dueEndAt: dayLiteral,
  });
  taskStore.selectTask(created.id);
}

/** 单击空白格 → 仅取消选中（不建任务） */
function onCellClick(): void {
  if (taskStore.selectedTaskId) taskStore.selectedTaskId = null;
}

// ─── 右键菜单（参照 TaskListItem 的菜单项） ───
const ctxMenu = reactive<{ visible: boolean; x: number; y: number; taskId: string }>({
  visible: false,
  x: 0,
  y: 0,
  taskId: "",
});

/** 任务行右键：多选模式下走批量菜单，否则弹单任务菜单 */
function onTaskContextMenu(e: MouseEvent, task: Task): void {
  // 多选模式：右键的任务若未选中则先加入选中集合，关单任务菜单，让事件冒泡弹批量菜单
  if (taskStore.batchMode) {
    if (!taskStore.isBatchSelected(task.id)) {
      taskStore.toggleBatchSelect(task.id);
    }
    ctxMenu.visible = false;
    return; // 不 stop，冒泡到 .timeline 的 onBatchContextMenu 弹批量菜单
  }
  e.preventDefault();
  e.stopPropagation();
  ctxMenu.taskId = task.id;
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.visible = true;
}

/** 新建任务（与当前任务同清单，空标题 + 选中打开详情） */
async function onCtxAddTask(): Promise<void> {
  const task = tasks.value.find((t) => t.id === ctxMenu.taskId);
  ctxMenu.visible = false;
  const created = await taskStore.createTask({
    title: "",
    listId: props.id,
    groupId: task?.groupId ?? undefined,
  });
  taskStore.selectTask(created.id);
}

/** 删除任务（走 store 的删除确认弹窗） */
function onCtxDelete(): void {
  const id = ctxMenu.taskId;
  ctxMenu.visible = false;
  taskStore.requestDelete(id);
}

/** 进入多选模式（选中当前任务） */
function onCtxBatchSelect(): void {
  ctxMenu.visible = false;
  taskStore.toggleBatchSelect(ctxMenu.taskId);
}

/** 缩放切换 */
function setZoom(z: Zoom): void {
  zoom.value = z;
  // 切缩放时重置范围到今天前后
  rangeStart.value = addDays(startOfDay(new Date()), -7);
  rangeCount.value = INITIAL_COUNT[z];
  requestAnimationFrame(scrollToToday);
}

// ─── 拖拽改日期/时长（横条平移 + 边缘拖拽） ───
/** 本次 mousedown→mouseup 期间是否真正发生了拖拽（用于区分点击） */
let wasDragging = false;

const dragState = ref<{
  taskId: string;
  mode: "move" | "resize-start" | "resize-end";
  startX: number;
  origStart: string;
  origEnd: string;
  /** 拖拽中的实时偏移（px） */
  dx: number;
  /** 拖拽中实时的天数变化（dx / dayWidth，四舍五入） */
  deltaDays: number;
} | null>(null);

/** 当前缩放下一天的像素宽度 */
function dayWidth(): number {
  return zoom.value === "day" ? COL_WIDTH.value : COL_WIDTH.value / columnSpanDays(zoom.value);
}

/** hover 时按鼠标位置切 cursor：边缘 ew-resize（调整时长），中间 grab（移动）；
 *  拖拽中按模式显示 grabbing / ew-resize */
function onBarMouseMove(e: MouseEvent, task: Task): void {
  if (task.done) return;
  const el = e.currentTarget as HTMLElement;
  // 拖拽中：cursor 由 dragState.mode 决定（已在 CSS .gantt__bar--dragging 处理，这里不覆盖）
  if (dragState.value?.taskId === task.id) return;
  const rect = el.getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  el.style.cursor = offsetX < 10 || offsetX > rect.width - 10 ? "ew-resize" : "grab";
}

function onBarMouseDown(e: MouseEvent, task: Task): void {
  if (task.done) return;
  wasDragging = false;
  // 边缘 10px 内 → resize，否则 move（10px 比原来 6px 更易抓取）
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  const mode = offsetX < 10 ? "resize-start" : offsetX > rect.width - 10 ? "resize-end" : "move";
  dragState.value = {
    taskId: task.id,
    mode,
    startX: e.clientX,
    origStart: task.dueStartAt ?? "",
    origEnd: task.dueEndAt ?? "",
    dx: 0,
    deltaDays: 0,
  };
  e.preventDefault();
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

/** 拖拽中实时更新 dx + deltaDays，驱动横条 transform/宽度跟随鼠标 */
function onMouseMove(e: MouseEvent): void {
  if (!dragState.value) return;
  const dx = e.clientX - dragState.value.startX;
  // 移动超过 4px 视为真正拖拽（区分点击：避免拖拽误触详情面板）
  if (Math.abs(dx) > 4) wasDragging = true;
  const deltaDays = Math.round(dx / dayWidth());
  dragState.value = { ...dragState.value, dx, deltaDays };
}

/** 计算拖拽预览的起止日期（move/resize 三种模式，纯函数，拖拽中实时调用） */
function previewDates(ds: { mode: string; origStart: string; origEnd: string; deltaDays: number }): { start: Date; end: Date } | null {
  const origStart = parseLocalIso(ds.origStart);
  if (!origStart) return null;
  const origEnd = parseLocalIso(ds.origEnd) ?? origStart;
  const d = ds.deltaDays;
  if (ds.mode === "move") {
    return { start: addDays(origStart, d), end: addDays(origEnd, d) };
  }
  if (ds.mode === "resize-start") {
    const newStart = addDays(origStart, d);
    if (daysBetween(newStart, origEnd) < 0) return { start: origEnd, end: origEnd };
    return { start: newStart, end: origEnd };
  }
  // resize-end
  const newEnd = addDays(origEnd, d);
  if (daysBetween(origStart, newEnd) < 0) return { start: origStart, end: origStart };
  return { start: origStart, end: newEnd };
}

/** 格式化日期为 M/D 显示（拖拽提示气泡用） */
function fmtDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 拖拽中的预览日期文本（供提示气泡显示） */
const dragPreviewText = computed<string | null>(() => {
  if (!dragState.value) return null;
  const pv = previewDates(dragState.value);
  if (!pv) return null;
  return pv.start.getTime() === pv.end.getTime()
    ? fmtDate(pv.start)
    : `${fmtDate(pv.start)} ~ ${fmtDate(pv.end)}`;
});

async function onMouseUp(): Promise<void> {
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
  const ds = dragState.value;
  if (!ds || ds.deltaDays === 0) {
    // 无变化：直接清空 dragState，横条回到原位
    dragState.value = null;
    return;
  }
  const pv = previewDates(ds);
  if (!pv) {
    dragState.value = null;
    return;
  }
  // 先持久化更新 task 日期
  await taskStore.updateTask(ds.taskId, {
    dueStartAt: keepTime(ds.origStart, pv.start),
    dueEndAt: keepTime(ds.origEnd ?? ds.origStart, pv.end),
  });
  // 乐观更新本地 tasks：直接改这个 task 的日期，让 barStyle 立即用新日期，
  // 避免清空 dragState 后横条用旧日期回弹（tasks ref 要等 loadTasks 才更新）
  const newStartLit = keepTime(ds.origStart, pv.start);
  const newEndLit = keepTime(ds.origEnd ?? ds.origStart, pv.end);
  tasks.value = tasks.value.map((t) =>
    t.id === ds.taskId ? { ...t, dueStartAt: newStartLit, dueEndAt: newEndLit } : t,
  );
  // 数据已更新，清空 dragState 后横条用 barStyle 直接停在新位置，无回弹
  dragState.value = null;
  // 若新日期移出当前可视范围，调整 anchor 让任务保持可见
  if (!isDateInRange(pv.start)) {
    ensureVisible(pv.start);
    await loadTasks();
  }
}

/** 判断日期是否在当前可视列范围内 */
function isDateInRange(date: Date): boolean {
  const first = columns.value[0]?.date;
  const last = columns.value[columns.value.length - 1]?.date;
  if (!first || !last) return true;
  return date >= first && date <= last;
}

/** 确保给定日期在当前可视范围内，否则把 anchor 调整到能容纳它的位置 */
function ensureVisible(date: Date): void {
  const first = columns.value[0]?.date;
  const last = columns.value[columns.value.length - 1]?.date;
  if (!first || !last) return;
  if (date >= first && date <= last) return; // 在范围内，无需调整
  // 移出范围：扩展 rangeStart/rangeCount 让任务进入视野
  if (date < first) {
    // 往前扩展
    const extendCols = Math.ceil(daysBetween(date, first) / columnSpanDays(zoom.value)) + 7;
    rangeStart.value = columnStartDate(rangeStart.value, -extendCols);
    rangeCount.value += extendCols;
  } else {
    // 往后扩展
    const extendCols = Math.ceil(daysBetween(last, date) / columnSpanDays(zoom.value)) + 7;
    rangeCount.value += extendCols;
  }
}

/** 保持原字面量的时间部分，只换日期 */
function keepTime(origLiteral: string, newDate: Date): string {
  const orig = parseLocalIso(origLiteral);
  if (!orig) return dateToLocalIso(newDate);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${newDate.getFullYear()}-${pad(newDate.getMonth() + 1)}-${pad(newDate.getDate())}` +
    `T${pad(orig.getHours())}:${pad(orig.getMinutes())}:${pad(orig.getSeconds())}`;
}

/** 时间轴容器宽度 */
const timelineWidth = computed(() => columns.value.length * COL_WIDTH.value);
</script>

<template>
  <!-- 根容器绑 contextmenu：多选模式下右键选中任务时冒泡上来弹批量菜单 -->
  <div class="timeline" @contextmenu="onBatchContextMenu($event)">
    <!-- 工具栏 -->
    <div class="timeline__toolbar">
      <div class="timeline__nav">
        <button class="timeline__btn" @click="goPrev">‹</button>
        <button class="timeline__btn" @click="goToday">今天</button>
        <button class="timeline__btn" @click="goNext">›</button>
      </div>
      <span class="timeline__title">{{ toolbarTitle }}</span>
      <div class="timeline__spacer" />
      <button
        class="timeline__btn"
        :class="{ 'timeline__btn--active': zoom === 'day' }"
        @click="setZoom('day')"
      >天</button>
      <button
        class="timeline__btn"
        :class="{ 'timeline__btn--active': zoom === 'week' }"
        @click="setZoom('week')"
      >周</button>
      <button
        class="timeline__btn"
        :class="{ 'timeline__btn--active': zoom === 'month' }"
        @click="setZoom('month')"
      >月</button>
    </div>

    <!-- 甘特图主体 -->
    <div class="gantt">
      <!-- 左侧任务名列 -->
      <div ref="tasksScrollEl" class="gantt__tasks" @scroll="onTasksScroll">
        <div class="gantt__tasks-head">
          <span>任务（{{ tasks.length }}）</span>
          <MenuPopover v-model:visible="moreMenuOpen" placement="bottom-right">
            <template #trigger>
              <button
                class="gantt__tasks-more-btn"
                title="更多"
                @click.stop.prevent="moreMenuOpen = !moreMenuOpen"
              >
                <icon-more :size="14" />
              </button>
            </template>
            <MenuPopoverItem @click="toggleShowCompleted">
              <icon-eye-invisible v-if="showCompleted" :size="15" />
              <icon-eye v-else :size="15" />
              <span>{{ showCompleted ? '隐藏已完成' : '显示已完成' }}</span>
            </MenuPopoverItem>
          </MenuPopover>
        </div>
        <div
          v-for="task in tasks"
          :key="task.id"
          class="gantt__task-row"
          :class="{
            'gantt__task-row--selected': taskStore.selectedTaskId === task.id,
            'gantt__task-row--focused': taskStore.focusedTaskId === task.id,
            'gantt__task-row--batch-selected': taskStore.batchMode && taskStore.isBatchSelected(task.id),
            'gantt__task-row--drop-before': rowDropTarget?.id === task.id && rowDropTarget.pos === 'before',
            'gantt__task-row--drop-after': rowDropTarget?.id === task.id && rowDropTarget.pos === 'after',
            'gantt__task-row--dragging': rowDragId === task.id,
          }"
          @click="onBarClick(task, $event)"
          @contextmenu="onTaskContextMenu($event, task)"
          @dragover="onRowDragOver($event, task.id)"
          @dragleave="onRowDragLeave($event, task.id)"
          @drop="onRowDrop"
        >
          <span
            class="gantt__task-handle"
            draggable="true"
            title="拖动排序"
            @dragstart="onRowDragStart($event, task.id)"
            @dragend="onRowDragEnd"
          >
            <icon-drag-dot-vertical :size="12" />
          </span>
          <!-- 多选模式：批量勾选框（圆形，主色填充+白勾） -->
          <div
            v-if="taskStore.batchMode"
            class="gantt__batch-check"
            :class="{ 'gantt__batch-check--on': taskStore.isBatchSelected(task.id) }"
            @click.stop="taskStore.toggleBatchSelect(task.id)"
          ></div>
          <div
            v-if="!taskStore.batchMode"
            class="gantt__task-check"
            :class="{ 'gantt__task-check--done': task.done }"
            :title="task.done ? '标记未完成' : '标记完成'"
            @click.stop="onToggle(task)"
          ></div>
          <div class="gantt__task-prio" :style="{ backgroundColor: PRIO_COLOR[task.priority ?? 0] }"></div>
          <span class="gantt__task-name" :class="{ 'gantt__task-name--done': task.done }">{{ task.title || '(未命名)' }}</span>
        </div>
      </div>

      <!-- 右侧时间轴 -->
      <div
        ref="timelineScrollEl"
        class="gantt__timeline"
        @scroll="onTimelineScroll"
      >
        <!-- 日期表头 -->
        <div class="gantt__dates" :style="{ width: timelineWidth + 'px' }">
          <div
            v-for="col in columns"
            :key="col.date.toISOString()"
            class="gantt__date"
            :class="{ 'gantt__date--weekend': col.weekend, 'gantt__date--today': col.today }"
            :style="{ width: COL_WIDTH + 'px' }"
          >
            <span class="gantt__date-day">{{ col.label }}</span>
            <span class="gantt__date-weekday">{{ col.sub }}</span>
          </div>
        </div>

        <!-- 网格行 + 横条 -->
        <div class="gantt__grid" :style="{ width: timelineWidth + 'px' }">
          <!-- 今日竖线 -->
          <div class="gantt__today-line" :style="{ left: todayLeft + 'px' }"></div>

          <div
            v-for="task in tasks"
            :key="task.id"
            class="gantt__grid-row"
            :class="{ 'gantt__grid-row--selected': taskStore.selectedTaskId === task.id }"
          >
            <div
              v-for="col in columns"
              :key="col.date.toISOString()"
              class="gantt__grid-cell"
              :class="{ 'gantt__grid-cell--weekend': col.weekend, 'gantt__grid-cell--today': col.today }"
              :style="{ width: COL_WIDTH + 'px' }"
              @click="onCellClick"
              @dblclick="onCellDblClick(col.date)"
            ></div>
            <!-- 任务横条 -->
            <div
              v-if="barStyle(task)"
              class="gantt__bar"
              :class="{
                'gantt__bar--done': task.done,
                'gantt__bar--dragging': dragState?.taskId === task.id,
              }"
              :style="dragBarStyle(task)"
              @mousedown="onBarMouseDown($event, task)"
              @mousemove="onBarMouseMove($event, task)"
              @click.stop="onBarClick(task, $event)"
            >
              {{ task.title || '(未命名)' }}
              <!-- 拖拽中的目标日期提示气泡 -->
              <span v-if="dragState?.taskId === task.id && dragPreviewText" class="gantt__bar-tip">
                {{ dragPreviewText }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 右键菜单（参照任务列表菜单：多选/新建/删除） -->
    <ContextMenu v-model:visible="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y">
      <MenuPopoverItem @click="onCtxBatchSelect">
        <icon-check-circle :size="15" />
        <span>多选</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="onCtxAddTask">
        <icon-plus :size="15" />
        <span>新建任务</span>
      </MenuPopoverItem>
      <MenuPopoverItem danger @click="onCtxDelete">
        <icon-delete :size="15" />
        <span>删除任务</span>
      </MenuPopoverItem>
    </ContextMenu>

    <!-- 批量操作菜单（多选模式下右键选中任务时弹出） -->
    <BatchContextMenu
      v-model:visible="batchCtxMenu.visible"
      :x="batchCtxMenu.x"
      :y="batchCtxMenu.y"
    />
  </div>
</template>

<style scoped>
/* 时间线视图容器（避开 AppLayout topbar） */
.timeline {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-top: 72px;
  box-sizing: border-box;
}

/* 工具栏 */
.timeline__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
}
.timeline__nav { display: flex; gap: 4px; }
.timeline__btn {
  border: 1px solid var(--jt-border);
  background: var(--jt-surface);
  color: var(--jt-text-secondary);
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.timeline__btn:hover { background: var(--jt-surface-hover); }
.timeline__btn--active { background: var(--jt-primary); color: #fff; border-color: var(--jt-primary); }
.timeline__title { font-weight: 600; font-size: 15px; color: var(--jt-text-primary); }
.timeline__spacer { flex: 1; }

/* 甘特图主体 */
.gantt {
  display: flex;
  flex: 1;
  min-height: 0;
  border-top: 1px solid var(--jt-border);
  overflow: hidden;
}

/* 左侧任务名列 */
.gantt__tasks {
  width: 200px;
  flex-shrink: 0;
  border-right: 2px solid var(--jt-border);
  background: var(--jt-surface);
  overflow-y: auto;
}
.gantt__tasks-head {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 0 12px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  border-bottom: 1px solid var(--jt-border);
  background: var(--jt-surface-sunken);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 2;
}
/* 任务区更多按钮 */
.gantt__tasks-more-btn {
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}
.gantt__tasks-more-btn:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
.gantt__task-row {
  height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--jt-border);
  cursor: pointer;
}
.gantt__task-row:hover { background: var(--jt-surface-hover); }
.gantt__task-row--selected { background: var(--jt-accent-soft); }
/* 键盘导航焦点（虚线边框，区别于选中的背景色） */
.gantt__task-row--focused {
  outline: 2px solid var(--jt-primary);
  outline-offset: -2px;
}
/* 垂直拖拽落点高亮（上下边线，参照 SidebarListNode） */
.gantt__task-row--drop-before { box-shadow: inset 0 2px 0 var(--jt-primary); }
.gantt__task-row--drop-after { box-shadow: inset 0 -2px 0 var(--jt-primary); }
.gantt__task-row--dragging { opacity: 0.4; }

/* 拖拽手柄：默认隐藏，hover 行时显示 */
.gantt__task-handle {
  display: flex;
  align-items: center;
  color: var(--jt-text-tertiary);
  cursor: grab;
  opacity: 0;
  transition: opacity 0.12s;
  flex-shrink: 0;
  padding: 2px 0;
}
.gantt__task-row:hover .gantt__task-handle { opacity: 1; }
.gantt__task-handle:active { cursor: grabbing; }
/* 多选模式批量勾选框：圆形 16px，未选空心灰圈，选中主色填充+白勾 */
.gantt__batch-check {
  width: 16px; height: 16px;
  border: 2px solid var(--jt-text-tertiary);
  border-radius: 50%;
  flex-shrink: 0;
  cursor: pointer;
  transition: all 0.15s ease;
}
.gantt__batch-check--on {
  background: var(--jt-primary);
  border-color: var(--jt-primary);
  position: relative;
}
.gantt__batch-check--on::after {
  content: '✓'; color: #fff; font-size: 10px; line-height: 1;
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
}
/* 多选模式下批量选中的行高亮 */
.gantt__task-row--batch-selected {
  background: var(--jt-accent-soft);
}

.gantt__task-check {
  width: 14px; height: 14px;
  border: 1.5px solid var(--jt-text-tertiary);
  border-radius: 4px; /* 方形圆角（与任务列表 TaskCheckbox 一致） */
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.gantt__task-check:hover { border-color: var(--jt-primary); }
.gantt__task-check--done { background: var(--jt-primary); border-color: var(--jt-primary); }
.gantt__task-check--done::after {
  content: '✓'; color: #fff; font-size: 9px; line-height: 1;
  /* flex 居中，无需绝对定位 */
}
.gantt__task-prio { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.gantt__task-name {
  font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--jt-text-primary);
}
.gantt__task-name--done { color: var(--jt-text-tertiary); text-decoration: line-through; }

/* 右侧时间轴 */
.gantt__timeline { flex: 1; overflow: auto; }
.gantt__dates {
  display: flex;
  height: 56px;
  border-bottom: 1px solid var(--jt-border);
  background: var(--jt-surface-sunken);
  position: sticky; top: 0; z-index: 2;
}
.gantt__date {
  flex-shrink: 0;
  /* border-box：width 含 border，列物理宽度精确 = COL_WIDTH，
   * 与 barStyle 的 startOffset×COL_WIDTH 对齐（否则 content-box 下 border 叠加
   * 会让列宽变成 91px，天数越多横条左偏越多，最终整条偏到前一天列） */
  box-sizing: border-box;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  border-right: 1px solid var(--jt-border);
  font-size: 11px; color: var(--jt-text-secondary);
}
.gantt__date--weekend { background: rgba(0,0,0,0.02); }
.gantt__date--today { background: var(--jt-accent-soft); color: var(--jt-primary); font-weight: 700; }
.gantt__date-day { font-size: 13px; font-weight: 600; }
.gantt__date-weekday { font-size: 10px; color: var(--jt-text-tertiary); margin-top: 2px; }

/* 网格 */
.gantt__grid { position: relative; }
.gantt__grid-row {
  height: 40px;
  display: flex;
  border-bottom: 1px solid var(--jt-border);
  position: relative;
}
/* 选中态：右侧时间轴对应行也高亮（与左侧 task-row--selected 背景一致，形成整行高亮） */
.gantt__grid-row--selected {
  background-color: var(--jt-accent-soft);
}
.gantt__grid-cell {
  flex-shrink: 0;
  /* border-box：物理宽度 = COL_WIDTH，与横条 left 计算对齐（见 .gantt__date 注释） */
  box-sizing: border-box;
  border-right: 1px solid var(--jt-border);
  height: 100%;
  cursor: default;
}
.gantt__grid-cell--weekend { background: rgba(0,0,0,0.02); }
.gantt__grid-cell--today { background: rgba(79, 70, 229, 0.04); }

/* 今日竖线 */
.gantt__today-line {
  position: absolute;
  top: 0; bottom: 0;
  width: 2px;
  background: var(--jt-primary);
  z-index: 3;
  pointer-events: none;
}
.gantt__today-line::before {
  content: '';
  position: absolute;
  top: -1px; left: -4px;
  width: 10px; height: 10px;
  background: var(--jt-primary);
  border-radius: 50%;
}

/* 任务横条 */
.gantt__bar {
  position: absolute;
  top: 6px; height: 28px;
  /* border-box：width 含左右 padding，物理宽度精确 = barStyle 计算值，
   * 不让 padding 撑大溢出到下一列（content-box 下 width=90 + padding 16 = 106px 溢出） */
  box-sizing: border-box;
  border-radius: 6px;
  display: flex; align-items: center;
  padding: 0 8px;
  font-size: 11px; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: grab;
  z-index: 1;
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
  transition: box-shadow 0.12s;
  user-select: none;
}
.gantt__bar--dragging {
  /* 拖拽中关闭 transition，让 transform 实时跟手；提升层级避免被其他行遮挡 */
  transition: none;
  z-index: 5;
  opacity: 0.7;
  cursor: grabbing;
}
.gantt__bar:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
.gantt__bar:active { cursor: grabbing; }
/* 边缘 resize 区域视觉指示（左右 10px，hover 显示加深） */
.gantt__bar::before, .gantt__bar::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0;
  width: 10px;
  cursor: ew-resize;
  opacity: 0;
  transition: opacity 0.12s;
}
.gantt__bar::before { left: 0; border-radius: 6px 0 0 6px; background: rgba(255,255,255,0.25); }
.gantt__bar::after { right: 0; border-radius: 0 6px 6px 0; background: rgba(255,255,255,0.25); }
.gantt__bar:hover::before, .gantt__bar:hover::after { opacity: 1; }
.gantt__bar--done { opacity: 0.5; }

/* 拖拽中的目标日期提示气泡（显示在横条上方） */
.gantt__bar-tip {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 6px;
  background: var(--jt-text-primary, #1F1F1F);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  padding: 3px 8px;
  border-radius: 5px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
  box-shadow: 0 2px 6px rgba(0,0,0,0.2);
}
.gantt__bar-tip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top-color: var(--jt-text-primary, #1F1F1F);
}
</style>
