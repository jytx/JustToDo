<script setup lang="ts">
// 轻量月历 —— 仅"选单日"，用于日历视图工具栏点标题跳转
// 与 DatePopover 的区别：无 tab、无时间段、无时分，聚焦 KISS
import { computed } from "vue";
import { IconLeft, IconRight } from "@arco-design/web-vue/es/icon";

const props = defineProps<{
  /** 当前选中日期（高亮显示） */
  selected: Date | null;
  /** 月历光标：当前显示哪个月（v-model:month） */
  month: Date;
}>();

const emit = defineEmits<{
  (e: "update:month", value: Date): void;
  (e: "select", date: Date): void;
}>();

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

/** 顶部标题：2026年7月 */
const monthLabel = computed(() => {
  return `${props.month.getFullYear()}年${props.month.getMonth() + 1}月`;
});

/**
 * 月历 6×7 格子（参考 DatePopover.calendarGrid 纯函数逻辑）
 * 前导上月尾 + 本月 + 尾部下月头，补足 42 格
 */
const calendarGrid = computed(() => {
  const year = props.month.getFullYear();
  const month = props.month.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells: { date: Date; inMonth: boolean }[] = [];
  // 前导（上月尾部）
  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month - 1, daysInPrevMonth - i), inMonth: false });
  }
  // 本月
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), inMonth: true });
  }
  // 尾部（下月头）补足 42 格
  const need = 42 - cells.length;
  for (let d = 1; d <= need; d++) {
    cells.push({ date: new Date(year, month + 1, d), inMonth: false });
  }
  return cells;
});

/** 两个 Date 是否同一天 */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 是否今天 */
function isToday(d: Date): boolean {
  return isSameDay(d, new Date());
}

/** 翻月：上一月 */
function prevMonth(): void {
  const d = new Date(props.month);
  d.setMonth(d.getMonth() - 1);
  emit("update:month", d);
}

/** 翻月：下一月 */
function nextMonth(): void {
  const d = new Date(props.month);
  d.setMonth(d.getMonth() + 1);
  emit("update:month", d);
}

/** 选某天 → emit（关闭弹层由父组件控制） */
function pick(d: Date): void {
  emit("select", d);
}
</script>

<template>
  <div class="mc">
    <!-- 顶部翻月 -->
    <div class="mc__head">
      <button type="button" class="mc__nav" :title="'上一月'" @click="prevMonth">
        <icon-left :size="14" />
      </button>
      <span class="mc__title">{{ monthLabel }}</span>
      <button type="button" class="mc__nav" :title="'下一月'" @click="nextMonth">
        <icon-right :size="14" />
      </button>
    </div>

    <!-- 星期表头 -->
    <div class="mc__weekdays">
      <span v-for="w in weekdays" :key="w" class="mc__weekday">{{ w }}</span>
    </div>

    <!-- 日期格子 -->
    <div class="mc__grid">
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

.mc__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
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
</style>
