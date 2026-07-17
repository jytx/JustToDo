<script setup lang="ts">
// 习惯打卡视图 —— 滴答清单风格：
// 顶部 7 圆圈（本周日期）+ 习惯按时段分组（上午/下午/晚上）+ 每项右侧 7 圆圈（本周打卡）
import { computed, nextTick, onMounted, ref } from "vue";
import { useHabitStore } from "@/stores/habit";
import TeleportPopper from "@/components/TeleportPopper.vue";
import type { HabitWithStats } from "@/api/db";

const habitStore = useHabitStore();
const showCreateDialog = ref(false);
const newName = ref("");
const newNameInputRef = ref<HTMLInputElement | null>(null);
const newColor = ref("#10B981");
/** 新建习惯的时段（morning/afternoon/evening） */
const newTimeOfDay = ref<"morning" | "afternoon" | "evening">("evening");

const colors = [
  "#EF4444", "#F59E0B", "#EAB308", "#10B981",
  "#3B82F6", "#8B5CF6", "#EC4899", "#6B7280",
];

const TIME_OF_DAY_OPTIONS: Array<{
  value: "morning" | "afternoon" | "evening";
  label: string;
}> = [
  { value: "morning", label: "上午" },
  { value: "afternoon", label: "下午" },
  { value: "evening", label: "晚上" },
];

/** 颜色 trigger 元素 + 弹层状态 */
const colorTriggerEl = ref<HTMLElement | null>(null);
const colorPickerOpen = ref(false);

/** 时段 trigger 元素 + 弹层状态 */
const timeOfDayTriggerEl = ref<HTMLElement | null>(null);
const timeOfDayPickerOpen = ref(false);

function onClickColorTrigger(e: MouseEvent) {
  colorTriggerEl.value = e.currentTarget as HTMLElement;
  colorPickerOpen.value = !colorPickerOpen.value;
  timeOfDayPickerOpen.value = false;
}
function onClickTimeOfDayTrigger(e: MouseEvent) {
  timeOfDayTriggerEl.value = e.currentTarget as HTMLElement;
  timeOfDayPickerOpen.value = !timeOfDayPickerOpen.value;
  colorPickerOpen.value = false;
}

function openCreateDialog() {
  newName.value = "";
  newColor.value = "#10B981";
  newTimeOfDay.value = "evening";
  showCreateDialog.value = true;
  nextTick(() => {
    newNameInputRef.value?.focus();
  });
}

/** 异步加载习惯 + 打卡日志。错误兜底不抛到 console */
async function loadData() {
  try {
    await habitStore.loadHabits();
  } catch (e) {
    console.error("[HabitView] loadHabits 失败:", e);
  }
  try {
    await Promise.all(
      habitStore.habits.map((h) => habitStore.loadLogs(h.habit.id)),
    );
  } catch (e) {
    console.error("[HabitView] loadLogs 失败:", e);
  }
}

onMounted(loadData);

async function createHabit() {
  const name = newName.value.trim();
  if (!name) {
    showCreateDialog.value = false;
    return;
  }
  await habitStore.createHabit({
    name,
    color: newColor.value,
    timeOfDay: newTimeOfDay.value,
  });
  showCreateDialog.value = false;
}

async function toggleDay(habitId: string, date: string) {
  await habitStore.toggleCheck(habitId, date);
}

// ─── 本周日期计算 ──────────────────────────────────────

/** 周一到周日的标签 */
const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 取本周一 ~ 周日的 7 个日期（YYYY-MM-DD） */
const thisWeek = computed<{ date: string; day: number; label: string; isToday: boolean }[]>(() => {
  const out: { date: string; day: number; label: string; isToday: boolean }[] = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // JS getDay(): 0=Sun, 1=Mon ... 6=Sat —— 转成"距周一多少天"
  const offset = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - offset);
  const todayStr = ymd(today);
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const date = ymd(d);
    out.push({
      date,
      day: d.getDate(),
      label: WEEKDAY_LABELS[i],
      isToday: date === todayStr,
    });
  }
  return out;
});

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── 时段分组 ──────────────────────────────────────────

/** 按时段分组的习惯列表（保留 store 内的相对顺序） */
const groupedHabits = computed(() => {
  const groups: Record<"morning" | "afternoon" | "evening", HabitWithStats[]> = {
    morning: [],
    afternoon: [],
    evening: [],
  };
  for (const h of habitStore.habits) {
    groups[h.habit.timeOfDay].push(h);
  }
  return groups;
});

const GROUP_LABELS: Record<"morning" | "afternoon" | "evening", string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
};
const GROUP_ORDER: Array<"morning" | "afternoon" | "evening"> = [
  "morning",
  "afternoon",
  "evening",
];

function isLogged(habitId: string, date: string): boolean {
  return habitStore.logs[habitId]?.has(date) ?? false;
}

// ─── 右侧详情面板 ──────────────────────────────────────

/** 当前选中的 habit（左侧点击切换） */
const selectedHabitId = ref<string | null>(null);

/** 选中 habit 的完整数据（响应式） */
const selectedHabit = computed<HabitWithStats | null>(() => {
  if (!selectedHabitId.value) return null;
  return habitStore.habits.find((h) => h.habit.id === selectedHabitId.value) ?? null;
});

/** 详情面板显示的月份（YYYY-MM，1 = 当前月） */
const detailMonth = ref<string>(ymd(new Date()).slice(0, 7));

/** 月历网格：6 周 × 7 天，含上月末/下月头的补位 */
const detailMonthGrid = computed<{ date: string; day: number; inMonth: boolean; isToday: boolean }[]>(() => {
  const [yStr, mStr] = detailMonth.value.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7; // 周一=0 的偏移
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  const todayStr = ymd(new Date());
  const cells: { date: string; day: number; inMonth: boolean; isToday: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const date = ymd(d);
    cells.push({
      date,
      day: d.getDate(),
      inMonth: d.getMonth() === m - 1,
      isToday: date === todayStr,
    });
  }
  return cells;
});

/** 月份名称（如「七月」） */
const detailMonthLabel = computed(() => {
  const [, m] = detailMonth.value.split("-").map(Number);
  return `${m}月`;
});

function prevMonth() {
  const [y, m] = detailMonth.value.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  detailMonth.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function nextMonth() {
  const [y, m] = detailMonth.value.split("-").map(Number);
  const d = new Date(y, m, 1);
  detailMonth.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 当月已打卡天数 */
const detailMonthLoggedCount = computed(() => {
  if (!selectedHabit.value) return 0;
  const prefix = detailMonth.value;
  let n = 0;
  const set = habitStore.logs[selectedHabit.value.habit.id];
  if (!set) return 0;
  for (const date of set) {
    if (date.startsWith(prefix)) n += 1;
  }
  return n;
});

/** 当月天数 */
const detailMonthDays = computed(() => {
  const [y, m] = detailMonth.value.split("-").map(Number);
  return new Date(y, m, 0).getDate();
});

/** 月完成率（百分比） */
const detailMonthRate = computed(() => {
  if (!selectedHabit.value) return 0;
  if (detailMonthDays.value === 0) return 0;
  return Math.round((detailMonthLoggedCount.value / detailMonthDays.value) * 100);
});

function selectHabit(id: string) {
  selectedHabitId.value = id;
  // 切到当前月
  detailMonth.value = ymd(new Date()).slice(0, 7);
}
</script>

<template>
  <div class="habit-view">
    <header class="habit-view__header">
      <h1 class="habit-view__title">习惯</h1>
      <a-button
        type="text"
        size="small"
        title="新建习惯"
        @click="openCreateDialog"
      >
        <template #icon><icon-plus :size="20" /></template>
      </a-button>
    </header>

    <!-- 顶部 7 圆圈：本周日期（不可点击，仅作装饰） -->
    <div class="habit-view__week-strip">
      <div
        v-for="d in thisWeek"
        :key="d.date"
        class="habit-view__week-cell"
        :class="{ 'habit-view__week-cell--today': d.isToday }"
      >
        <span class="habit-view__week-label">{{ d.label }}</span>
        <span class="habit-view__week-day">{{ d.day }}</span>
        <span class="habit-view__week-dot" />
      </div>
    </div>

    <!-- 主区两栏：左侧习惯列表 + 右侧详情面板 -->
    <div class="habit-view__main">
      <!-- 左侧：习惯列表（按时段分组） -->
      <div class="habit-view__list">
        <div
          v-for="key in GROUP_ORDER"
          :key="key"
          v-show="groupedHabits[key].length > 0"
          class="habit-view__group"
        >
          <!-- 组标题 -->
          <div class="habit-view__group-header">
            <icon-down :size="12" class="habit-view__group-caret" />
            <span class="habit-view__group-name">{{ GROUP_LABELS[key] }}</span>
            <span class="habit-view__group-count">{{ groupedHabits[key].length }}</span>
          </div>

          <!-- 习惯项 -->
          <div
            v-for="h in groupedHabits[key]"
            :key="h.habit.id"
            class="habit-card"
            :class="{ 'habit-card--selected': selectedHabitId === h.habit.id }"
            @click="selectHabit(h.habit.id)"
          >
            <div class="habit-card__left">
              <div
                class="habit-card__avatar"
                :style="{ backgroundColor: h.habit.color }"
              >
                <icon-trophy :size="14" style="color: #fff" />
              </div>
              <div class="habit-card__info">
                <span class="habit-card__name">{{ h.habit.name }}</span>
                <div class="habit-card__stats">
                  <span class="habit-card__streak">
                    <icon-fire :size="12" :style="{ color: h.streak > 0 ? 'var(--jt-error)' : 'currentColor' }" />
                    {{ h.streak }} 天
                  </span>
                  <span class="habit-card__total">
                    <icon-calendar :size="12" />
                    累计 {{ h.totalDays }} 天
                  </span>
                </div>
              </div>
            </div>

            <!-- 本周 7 圆圈（点击不冒泡到 card） -->
            <div class="habit-card__week" @click.stop>
              <button
                v-for="d in thisWeek"
                :key="d.date"
                class="habit-card__day-dot"
                :class="{
                  'habit-card__day-dot--done': isLogged(h.habit.id, d.date),
                  'habit-card__day-dot--today': d.isToday,
                }"
                :style="isLogged(h.habit.id, d.date) ? { backgroundColor: h.habit.color, borderColor: h.habit.color } : {}"
                :title="`${d.label} ${d.day} — ${isLogged(h.habit.id, d.date) ? '已打卡' : '未打卡'}`"
                @click="toggleDay(h.habit.id, d.date)"
              />
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div
          v-if="!habitStore.loading && habitStore.habits.length === 0"
          class="habit-view__empty"
        >
          <span class="habit-view__empty-icon">🌱</span>
          <p class="habit-view__empty-title">还没有习惯</p>
          <p class="habit-view__empty-hint">点击右上角 + 创建一个习惯开始打卡吧</p>
        </div>
      </div>

      <!-- 右侧：选中 habit 的详情面板 -->
      <aside v-if="selectedHabit" class="habit-detail">
        <!-- 顶部：图标 + 名称 + 更多 -->
        <div class="habit-detail__header">
          <div class="habit-detail__title">
            <div
              class="habit-detail__avatar"
              :style="{ backgroundColor: selectedHabit.habit.color }"
            >
              <icon-trophy :size="16" style="color: #fff" />
            </div>
            <span class="habit-detail__name">{{ selectedHabit.habit.name }}</span>
          </div>
          <a-button type="text" size="mini" title="更多">
            <template #icon><icon-more :size="16" /></template>
          </a-button>
        </div>

        <!-- 4 个统计卡片 -->
        <div class="habit-detail__stats">
          <div class="habit-detail__stat">
            <div class="habit-detail__stat-label">
              <icon-check-circle :size="12" style="color: var(--jt-success)" />
              <span>月打卡</span>
            </div>
            <div class="habit-detail__stat-value">
              <span class="habit-detail__stat-num">{{ detailMonthLoggedCount }}</span>
              <span class="habit-detail__stat-unit">天</span>
            </div>
          </div>
          <div class="habit-detail__stat">
            <div class="habit-detail__stat-label">
              <icon-bolt :size="12" style="color: var(--jt-primary)" />
              <span>总打卡</span>
            </div>
            <div class="habit-detail__stat-value">
              <span class="habit-detail__stat-num">{{ selectedHabit.totalDays }}</span>
              <span class="habit-detail__stat-unit">天</span>
            </div>
          </div>
          <div class="habit-detail__stat">
            <div class="habit-detail__stat-label">
              <icon-percentage :size="12" style="color: var(--jt-warning)" />
              <span>月完成率</span>
            </div>
            <div class="habit-detail__stat-value">
              <span class="habit-detail__stat-num">{{ detailMonthRate }}</span>
              <span class="habit-detail__stat-unit">%</span>
            </div>
          </div>
          <div class="habit-detail__stat">
            <div class="habit-detail__stat-label">
              <icon-fire :size="12" style="color: var(--jt-error)" />
              <span>当前连续</span>
            </div>
            <div class="habit-detail__stat-value">
              <span class="habit-detail__stat-num">{{ selectedHabit.streak }}</span>
              <span class="habit-detail__stat-unit">天</span>
            </div>
          </div>
        </div>

        <!-- 月历 -->
        <div class="habit-detail__calendar">
          <div class="habit-detail__cal-header">
            <a-button type="text" size="mini" @click="prevMonth">
              <template #icon><icon-left :size="14" /></template>
            </a-button>
            <span class="habit-detail__cal-title">{{ detailMonthLabel }}</span>
            <a-button type="text" size="mini" @click="nextMonth">
              <template #icon><icon-right :size="14" /></template>
            </a-button>
          </div>
          <div class="habit-detail__cal-weekdays">
            <span v-for="(w, i) in WEEKDAY_LABELS" :key="i">{{ w.slice(1) }}</span>
          </div>
          <div class="habit-detail__cal-grid">
            <button
              v-for="c in detailMonthGrid"
              :key="c.date"
              class="habit-detail__cal-day"
              :class="{
                'habit-detail__cal-day--off': !c.inMonth,
                'habit-detail__cal-day--today': c.isToday,
                'habit-detail__cal-day--done': isLogged(selectedHabit.habit.id, c.date),
              }"
              :style="isLogged(selectedHabit.habit.id, c.date) ? { backgroundColor: selectedHabit.habit.color, borderColor: selectedHabit.habit.color } : {}"
              :title="`${c.date} — ${isLogged(selectedHabit.habit.id, c.date) ? '已打卡' : '未打卡'}`"
              @click="toggleDay(selectedHabit.habit.id, c.date)"
            >
              <span v-if="c.inMonth" class="habit-detail__cal-day-num">{{ c.day }}</span>
            </button>
          </div>
        </div>
      </aside>
    </div>

    <!-- 新建习惯弹窗（与侧栏同风格：QuickAdd + TeleportPopper） -->
    <a-modal
      v-model:visible="showCreateDialog"
      :width="440"
      :footer="false"
      :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
      modal-class="sidebar-create-modal"
    >
      <div class="sidebar-create">
        <div class="sidebar-create__input-row">
          <input
            ref="newNameInputRef"
            v-model="newName"
            class="sidebar-create__input"
            placeholder="习惯名称"
            @keydown.enter="createHabit"
            @keydown.escape.stop="showCreateDialog = false"
          />
          <button
            class="sidebar-create__close"
            title="关闭"
            @click="showCreateDialog = false"
          >
            <icon-close :size="14" />
          </button>
        </div>
        <div class="sidebar-create__divider" />
        <div class="sidebar-create__attrs">
          <!-- 时段 trigger -->
          <button
            data-time-of-day-trigger
            type="button"
            class="sidebar-create__trigger"
            @click="onClickTimeOfDayTrigger($event)"
          >
            <icon-clock :size="13" />
            <span>{{ GROUP_LABELS[newTimeOfDay] }}</span>
          </button>

          <!-- 颜色 trigger -->
          <button
            data-color-trigger="habit"
            type="button"
            class="sidebar-create__trigger"
            @click="onClickColorTrigger($event)"
          >
            <span
              class="sidebar-create__color-dot"
              :style="{ backgroundColor: newColor }"
            />
            <span>颜色</span>
          </button>

          <span class="sidebar-create__spacer" />
          <span class="sidebar-create__hint">回车保存</span>
        </div>
      </div>
    </a-modal>

    <!-- 时段 picker 弹层（Teleport 到 body） -->
    <TeleportPopper
      v-model:visible="timeOfDayPickerOpen"
      :anchor="timeOfDayTriggerEl"
      placement="bottom-left"
    >
      <div class="sidebar-create__color-picker sidebar-create__timeofday">
        <button
          v-for="opt in TIME_OF_DAY_OPTIONS"
          :key="opt.value"
          class="sidebar-create__timeofday-item"
          :class="{ 'sidebar-create__timeofday-item--active': newTimeOfDay === opt.value }"
          @click="newTimeOfDay = opt.value; timeOfDayPickerOpen = false"
        >
          {{ opt.label }}
        </button>
      </div>
    </TeleportPopper>

    <!-- 颜色 picker 弹层（Teleport 到 body） -->
    <TeleportPopper
      v-model:visible="colorPickerOpen"
      :anchor="colorTriggerEl"
      placement="bottom-left"
    >
      <div class="sidebar-create__color-picker">
        <button
          v-for="c in colors"
          :key="c"
          class="sidebar-create__color-swatch"
          :class="{ 'sidebar-create__color-swatch--active': newColor === c }"
          :style="{ backgroundColor: c }"
          @click="newColor = c; colorPickerOpen = false"
        />
      </div>
    </TeleportPopper>
  </div>
</template>

<style scoped>
.habit-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 24px;
  gap: 16px;
  overflow: hidden;
}

/* 双栏容器：左侧列表 + 右侧详情 */
.habit-view__main {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.habit-view__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.habit-view__title {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 24px;
  letter-spacing: -0.02em;
  color: var(--jt-text-primary);
  margin: 0;
}

/* 顶部本周日期横排 */
.habit-view__week-strip {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  flex-shrink: 0;
  padding: 12px 4px;
  border-radius: 12px;
  background-color: var(--jt-surface-sunken);
}

.habit-view__week-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  position: relative;
}

.habit-view__week-label {
  font-size: 11px;
  color: var(--jt-text-tertiary);
}

.habit-view__week-day {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
}

.habit-view__week-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1.5px solid var(--jt-border);
  background: transparent;
}

.habit-view__week-cell--today .habit-view__week-day {
  color: var(--jt-primary);
  font-weight: 600;
}
.habit-view__week-cell--today .habit-view__week-dot {
  border-color: var(--jt-primary);
  background: transparent;
}

/* 列表 + 分组 */
.habit-view__list {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.habit-view__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.habit-view__group-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.habit-view__group-caret {
  color: var(--jt-text-tertiary);
}

.habit-view__group-name {
  font-weight: 500;
}

.habit-view__group-count {
  color: var(--jt-text-tertiary);
  font-size: 11px;
  margin-left: 2px;
}

/* 习惯项 */
.habit-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 10px;
  background-color: var(--jt-surface-sunken);
  border: 1px solid transparent;
  transition: border-color 0.15s;
}
.habit-card:hover {
  border-color: var(--jt-border);
}

.habit-card--selected {
  border-color: var(--jt-primary);
  background-color: var(--jt-accent-soft);
}
.habit-card--selected .habit-card__name {
  color: var(--jt-primary);
}

.habit-card__left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.habit-card__avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.habit-card__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.habit-card__name {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.habit-card__stats {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--jt-text-tertiary);
}

.habit-card__streak,
.habit-card__total {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* 本周 7 圆圈 */
.habit-card__week {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.habit-card__day-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--jt-border);
  background: transparent;
  cursor: pointer;
  padding: 0;
  transition: transform 0.1s ease;
}
.habit-card__day-dot:hover {
  transform: scale(1.15);
}
.habit-card__day-dot--done {
  border-color: transparent;
}
.habit-card__day-dot--today:not(.habit-card__day-dot--done) {
  border-color: var(--jt-primary);
  border-width: 2px;
}

/* 空状态 */
.habit-view__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  gap: 8px;
  text-align: center;
}

.habit-view__empty-icon {
  font-size: 48px;
  opacity: 0.6;
}

.habit-view__empty-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--jt-text-secondary);
  margin: 0;
}

.habit-view__empty-hint {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  margin: 0;
}

/* 右侧详情面板 */
.habit-detail {
  flex: 0 0 380px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  background-color: var(--jt-surface-sunken);
  border-radius: 12px;
  overflow-y: auto;
}

.habit-detail__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}

.habit-detail__title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.habit-detail__avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.habit-detail__name {
  font-size: 16px;
  font-weight: 600;
  color: var(--jt-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 4 个统计卡片：2 × 2 网格 */
.habit-detail__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  flex-shrink: 0;
}

.habit-detail__stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background-color: var(--jt-surface);
  border-radius: 8px;
}

.habit-detail__stat-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--jt-text-tertiary);
}

.habit-detail__stat-value {
  display: flex;
  align-items: baseline;
  gap: 2px;
}

.habit-detail__stat-num {
  font-size: 20px;
  font-weight: 600;
  color: var(--jt-text-primary);
  line-height: 1;
}

.habit-detail__stat-unit {
  font-size: 11px;
  color: var(--jt-text-tertiary);
}

/* 月历 */
.habit-detail__calendar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background-color: var(--jt-surface);
  border-radius: 10px;
  flex: 1;
  min-height: 0;
}

.habit-detail__cal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
}

.habit-detail__cal-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
}

.habit-detail__cal-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  font-size: 11px;
  color: var(--jt-text-tertiary);
  padding: 0 4px;
}

.habit-detail__cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  padding: 0 4px;
}

.habit-detail__cal-day {
  aspect-ratio: 1;
  border-radius: 50%;
  border: 1.5px solid var(--jt-border);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: transform 0.1s ease, background-color 0.1s ease;
}

.habit-detail__cal-day:hover:not(.habit-detail__cal-day--off) {
  transform: scale(1.1);
}

.habit-detail__cal-day--off {
  border-color: transparent;
  cursor: default;
  pointer-events: none;
}

.habit-detail__cal-day--today:not(.habit-detail__cal-day--done) {
  border-color: var(--jt-primary);
  border-width: 2px;
}

.habit-detail__cal-day--done {
  border-color: transparent;
}

.habit-detail__cal-day-num {
  font-size: 11px;
  color: var(--jt-text-primary);
}
.habit-detail__cal-day--off .habit-detail__cal-day-num {
  color: transparent;
}
.habit-detail__cal-day--done .habit-detail__cal-day-num {
  color: #fff;
  font-weight: 500;
}
</style>

<style scoped>
/* 时段 picker 浮层内的选项（3 个文字按钮） */
.sidebar-create__timeofday {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  min-width: 80px;
}

.sidebar-create__timeofday-item {
  border: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--jt-text-primary);
  padding: 6px 14px;
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.1s ease;
}

.sidebar-create__timeofday-item:hover {
  background-color: var(--jt-surface-hover);
}

.sidebar-create__timeofday-item--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}
</style>
