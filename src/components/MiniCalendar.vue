<script setup lang="ts">
// 轻量日期选择器 —— 用于日历视图工具栏点标题跳转
// 三种模式（按当前视图粒度）：
//   mode="day"   → 完整月历选某天（周视图用）
//   mode="month" → 年月选择器，选某月（月视图用）
//   mode="year"  → 年选择器，选某年（年视图用）
import { computed, ref, watch } from "vue";
import { IconLeft, IconRight } from "@arco-design/web-vue/es/icon";

const props = defineProps<{
  /** 当前选中日期（高亮显示，按 mode 取相应粒度比较） */
  selected: Date | null;
  /** 月历光标：当前显示哪个月/年（v-model:month） */
  month: Date;
  /** 选择粒度：day=选天，month=选月，year=选年 */
  mode: "day" | "month" | "year";
}>();

const emit = defineEmits<{
  (e: "update:month", value: Date): void;
  (e: "select", date: Date): void;
}>();

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

// ─── day 模式：月历选天 ──────────────────────────────
/** 顶部标题：day→"2026年7月"，month→"2026年7月"，year→"2026年" */
const monthLabel = computed(() => {
  if (props.mode === "year") return `${props.month.getFullYear()}`;
  return `${props.month.getFullYear()}年${props.month.getMonth() + 1}月`;
});

/** day 模式：6×7 月历格子（前导上月尾 + 本月 + 尾部下月头补 42 格） */
const calendarGrid = computed(() => {
  const year = props.month.getFullYear();
  const m = props.month.getMonth();
  const firstWeekday = new Date(year, m, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, m, 0).getDate();

  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, m - 1, daysInPrevMonth - i), inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, m, d), inMonth: true });
  }
  const need = 42 - cells.length;
  for (let d = 1; d <= need; d++) {
    cells.push({ date: new Date(year, m + 1, d), inMonth: false });
  }
  return cells;
});

// ─── month 模式：年月选择器（4×3 月份网格）──────────────
/** 当前光标所在年的 12 个月 */
const monthCells = computed(() => {
  const year = props.month.getFullYear();
  const cells: { date: Date; monthIdx: number }[] = [];
  for (let i = 0; i < 12; i++) {
    cells.push({ date: new Date(year, i, 1), monthIdx: i });
  }
  return cells;
});

const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

// ─── year 模式：年选择器（4×3 年份网格，以光标年为中心前后各取） ──
/**
 * year 模式下的年份网格：以一个 12 年区间为单位翻页。
 * 用 yearPage 控制当前显示哪个 12 年块（避免直接改 month 影响其他模式）。
 * 初始 = 光标年所在块，每次切换视图/打开时重置（见 watch）。
 */
const yearPage = ref(0);
const yearCells = computed(() => {
  const startYear = yearPage.value * 12;
  const cells: { date: Date; year: number }[] = [];
  for (let i = 0; i < 12; i++) {
    cells.push({ date: new Date(startYear + i, 0, 1), year: startYear + i });
  }
  return cells;
});
const yearRangeLabel = computed(() => {
  const startYear = yearPage.value * 12;
  return `${startYear} - ${startYear + 11}`;
});

// 打开/视图切换时，year 模式的 yearPage 对齐到光标年所在块
watch(
  () => props.month,
  (d) => {
    yearPage.value = Math.floor(d.getFullYear() / 12);
  },
  { immediate: true },
);

// ─── 公共：比较 / 翻页 ───────────────────────────────
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
function isSameYear(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear();
}
function isToday(d: Date): boolean {
  return isSameDay(d, new Date());
}

/**
 * 翻页：‹ ›
 *   day/month 模式 → 翻月（改 month 光标）
 *   year 模式 → 翻 12 年块（改 yearPage）
 */
function prev(): void {
  if (props.mode === "year") {
    yearPage.value -= 1;
  } else {
    const d = new Date(props.month);
    d.setMonth(d.getMonth() - 1);
    emit("update:month", d);
  }
}
function next(): void {
  if (props.mode === "year") {
    yearPage.value += 1;
  } else {
    const d = new Date(props.month);
    d.setMonth(d.getMonth() + 1);
    emit("update:month", d);
  }
}

/** 选中处理：统一 emit 一个 Date（跳转语义交给父组件，FC 按视图类型定位） */
function pick(date: Date): void {
  emit("select", date);
}
</script>

<template>
  <div class="mc">
    <!-- 顶部翻页 -->
    <div class="mc__head">
      <button type="button" class="mc__nav" :title="mode === 'year' ? '上一个 12 年' : '上一月'" @click="prev">
        <icon-left :size="14" />
      </button>
      <span class="mc__title">{{ mode === "year" ? yearRangeLabel : monthLabel }}</span>
      <button type="button" class="mc__nav" :title="mode === 'year' ? '下一个 12 年' : '下一月'" @click="next">
        <icon-right :size="14" />
      </button>
    </div>

    <!-- day 模式：完整月历 -->
    <template v-if="mode === 'day'">
      <div class="mc__weekdays">
        <span v-for="w in weekdays" :key="w" class="mc__weekday">{{ w }}</span>
      </div>
      <div class="mc__grid mc__grid--day">
        <button
          v-for="(c, i) in calendarGrid"
          :key="i"
          type="button"
          class="mc__day"
          :class="{
            'mc__day--out': !c.inMonth,
            'mc__day--today': isToday(c.date),
            'mc__day--selected': selected !== null && isSameDay(c.date, selected),
          }"
          @click="pick(c.date)"
        >
          {{ c.date.getDate() }}
        </button>
      </div>
    </template>

    <!-- month 模式：4×3 月份网格 -->
    <div v-else-if="mode === 'month'" class="mc__grid mc__grid--month">
      <button
        v-for="c in monthCells"
        :key="c.monthIdx"
        type="button"
        class="mc__cell"
        :class="{
          'mc__cell--today': isSameMonth(c.date, new Date()),
          'mc__cell--selected': selected !== null && isSameMonth(c.date, selected),
        }"
        @click="pick(c.date)"
      >
        {{ monthNames[c.monthIdx] }}
      </button>
    </div>

    <!-- year 模式：4×3 年份网格 -->
    <div v-else class="mc__grid mc__grid--year">
      <button
        v-for="c in yearCells"
        :key="c.year"
        type="button"
        class="mc__cell"
        :class="{
          'mc__cell--today': isSameYear(c.date, new Date()),
          'mc__cell--selected': selected !== null && isSameYear(c.date, selected),
        }"
        @click="pick(c.date)"
      >
        {{ c.year }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mc {
  width: 224px;
  padding: 12px;
  background-color: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.mc__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.mc__nav {
  border: none;
  background: transparent;
  color: var(--jt-text-secondary);
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mc__nav:hover {
  background-color: var(--jt-surface-sunken);
}

.mc__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
}

.mc__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  margin-bottom: 2px;
}

.mc__weekday {
  font-size: 10px;
  color: var(--jt-text-tertiary);
  padding: 2px 0;
}

.mc__grid--day {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}

.mc__grid--month,
.mc__grid--year {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
}

.mc__day {
  border: none;
  background: transparent;
  aspect-ratio: 1 / 0.85;
  border-radius: 5px;
  font-size: 12px;
  color: var(--jt-text-primary);
  cursor: pointer;
  transition: background-color 0.1s;
  font-family: var(--font-body, inherit);
}

.mc__day:hover {
  background-color: var(--jt-surface-sunken);
}

.mc__day--out {
  color: var(--jt-text-tertiary);
}

.mc__day--today {
  font-weight: 600;
  color: var(--jt-primary);
}

.mc__day--selected {
  background-color: var(--jt-primary) !important;
  color: #fff !important;
  font-weight: 500;
}

/* month / year 模式的大格子 */
.mc__cell {
  border: none;
  background: transparent;
  height: 40px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  transition: background-color 0.1s;
  font-family: var(--font-body, inherit);
}

.mc__cell:hover {
  background-color: var(--jt-surface-sunken);
}

.mc__cell--today {
  color: var(--jt-primary);
  font-weight: 600;
}

.mc__cell--selected {
  background-color: var(--jt-primary) !important;
  color: #fff !important;
  font-weight: 500;
}
</style>
