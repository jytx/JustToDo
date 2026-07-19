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
  /** 最终选择粒度：day=选天跳转，month=选月跳转，year=选年跳转。
   *  用户可通过点标题临时上钻到更粗粒度（选年后退回选月），但只有在回到
   *  mode 对应粒度时选中才触发跳转。 */
  mode: "day" | "month" | "year";
}>();

const emit = defineEmits<{
  (e: "update:month", value: Date): void;
  (e: "select", date: Date): void;
}>();

/**
 * 当前显示粒度（内部状态）。
 * 初始 = 外部 mode；用户点标题可上钻（day→month→year），选中年/月后下钻回更细粒度。
 * 仅当 activeMode === mode 时，选中才 emit select 触发跳转。
 */
const activeMode = ref<"day" | "month" | "year">(props.mode);
// 外部 mode 变化（切换视图）时，activeMode 归位
watch(
  () => props.mode,
  (m) => {
    activeMode.value = m;
  },
);

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

// ─── day 模式：月历选天 ──────────────────────────────
/** 顶部标题：day/month → "2026年7月"，year → "2026" */
const monthLabel = computed(() => {
  if (activeMode.value === "year") return `${props.month.getFullYear()}`;
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
 * 翻页：‹ ›（按 activeMode 决定翻什么）
 *   day/month → 翻月（改 month 光标）
 *   year      → 翻 12 年块（改 yearPage）
 */
function prev(): void {
  if (activeMode.value === "year") {
    yearPage.value -= 1;
  } else {
    const d = new Date(props.month);
    d.setMonth(d.getMonth() - 1);
    emit("update:month", d);
  }
}
function next(): void {
  if (activeMode.value === "year") {
    yearPage.value += 1;
  } else {
    const d = new Date(props.month);
    d.setMonth(d.getMonth() + 1);
    emit("update:month", d);
  }
}

/**
 * 点标题 → 上钻一档（day→month→year），year 已最粗不再上钻。
 * 标题可点条件：activeMode !== "year"。
 */
function drillUp(): void {
  if (activeMode.value === "day") activeMode.value = "month";
  else if (activeMode.value === "month") activeMode.value = "year";
  // year：已最粗，不动
}

/**
 * 网格选中处理（核心交互逻辑）：
 *   - activeMode === mode（回到最终粒度）：emit select 触发跳转
 *   - activeMode !== mode（临时上钻在更粗粒度）：只把光标移到选中位置并下钻到更细粒度，
 *     不触发跳转。这样实现"月视图上钻选年后，退回选月再跳"。
 *
 * 例：mode=month，用户点标题上钻到 year，选 2025 年 →
 *     光标移到 2025，activeMode 回到 month，继续选月。
 */
function onSelect(date: Date, cellMode: "day" | "month" | "year"): void {
  if (cellMode === activeMode.value && cellMode === props.mode) {
    // 回到最终粒度的选中 → 跳转
    emit("select", date);
    return;
  }
  // 粗粒度选中：移动光标 + 下钻
  if (cellMode === "year") {
    // 选年 → 光标移到该年 1 月，下钻到 month（若 mode 是 month/day）
    emit("update:month", new Date(date.getFullYear(), 0, 1));
    if (props.mode === "month" || props.mode === "day") activeMode.value = "month";
  } else if (cellMode === "month") {
    // 选月 → 光标移到该月，下钻到 day（仅 mode=day 时）
    emit("update:month", new Date(date.getFullYear(), date.getMonth(), 1));
    if (props.mode === "day") activeMode.value = "day";
  }
}
</script>

<template>
  <div class="mc">
    <!-- 顶部翻页 + 标题（标题可点击上钻） -->
    <div class="mc__head">
      <button type="button" class="mc__nav" :title="activeMode === 'year' ? '上一个 12 年' : '上一月'" @click="prev">
        <icon-left :size="14" />
      </button>
      <button
        type="button"
        class="mc__title"
        :class="{ 'mc__title--clickable': activeMode !== 'year' }"
        :title="activeMode === 'year' ? '' : '点击切换到更高粒度'"
        :disabled="activeMode === 'year'"
        @click="drillUp"
      >
        {{ activeMode === "year" ? yearRangeLabel : monthLabel }}
      </button>
      <button type="button" class="mc__nav" :title="activeMode === 'year' ? '下一个 12 年' : '下一月'" @click="next">
        <icon-right :size="14" />
      </button>
    </div>

    <!-- day 粒度：完整月历 -->
    <template v-if="activeMode === 'day'">
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
          @click="onSelect(c.date, 'day')"
        >
          {{ c.date.getDate() }}
        </button>
      </div>
    </template>

    <!-- month 粒度：4×3 月份网格 -->
    <div v-else-if="activeMode === 'month'" class="mc__grid mc__grid--month">
      <button
        v-for="c in monthCells"
        :key="c.monthIdx"
        type="button"
        class="mc__cell"
        :class="{
          'mc__cell--today': isSameMonth(c.date, new Date()),
          'mc__cell--selected': selected !== null && isSameMonth(c.date, selected),
        }"
        @click="onSelect(c.date, 'month')"
      >
        {{ monthNames[c.monthIdx] }}
      </button>
    </div>

    <!-- year 粒度：4×3 年份网格 -->
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
        @click="onSelect(c.date, 'year')"
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
  border: none;
  background: transparent;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  font-family: inherit;
}
.mc__title:disabled {
  cursor: default;
}
.mc__title--clickable {
  cursor: pointer;
}
.mc__title--clickable:hover {
  background-color: var(--jt-surface-sunken);
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
