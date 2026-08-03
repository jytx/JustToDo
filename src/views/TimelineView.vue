<script setup lang="ts">
// 时间线（甘特图）视图 —— 横轴=连续日期，每任务一行，横条按起止日期定位。
// 支持拖拽横条平移改日期、拖边缘改时长、点击看详情、点击空白建任务、天/周/月缩放。
// 只显示有日期的任务；颜色按优先级。
import { ref, computed, onMounted, watch } from "vue";
import { useTaskStore } from "@/stores/task";
import { getTasksByDueRange } from "@/api/db";
import type { Task, Priority } from "@/types";
import { parseLocalIso, dateToLocalIso, todayDateOnly } from "@/utils/date";

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

/** 加载范围内的任务 */
const tasks = ref<Task[]>([]);
async function loadTasks(): Promise<void> {
  const { start, end } = rangeLiteral.value;
  tasks.value = await getTasksByDueRange(start, end, true);
}

onMounted(loadTasks);
watch([anchorDate, zoom], loadTasks);

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
  const end = parseLocalIso(task.dueEndAt);
  if (!start || !end) return null;
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
  taskStore.selectTask(task.id);
}

/** 点击空白格 → 在该日期建任务 */
async function onCellClick(colDate: Date): Promise<void> {
  const dayLiteral = `${toISO(colDate)}T00:00:00`;
  const created = await taskStore.createTask({
    title: "",
    listId: "inbox",
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
const dragState = ref<{
  taskId: string;
  mode: "move" | "resize-start" | "resize-end";
  startX: number;
  origStart: string;
  origEnd: string;
} | null>(null);

function onBarMouseDown(e: MouseEvent, task: Task): void {
  if (task.done) return;
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
  };
  e.preventDefault();
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(): void {
  // 拖拽中不实时改 DOM（松手时一次性持久化更新，避免频繁 updateTask）
}

async function onMouseUp(e: MouseEvent): Promise<void> {
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
  const ds = dragState.value;
  dragState.value = null;
  if (!ds) return;
  const dx = e.clientX - ds.startX;
  const dayWidth = zoom.value === "day" ? COL_WIDTH : COL_WIDTH / columnSpanDays(zoom.value);
  const deltaDays = Math.round(dx / dayWidth);
  if (deltaDays === 0) return;
  const origStart = parseLocalIso(ds.origStart);
  const origEnd = parseLocalIso(ds.origEnd);
  if (!origStart || !origEnd) return;
  let newStart = origStart;
  let newEnd = origEnd;
  if (ds.mode === "move") {
    newStart = addDays(origStart, deltaDays);
    newEnd = addDays(origEnd, deltaDays);
  } else if (ds.mode === "resize-start") {
    newStart = addDays(origStart, deltaDays);
    if (daysBetween(newStart, origEnd) < 0) return; // 起点不能晚于终点
  } else if (ds.mode === "resize-end") {
    newEnd = addDays(origEnd, deltaDays);
    if (daysBetween(origStart, newEnd) < 0) return;
  }
  await taskStore.updateTask(ds.taskId, {
    dueStartAt: keepTime(ds.origStart, newStart),
    dueEndAt: keepTime(ds.origEnd, newEnd),
  });
  await loadTasks();
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
          <div class="gantt__task-check" :class="{ 'gantt__task-check--done': task.done }"></div>
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
              :style="{ ...barStyle(task)!, backgroundColor: PRIO_COLOR[task.priority ?? 0] }"
              @mousedown="onBarMouseDown($event, task)"
              @click.stop="onBarClick(task)"
            >{{ task.title || '(未命名)' }}</div>
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
  width: 14px; height: 14px;
  border: 1.5px solid var(--jt-text-tertiary);
  border-radius: 50%;
  flex-shrink: 0;
}
.gantt__task-check--done { background: var(--jt-primary); border-color: var(--jt-primary); position: relative; }
.gantt__task-check--done::after {
  content: '✓'; color: #fff; font-size: 9px;
  position: absolute; top: -2px; left: 2px;
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
.gantt__bar:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
.gantt__bar:active { cursor: grabbing; }
.gantt__bar--done { opacity: 0.5; }
.gantt__bar--dragging { opacity: 0.7; }
</style>
