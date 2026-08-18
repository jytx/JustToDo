<script setup lang="ts">
// 单月月历网格 —— 日期选择的共用展示组件（DatePopover / ReminderPopover 复用）
// 职责边界：只负责「渲染一个月历」—— 翻页头部 + 星期行 + 42 格日期。
//   - 单选高亮：外部传 selected（与格子同天则高亮）
//   - 范围高亮（可选）：外部传 rangeClass 判定函数（时间段选择用）
//   - 点格子 / 翻页均回调外部，组件不持有业务状态（纯受控）
import { computed } from "vue";

const props = defineProps<{
  /** 单选高亮日（与格子同天则高亮；null = 无单选） */
  selected: Date | null;
  /** 月历光标：当前显示哪个月（v-model:month） */
  month: Date;
  /** 范围高亮判定（可选）：返回 'in'（范围内）/ 'start' / 'end' / null */
  rangeClass?: (d: Date) => "in" | "start" | "end" | null;
}>();

const emit = defineEmits<{
  "update:month": [value: Date];
  select: [date: Date];
}>();

// ─── 网格数据 ─────────────────────────────────────
const calendarGrid = computed(() => {
  const year = props.month.getFullYear();
  const month = props.month.getMonth();
  const first = new Date(year, month, 1);
  const firstWeekday = first.getDay(); // 0=周日
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells: { date: Date; inMonth: boolean }[] = [];
  // 前导（上月尾部）
  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({
      date: new Date(year, month - 1, daysInPrevMonth - i),
      inMonth: false,
    });
  }
  // 本月
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), inMonth: true });
  }
  // 尾部（下月头）补足 6 行 42 格
  const need = 42 - cells.length;
  for (let d = 1; d <= need; d++) {
    cells.push({ date: new Date(year, month + 1, d), inMonth: false });
  }
  return cells;
});

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(d: Date): boolean {
  return isSameDay(d, new Date());
}

/** 格子的范围状态（防护可选 prop：未传判定函数时一律无范围高亮） */
function cellRange(d: Date): "in" | "start" | "end" | null {
  return props.rangeClass ? props.rangeClass(d) : null;
}

function prevMonth(): void {
  const c = new Date(props.month);
  c.setMonth(c.getMonth() - 1);
  emit("update:month", c);
}

function nextMonth(): void {
  const c = new Date(props.month);
  c.setMonth(c.getMonth() + 1);
  emit("update:month", c);
}

const monthLabel = computed(
  () => `${props.month.getFullYear()} 年 ${props.month.getMonth() + 1} 月`,
);
</script>

<template>
  <div class="mdg">
    <!-- 月历头部：‹ 年月 › -->
    <div class="mdg__head">
      <button type="button" class="mdg__nav" @click="prevMonth">
        <icon-left :size="14" />
      </button>
      <span class="mdg__title">{{ monthLabel }}</span>
      <button type="button" class="mdg__nav" @click="nextMonth">
        <icon-right :size="14" />
      </button>
    </div>

    <!-- 星期行 -->
    <div class="mdg__weekdays">
      <span v-for="w in weekdays" :key="w" class="mdg__weekday">{{ w }}</span>
    </div>

    <!-- 42 格日期 -->
    <div class="mdg__grid">
      <button
        v-for="(c, i) in calendarGrid"
        :key="i"
        type="button"
        class="mdg__day"
        :class="{
          'mdg__day--out': !c.inMonth,
          'mdg__day--today': isToday(c.date),
          'mdg__day--selected': selected && isSameDay(c.date, selected),
          'mdg__day--range-start': cellRange(c.date) === 'start',
          'mdg__day--range-end': cellRange(c.date) === 'end',
          'mdg__day--range-in': cellRange(c.date) === 'in',
        }"
        @click="emit('select', c.date)"
      >
        {{ c.date.getDate() }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mdg {
  display: flex;
  flex-direction: column;
}

.mdg__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.mdg__nav {
  border: none;
  background: transparent;
  color: var(--jt-text-secondary);
  width: 20px;
  height: 20px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mdg__nav:hover {
  background: var(--jt-surface-sunken);
}

.mdg__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-primary);
}

.mdg__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0;
  text-align: center;
}

.mdg__weekday {
  font-size: 10px;
  color: var(--jt-text-tertiary);
  padding: 2px 0;
}

.mdg__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}

.mdg__day {
  border: none;
  background: transparent;
  aspect-ratio: 1 / 0.78;
  border-radius: 5px;
  font-size: 11px;
  color: var(--jt-text-primary);
  cursor: pointer;
  transition: all 0.1s;
  font-family: var(--font-body);
}

.mdg__day:hover {
  background: var(--jt-surface-sunken);
}

.mdg__day--out {
  color: var(--jt-text-tertiary);
}

.mdg__day--today {
  font-weight: 600;
  color: var(--jt-primary);
}

.mdg__day--selected {
  background: var(--jt-primary) !important;
  color: #fff !important;
  font-weight: 500;
}

.mdg__day--selected.mdg__day--today {
  color: #fff;
}

/* 时间段范围高亮 —— 端点用主色 + 圆角，闭合形
   端点（start/end）的特异度必须高于 in：通过拼接"格子基础类 + 端点类"提升到 2+1=3 级，
   而 in 是 1+1=2 级，这样即使源码顺序在 in 之后，端点也总能赢。
   加上 background 仍走 !important 兜底，双保险。 */
.mdg__day.mdg__day--range-start,
.mdg__day.mdg__day--range-end {
  background: var(--jt-primary) !important;
  color: #fff !important;
  font-weight: 500;
}

/* 开始端：左侧圆角闭合，右侧抹平贴合 in 区 */
.mdg__day.mdg__day--range-start {
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}

/* 结束端：右侧圆角闭合，左侧抹平贴合 in 区 */
.mdg__day.mdg__day--range-end {
  border-top-left-radius: 0 !important;
  border-bottom-left-radius: 0 !important;
}

/* 范围内格子：浅紫底 + 抹平两侧（让 start/end 圆角"夹"住它） */
.mdg__day--range-in {
  background: var(--jt-accent-soft);
  color: var(--jt-text-primary);
  border-radius: 0;
}
</style>
