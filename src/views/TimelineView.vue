<script setup lang="ts">
// 时间线（甘特图）视图 —— 横轴=连续日期，每任务一行，横条按起止日期定位。
// 支持拖拽横条平移改日期、拖边缘改时长、点击看详情、点击空白建任务、天/周/月缩放。
// 只显示有日期的任务；颜色按优先级。
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { useTaskStore } from "@/stores/task";
import { getTasksByDueRange } from "@/api/db";
import type { Task, Priority } from "@/types";
import { parseLocalIso, dateToLocalIso, todayDateOnly } from "@/utils/date";
import { subscribeTaskChanged } from "@/composables/useCalendarView";

const props = defineProps<{ id: string }>();

const taskStore = useTaskStore();

/** 缩放粒度：day=每天一列，week=每周一列，month=每月一列 */
type Zoom = "day" | "week" | "month";
const zoom = ref<Zoom>("day");

/** 当前可视范围的起始日期（本地 Date，不含时间） */
const anchorDate = ref<Date>(startOfMonth(new Date()));

/** 缩放对应的列数 */
const COLUMN_COUNT: Record<Zoom, number> = { day: 42, week: 12, month: 12 };

/** 每列宽度（px） */
const COL_WIDTH = 60;

/** 生成从 anchor 开始的日期列数组（每项含 Date + 标签信息） */
const columns = computed(() => {
  const cols: { date: Date; label: string; sub: string; weekend: boolean; today: boolean }[] = [];
  const today = todayDateOnly();
  for (let i = 0; i < COLUMN_COUNT[zoom.value]; i++) {
    const d = columnStartDate(anchorDate.value, i);
    const dateOnly = toISO(d);
    cols.push({
      date: d,
      label: columnLabel(d, zoom.value),
      sub: columnSub(d, zoom.value),
      weekend: zoom.value === "day" && (d.getDay() === 0 || d.getDay() === 6),
      today: dateOnly === today,
    });
  }
  return cols;
});

/** 可视范围对应的字面量（用于 getTasksByDueRange） */
const rangeLiteral = computed(() => {
  const first = columns.value[0]?.date ?? anchorDate.value;
  const last = columns.value[columns.value.length - 1]?.date ?? anchorDate.value;
  return {
    start: toISO(first),
    end: toISO(addDays(last, columnSpanDays(zoom.value))),
  };
});

/** 加载范围内的任务（按当前清单过滤）。
 *  注意：不按 due_start_at 排序——拖拽改日期后行顺序应保持不变
 *  （只移动横条，不重排行），用 sort_order 保持稳定顺序。 */
const tasks = ref<Task[]>([]);
async function loadTasks(): Promise<void> {
  const { start, end } = rangeLiteral.value;
  const all = await getTasksByDueRange(start, end, true);
  tasks.value = all
    .filter((t) => t.listId === props.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

onMounted(loadTasks);
watch([anchorDate, zoom, () => props.id], loadTasks);

// 订阅任务变更（标题/时间/完成等修改后刷新，与其他视图的 notifyTaskChanged 总线联动）
const unsubscribe = subscribeTaskChanged(() => { void loadTasks(); });
onBeforeUnmount(unsubscribe);

// ─── 日期工具（纯函数） ───
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
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

/** 前/后/今天导航 */
function goPrev(): void {
  anchorDate.value = columnStartDate(anchorDate.value, -1);
}
function goNext(): void {
  anchorDate.value = columnStartDate(anchorDate.value, 1);
}
function goToday(): void {
  anchorDate.value = zoom.value === "day" ? addDays(new Date(), -3) : startOfMonth(new Date());
}

/** 任务 → 横条样式（left/width 基于 day 缩放下的列偏移） */
function barStyle(task: Task): { left: number; width: number } | null {
  const start = parseLocalIso(task.dueStartAt);
  if (!start) return null;
  // end 缺失时用 start 兜底（单点任务，横条占一天）
  const end = parseLocalIso(task.dueEndAt) ?? start;
  const firstColDate = columns.value[0]?.date;
  if (!firstColDate) return null;
  // 横条定位按"天"计算（day 缩放）。week/month 缩放下也用天数映射到列宽
  const dayWidth = zoom.value === "day" ? COL_WIDTH : COL_WIDTH / columnSpanDays(zoom.value);
  const startOffset = daysBetween(firstColDate, start);
  const endOffset = daysBetween(firstColDate, end);
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
  const dayWidth = zoom.value === "day" ? COL_WIDTH : COL_WIDTH / columnSpanDays(zoom.value);
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
/** 点击横条 → 打开详情 */
function onBarClick(task: Task): void {
  // 拖拽刚结束（wasDragging）→ 不打开详情，避免拖拽误触面板
  if (wasDragging) {
    wasDragging = false;
    return;
  }
  taskStore.selectTask(task.id);
}

/** 点击复选框切换完成状态 */
function onToggle(task: Task): void {
  taskStore.toggleTask(task.id, !task.done);
}

/** 点击空白格 → 在该日期建任务（归属当前清单） */
async function onCellClick(colDate: Date): Promise<void> {
  const dayLiteral = `${toISO(colDate)}T00:00:00`;
  const created = await taskStore.createTask({
    title: "",
    listId: props.id,
    dueStartAt: dayLiteral,
    dueEndAt: dayLiteral,
  });
  taskStore.selectTask(created.id);
}

/** 缩放切换 */
function setZoom(z: Zoom): void {
  zoom.value = z;
  // 切缩放时重置 anchor 到月初
  anchorDate.value = startOfMonth(new Date());
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
  return zoom.value === "day" ? COL_WIDTH : COL_WIDTH / columnSpanDays(zoom.value);
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
  el.style.cursor = offsetX < 6 || offsetX > rect.width - 6 ? "ew-resize" : "grab";
}

function onBarMouseDown(e: MouseEvent, task: Task): void {
  if (task.done) return;
  wasDragging = false;
  // 边缘 6px 内 → resize，否则 move
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  const mode = offsetX < 6 ? "resize-start" : offsetX > rect.width - 6 ? "resize-end" : "move";
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
  // 移出范围：把 anchor 移到新日期所在月的开头，让任务重新进入视野
  anchorDate.value = startOfMonth(date);
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
const timelineWidth = computed(() => columns.value.length * COL_WIDTH);
</script>

<template>
  <div class="timeline">
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
      <div class="gantt__tasks">
        <div class="gantt__tasks-head">任务（{{ tasks.length }}）</div>
        <div
          v-for="task in tasks"
          :key="task.id"
          class="gantt__task-row"
          :class="{ 'gantt__task-row--selected': taskStore.selectedTaskId === task.id }"
          @click="onBarClick(task)"
        >
          <div
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
      <div class="gantt__timeline">
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

          <div v-for="task in tasks" :key="task.id" class="gantt__grid-row">
            <div
              v-for="col in columns"
              :key="col.date.toISOString()"
              class="gantt__grid-cell"
              :class="{ 'gantt__grid-cell--weekend': col.weekend, 'gantt__grid-cell--today': col.today }"
              :style="{ width: COL_WIDTH + 'px' }"
              @click="onCellClick(col.date)"
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
              @click.stop="onBarClick(task)"
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
  padding: 0 12px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  border-bottom: 1px solid var(--jt-border);
  background: var(--jt-surface-sunken);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 2;
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
.gantt__task-check {
  width: 16px; height: 16px;
  border: 1.5px solid var(--jt-text-tertiary);
  border-radius: 50%;
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
  content: '✓'; color: #fff; font-size: 10px; line-height: 1;
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
.gantt__grid-cell {
  flex-shrink: 0;
  border-right: 1px solid var(--jt-border);
  height: 100%;
  cursor: cell;
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
