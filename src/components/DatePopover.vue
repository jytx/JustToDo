<script setup lang="ts">
// 日期弹层 —— 自建，参考滴答清单
// 顶部 tab：日期 / 时间段
// 内容：快捷按钮 + 月历 + 时间/提醒/重复 子入口
// 底部：清除 / 确定
import { ref, computed, watch } from "vue";
import { toLocalIso, parseLocalIso } from "@/utils/date";

const props = defineProps<{
  /** 起始日期（YYYY-MM-DDTHH:mm:ss 本地字面量） */
  startIso: string | null;
  /** 结束日期（YYYY-MM-DDTHH:mm:ss 本地字面量） */
  endIso: string | null;
}>();

const emit = defineEmits<{
  /** 确认时触发，传 [start, end]（任一可为 null） */
  confirm: [start: string | null, end: string | null];
  /** 清除时触发 */
  clear: [];
  /** 弹层关闭 */
  cancel: [];
}>();

type TabKey = "date" | "range";
const activeTab = ref<TabKey>("date");

// 临时编辑状态
const editDate = ref<string | null>(null); // YYYY-MM-DDTHH:mm:ss 或 null
const editStart = ref<string | null>(null);
const editEnd = ref<string | null>(null);

watch(
  () => [props.startIso, props.endIso],
  ([s, e]) => {
    editDate.value = e ?? s ?? null;
    editStart.value = s ?? null;
    editEnd.value = e ?? null;
  },
  { immediate: true },
);

const monthCursor = ref(new Date());

// ─── 月历 ─────────────────────────────────────────
const calendarGrid = computed(() => {
  const year = monthCursor.value.getFullYear();
  const month = monthCursor.value.getMonth();
  const first = new Date(year, month, 1);
  const firstWeekday = first.getDay(); // 0=Sun
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
  // 尾部（下月头）补足 6 行
  const total = cells.length;
  const need = total <= 35 ? 35 - total : 42 - total;
  for (let d = 1; d <= need; d++) {
    cells.push({ date: new Date(year, month + 1, d), inMonth: false });
  }
  return cells;
});

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(d: Date) {
  return isSameDay(d, new Date());
}

const selectedDay = computed<Date | null>(() => {
  if (activeTab.value === "date") return parseLocalIso(editDate.value);
  if (activeTab.value === "range" && editStart.value) return parseLocalIso(editStart.value);
  return null;
});

function selectDay(d: Date) {
  // 保持原来的时分秒
  const cur =
    activeTab.value === "date"
      ? parseLocalIso(editDate.value)
      : parseLocalIso(editStart.value);
  const hh = cur?.getHours() ?? 9;
  const mi = cur?.getMinutes() ?? 0;
  const next = new Date(d);
  next.setHours(hh, mi, 0, 0);
  const iso = toLocalIso(
    `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
  );
  if (activeTab.value === "date") {
    editDate.value = iso;
  } else {
    editStart.value = iso;
    // 自动结束：若未设置或早于开始，则设为开始
    if (!editEnd.value || (parseLocalIso(editEnd.value) ?? new Date(0)) < next) {
      const end = new Date(next);
      end.setHours(end.getHours() + 1);
      editEnd.value = toLocalIso(
        `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}:00`,
      );
    }
  }
}

function prevMonth() {
  const c = new Date(monthCursor.value);
  c.setMonth(c.getMonth() - 1);
  monthCursor.value = c;
}

function nextMonth() {
  const c = new Date(monthCursor.value);
  c.setMonth(c.getMonth() + 1);
  monthCursor.value = c;
}

const monthLabel = computed(
  () => `${monthCursor.value.getFullYear()} 年 ${monthCursor.value.getMonth() + 1} 月`,
);

// ─── 快捷按钮 ─────────────────────────────────────
function quickDay(daysFromNow: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(9, 0, 0, 0);
  const iso = toLocalIso(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 09:00:00`,
  );
  if (activeTab.value === "date") {
    editDate.value = iso;
  } else {
    editStart.value = iso;
    const end = new Date(d);
    end.setHours(end.getHours() + 1);
    editEnd.value = toLocalIso(
      `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}:00`,
    );
  }
}

// ─── 时间选择（hh / mi 简易） ─────────────────────
const showTimePicker = ref(false);

function getCurrentTargetIso(): string | null {
  if (activeTab.value === "date") return editDate.value;
  // 时间段时优先取 start，缺省时回退到 end
  return editStart.value ?? editEnd.value;
}

function setTime(hh: number, mi: number) {
  // 拿到当前目标的 Date 副本（如果未设置就用 today）
  const cur = parseLocalIso(getCurrentTargetIso());
  const base = cur ?? new Date();
  base.setHours(hh, mi, 0, 0);
  const iso = toLocalIso(
    `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
  );
  if (activeTab.value === "date") {
    editDate.value = iso;
  } else {
    // 时间段：先设 start；end 不动（如果之前有）或置空
    editStart.value = iso;
    if (!editEnd.value) {
      // 默认 end = start + 1 小时
      const end = new Date(base);
      end.setHours(end.getHours() + 1);
      editEnd.value = toLocalIso(
        `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}:00`,
      );
    }
  }
  showTimePicker.value = false;
}

function setEndTime(hh: number, mi: number) {
  const cur = parseLocalIso(editEnd.value) ?? parseLocalIso(editStart.value) ?? new Date();
  const base = new Date(cur);
  base.setHours(hh, mi, 0, 0);
  editEnd.value = toLocalIso(
    `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
  );
  showEndTimePicker.value = false;
}

const currentTimeLabel = computed(() => {
  const iso = activeTab.value === "date" ? editDate.value : editStart.value;
  if (!iso) return "时间";
  const d = parseLocalIso(iso);
  if (!d) return "时间";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

const endTimeLabel = computed(() => {
  if (!editEnd.value) return "结束时间";
  const d = parseLocalIso(editEnd.value);
  if (!d) return "结束时间";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

const showEndTimePicker = ref(false);

// 拿当前 target 的小时/分钟（用于 setTime 时保留另一边）
function getCurrentHours(): number {
  return parseLocalIso(getCurrentTargetIso())?.getHours() ?? 9;
}
function getCurrentMinutes(): number {
  return parseLocalIso(getCurrentTargetIso())?.getMinutes() ?? 0;
}

// ─── 确认 / 清除 ─────────────────────────────────
function onConfirm() {
  if (activeTab.value === "date") {
    emit("confirm", editDate.value, null);
  } else {
    emit("confirm", editStart.value, editEnd.value);
  }
}

function onClear() {
  editDate.value = null;
  editStart.value = null;
  editEnd.value = null;
  emit("clear");
}

// 时分快捷
const hourOptions = Array.from({ length: 24 }, (_, i) => i);
const minuteOptions = Array.from({ length: 12 }, (_, i) => i * 5); // 0,5,10,...,55
</script>

<template>
  <div class="date-popover">
    <!-- Tab -->
    <div class="date-popover__tabs">
      <button
        type="button"
        class="date-popover__tab"
        :class="{ 'date-popover__tab--active': activeTab === 'date' }"
        @click="activeTab = 'date'"
      >
        日期
      </button>
      <button
        type="button"
        class="date-popover__tab"
        :class="{ 'date-popover__tab--active': activeTab === 'range' }"
        @click="activeTab = 'range'"
      >
        时间段
      </button>
    </div>

    <!-- 快捷按钮 -->
    <div class="date-popover__quick">
      <button type="button" class="date-popover__quick-btn" @click="quickDay(0)">
        <icon-sun :size="16" />
      </button>
      <button type="button" class="date-popover__quick-btn" @click="quickDay(1)">
        <icon-sunrise :size="16" />
      </button>
      <button type="button" class="date-popover__quick-btn" @click="quickDay(7)">
        <icon-calendar :size="16" />
      </button>
      <button type="button" class="date-popover__quick-btn" title="无日期" @click="onClear">
        <icon-close :size="16" />
      </button>
    </div>

    <!-- 月历头部 -->
    <div class="date-popover__cal-head">
      <button type="button" class="date-popover__nav" @click="prevMonth">
        <icon-left :size="14" />
      </button>
      <span class="date-popover__cal-title">{{ monthLabel }}</span>
      <button type="button" class="date-popover__nav" @click="nextMonth">
        <icon-right :size="14" />
      </button>
    </div>

    <!-- 月历星期 -->
    <div class="date-popover__weekdays">
      <span v-for="w in weekdays" :key="w" class="date-popover__weekday">{{ w }}</span>
    </div>

    <!-- 月历格子 -->
    <div class="date-popover__grid">
      <button
        v-for="(c, i) in calendarGrid"
        :key="i"
        type="button"
        class="date-popover__day"
        :class="{
          'date-popover__day--out': !c.inMonth,
          'date-popover__day--today': isToday(c.date),
          'date-popover__day--selected': selectedDay && isSameDay(c.date, selectedDay),
        }"
        @click="selectDay(c.date)"
      >
        {{ c.date.getDate() }}
      </button>
    </div>

    <!-- 时间子入口 -->
    <button
      type="button"
      class="date-popover__row"
      @click="showTimePicker = !showTimePicker; showEndTimePicker = false"
    >
      <icon-clock-circle :size="14" />
      <span>{{ activeTab === "range" ? "开始" : "时间" }} · {{ currentTimeLabel }}</span>
      <span class="date-popover__row-arrow"><icon-right :size="12" /></span>
    </button>

    <!-- 时间段 tab 的结束时间行 -->
    <button
      v-if="activeTab === 'range'"
      type="button"
      class="date-popover__row"
      @click="showEndTimePicker = !showEndTimePicker; showTimePicker = false"
    >
      <icon-clock-circle :size="14" />
      <span>结束 · {{ endTimeLabel }}</span>
      <span class="date-popover__row-arrow"><icon-right :size="12" /></span>
    </button>

    <!-- 时间选择（弹出） -->
    <div v-if="showTimePicker" class="date-popover__time">
      <div class="date-popover__time-col">
        <button
          v-for="h in hourOptions"
          :key="h"
          type="button"
          class="date-popover__time-cell"
          @click="setTime(h, getCurrentMinutes())"
        >
          {{ String(h).padStart(2, "0") }}
        </button>
      </div>
      <div class="date-popover__time-col">
        <button
          v-for="m in minuteOptions"
          :key="m"
          type="button"
          class="date-popover__time-cell"
          @click="setTime(getCurrentHours(), m)"
        >
          {{ String(m).padStart(2, "0") }}
        </button>
      </div>
    </div>

    <!-- 结束时间选择（弹出） -->
    <div v-if="showEndTimePicker" class="date-popover__time">
      <div class="date-popover__time-col">
        <button
          v-for="h in hourOptions"
          :key="h"
          type="button"
          class="date-popover__time-cell"
          @click="setEndTime(h, parseLocalIso(editEnd)?.getMinutes() ?? 0)"
        >
          {{ String(h).padStart(2, "0") }}
        </button>
      </div>
      <div class="date-popover__time-col">
        <button
          v-for="m in minuteOptions"
          :key="m"
          type="button"
          class="date-popover__time-cell"
          @click="setEndTime(parseLocalIso(editEnd)?.getHours() ?? 0, m)"
        >
          {{ String(m).padStart(2, "0") }}
        </button>
      </div>
    </div>

    <!-- 底部按钮 -->
    <div class="date-popover__footer">
      <button type="button" class="date-popover__btn date-popover__btn--ghost" @click="onClear">
        清除
      </button>
      <button type="button" class="date-popover__btn date-popover__btn--primary" @click="onConfirm">
        确定
      </button>
    </div>
  </div>
</template>

<style scoped>
.date-popover {
  width: 320px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.date-popover__tabs {
  display: flex;
  background: var(--jt-surface-sunken);
  border-radius: 8px;
  padding: 2px;
  gap: 0;
}

.date-popover__tab {
  flex: 1;
  border: none;
  background: transparent;
  padding: 6px 0;
  font-size: 13px;
  color: var(--jt-text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s;
}

.date-popover__tab--active {
  background: var(--jt-surface);
  color: var(--jt-text-primary);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.date-popover__quick {
  display: flex;
  gap: 4px;
  justify-content: space-around;
  padding: 4px 0;
}

.date-popover__quick-btn {
  width: 40px;
  height: 40px;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--jt-text-secondary);
  cursor: pointer;
  transition: all 0.12s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.date-popover__quick-btn:hover {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.date-popover__cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
}

.date-popover__nav {
  border: none;
  background: transparent;
  color: var(--jt-text-secondary);
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.date-popover__nav:hover {
  background: var(--jt-surface-sunken);
}

.date-popover__cal-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
}

.date-popover__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0;
  text-align: center;
}

.date-popover__weekday {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  padding: 4px 0;
}

.date-popover__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.date-popover__day {
  border: none;
  background: transparent;
  aspect-ratio: 1;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  transition: all 0.1s;
  font-family: var(--font-body);
}

.date-popover__day:hover {
  background: var(--jt-surface-sunken);
}

.date-popover__day--out {
  color: var(--jt-text-tertiary);
}

.date-popover__day--today {
  font-weight: 600;
  color: var(--jt-primary);
}

.date-popover__day--selected {
  background: var(--jt-primary) !important;
  color: #fff !important;
  font-weight: 500;
}

.date-popover__day--selected.date-popover__day--today {
  color: #fff;
}

.date-popover__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  text-align: left;
  width: 100%;
}

.date-popover__row:hover {
  background: var(--jt-surface-sunken);
}

.date-popover__row-arrow {
  margin-left: auto;
  color: var(--jt-text-tertiary);
}

.date-popover__time {
  display: flex;
  gap: 6px;
  max-height: 144px;
  overflow: hidden;
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 2px;
}

.date-popover__time-col {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  overflow-y: auto;
  max-height: 140px;
}

.date-popover__time-cell {
  border: none;
  background: transparent;
  padding: 2px 0;
  border-radius: 3px;
  font-size: 11px;
  color: var(--jt-text-primary);
  cursor: pointer;
  font-family: var(--font-mono);
  text-align: center;
  line-height: 1.4;
}

.date-popover__time-cell:hover {
  background: var(--jt-surface-sunken);
}

.date-popover__footer {
  display: flex;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--jt-border);
}

.date-popover__btn {
  flex: 1;
  height: 32px;
  border-radius: 8px;
  border: none;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s;
  font-family: var(--font-body);
}

.date-popover__btn--ghost {
  background: transparent;
  color: var(--jt-text-secondary);
  border: 1px solid var(--jt-border);
}

.date-popover__btn--ghost:hover {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.date-popover__btn--primary {
  background: var(--jt-primary);
  color: #fff;
}

.date-popover__btn--primary:hover {
  filter: brightness(0.92);
}
</style>
