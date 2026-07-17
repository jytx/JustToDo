<script setup lang="ts">
// 习惯打卡视图 —— 滴答清单风格：
// 顶部 7 圆圈（本周日期）+ 习惯按时段分组（上午/下午/晚上）+ 每项右侧 7 圆圈（本周打卡）
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useHabitStore } from "@/stores/habit";
import TeleportPopper from "@/components/TeleportPopper.vue";
import type { HabitWithStats } from "@/api/db";

const habitStore = useHabitStore();
const showCreateDialog = ref(false);
const newName = ref("");
const newNameInputRef = ref<HTMLInputElement | null>(null);
const newColor = ref("#10B981");
/** 新建/编辑共用时段字段（morning/afternoon/evening） */
const newTimeOfDay = ref<"morning" | "afternoon" | "evening">("evening");
/** emoji 图标 */
const newIcon = ref("📚");
/** 目标顿次（每天打卡次数，默认 1） */
const newTargetCount = ref(1);
/** 提醒时间 HH:MM（空 = 不提醒） */
const newRemindAt = ref("");
/** 重复规则字符串 */
const newRepeatRule = ref<string>("daily");

/** 「编辑」模式：当前正在编辑的 habit id（null = 新建模式） */
const editingHabitId = ref<string | null>(null);

/** 「更多」菜单：显示 + trigger 元素 */
const moreMenuOpen = ref(false);
const moreTriggerEl = ref<HTMLElement | null>(null);
function onClickMore(e: MouseEvent) {
  moreTriggerEl.value = e.currentTarget as HTMLElement;
  moreMenuOpen.value = !moreMenuOpen.value;
  // 关闭其他 picker
  colorPickerOpen.value = false;
  timeOfDayPickerOpen.value = false;
  iconPickerOpen.value = false;
  repeatPickerOpen.value = false;
}

/** 删除确认弹窗 */
const confirmDelete = ref(false);
async function confirmDeleteHabit() {
  if (!selectedHabitId.value) return;
  await habitStore.deleteHabit(selectedHabitId.value);
  confirmDelete.value = false;
  showCreateDialog.value = false;
  editingHabitId.value = null;
  newName.value = "";
  selectedHabitId.value = null;
}

const colors = [
  "#EF4444", "#F59E0B", "#EAB308", "#10B981",
  "#3B82F6", "#8B5CF6", "#EC4899", "#6B7280",
];

/** 预设 emoji 图标 */
const ICON_OPTIONS = [
  "📚", "🏃", "💪", "🧘", "🍎", "💧",
  "😴", "✍️", "🎯", "🎨", "🎵", "📱",
  "💻", "🚶", "🥗", "☕", "📖", "🏆",
  "❤️", "🌱", "🔥", "⭐", "💡", "🎁",
];

const TIME_OF_DAY_OPTIONS: Array<{
  value: "morning" | "afternoon" | "evening";
  label: string;
}> = [
  { value: "morning", label: "上午" },
  { value: "afternoon", label: "下午" },
  { value: "evening", label: "晚上" },
];

const REPEAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "mon_wed_fri", label: "每周一三五" },
  { value: "tue_thu", label: "每周二四" },
];

function repeatLabel(value: string): string {
  return REPEAT_OPTIONS.find((o) => o.value === value)?.label ?? "每天";
}

/** 关闭所有 picker（互斥） */
function closeAllPickers(except?: "color" | "timeOfDay" | "icon" | "repeat") {
  if (except !== "color") colorPickerOpen.value = false;
  if (except !== "timeOfDay") timeOfDayPickerOpen.value = false;
  if (except !== "icon") iconPickerOpen.value = false;
  if (except !== "repeat") repeatPickerOpen.value = false;
}

/** 颜色 trigger 元素 + 弹层状态 */
const colorTriggerEl = ref<HTMLElement | null>(null);
const colorPickerOpen = ref(false);

/** 时段 trigger 元素 + 弹层状态 */
const timeOfDayTriggerEl = ref<HTMLElement | null>(null);
const timeOfDayPickerOpen = ref(false);

/** 图标 trigger 元素 + 弹层状态 */
const iconTriggerEl = ref<HTMLElement | null>(null);
const iconPickerOpen = ref(false);

/** 重复 trigger 元素 + 弹层状态 */
const repeatTriggerEl = ref<HTMLElement | null>(null);
const repeatPickerOpen = ref(false);

function onClickColorTrigger(e: MouseEvent) {
  colorTriggerEl.value = e.currentTarget as HTMLElement;
  const willOpen = !colorPickerOpen.value;
  closeAllPickers();
  colorPickerOpen.value = willOpen;
}
function onClickTimeOfDayTrigger(e: MouseEvent) {
  timeOfDayTriggerEl.value = e.currentTarget as HTMLElement;
  const willOpen = !timeOfDayPickerOpen.value;
  closeAllPickers();
  timeOfDayPickerOpen.value = willOpen;
}
function onClickIconTrigger(e: MouseEvent) {
  iconTriggerEl.value = e.currentTarget as HTMLElement;
  const willOpen = !iconPickerOpen.value;
  closeAllPickers();
  iconPickerOpen.value = willOpen;
}
function onClickRepeatTrigger(e: MouseEvent) {
  repeatTriggerEl.value = e.currentTarget as HTMLElement;
  const willOpen = !repeatPickerOpen.value;
  closeAllPickers();
  repeatPickerOpen.value = willOpen;
}

/** 重置表单到默认值 */
function resetForm() {
  newName.value = "";
  newColor.value = "#10B981";
  newTimeOfDay.value = "evening";
  newIcon.value = "📚";
  newTargetCount.value = 1;
  newRemindAt.value = "";
  newRepeatRule.value = "daily";
}

function openCreateDialog() {
  resetForm();
  editingHabitId.value = null;
  showCreateDialog.value = true;
  nextTick(() => {
    newNameInputRef.value?.focus();
  });
}

/** 「更多」菜单 → 编辑 */
function startEditHabit() {
  moreMenuOpen.value = false;
  if (!selectedHabit.value) return;
  const h = selectedHabit.value.habit;
  editingHabitId.value = h.id;
  newName.value = h.name;
  newColor.value = h.color;
  newTimeOfDay.value = h.timeOfDay;
  newIcon.value = h.icon || "📚";
  newTargetCount.value = h.targetCount || 1;
  newRemindAt.value = h.remindAt ?? "";
  newRepeatRule.value = h.repeatRule || "daily";
  showCreateDialog.value = true;
  nextTick(() => {
    newNameInputRef.value?.focus();
  });
}

/** 「更多」菜单 → 删除（弹确认框） */
function askDeleteHabit() {
  moreMenuOpen.value = false;
  confirmDelete.value = true;
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
  // 默认选中第一个习惯，让右侧详情面板有内容
  if (!selectedHabitId.value && habitStore.habits.length > 0) {
    selectedHabitId.value = habitStore.habits[0].habit.id;
  }
}

onMounted(loadData);

// 监听 store 信号：侧栏「+」按钮 fireCreateDialog → 打开新建弹窗
// 初始值 > 0 时不触发（避免 mount 时误开）
watch(
  () => habitStore.createDialogSignal,
  (n, old) => {
    if (n > 0 && n !== old) {
      openCreateDialog();
    }
  },
);

async function createOrUpdateHabit() {
  const name = newName.value.trim();
  if (!name) {
    showCreateDialog.value = false;
    return;
  }
  // 提醒时间：空字符串 → null（不提醒）
  const remindAt = newRemindAt.value.trim() || null;
  if (editingHabitId.value) {
    // 编辑模式：调 updateHabit
    await habitStore.updateHabit({
      id: editingHabitId.value,
      name,
      color: newColor.value,
      timeOfDay: newTimeOfDay.value,
      icon: newIcon.value,
      repeatRule: newRepeatRule.value,
      targetCount: newTargetCount.value,
      remindAt,
    });
  } else {
    // 新建模式
    await habitStore.createHabit({
      name,
      color: newColor.value,
      timeOfDay: newTimeOfDay.value,
      icon: newIcon.value,
      repeatRule: newRepeatRule.value,
      targetCount: newTargetCount.value,
      remindAt,
    });
  }
  showCreateDialog.value = false;
  editingHabitId.value = null;
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
                <span class="habit-card__avatar-icon">{{ h.habit.icon || "🏆" }}</span>
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
              <span class="habit-detail__avatar-icon">{{ selectedHabit.habit.icon || "🏆" }}</span>
            </div>
            <span class="habit-detail__name">{{ selectedHabit.habit.name }}</span>
          </div>
          <a-button
            type="text"
            size="mini"
            title="更多"
            @click="onClickMore($event)"
          >
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
              :disabled="!c.inMonth"
              @click="toggleDay(selectedHabit.habit.id, c.date)"
            >
              <span class="habit-detail__cal-day-num">{{ c.day }}</span>
            </button>
          </div>
        </div>
      </aside>
    </div>

    <!-- 新建/编辑习惯弹窗（完整表单：图标 + 名称 + 5 个属性行） -->
    <a-modal
      v-model:visible="showCreateDialog"
      :width="480"
      :footer="false"
      :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
      modal-class="habit-form-modal"
    >
      <div class="habit-form">
        <!-- 顶部：大图标 + 名称 + 关闭 -->
        <div class="habit-form__head">
          <div
            class="habit-form__avatar"
            :style="{ backgroundColor: newColor }"
            @click="onClickIconTrigger($event)"
          >
            <span class="habit-form__avatar-icon">{{ newIcon }}</span>
          </div>
          <input
            ref="newNameInputRef"
            v-model="newName"
            class="habit-form__name"
            placeholder="习惯名称"
            @keydown.enter="createOrUpdateHabit"
            @keydown.escape.stop="showCreateDialog = false"
          />
          <button
            class="habit-form__close"
            title="关闭"
            @click="showCreateDialog = false"
          >
            <icon-close :size="14" />
          </button>
        </div>

        <!-- 属性行：图标 / 颜色 / 时段 / 目标 / 提醒 / 重复 -->
        <div class="habit-form__attrs">
          <button
            data-icon-trigger
            type="button"
            class="habit-form__row"
            @click="onClickIconTrigger($event)"
          >
            <span class="habit-form__row-label">图标</span>
            <span class="habit-form__row-value">{{ newIcon }}</span>
          </button>

          <button
            data-color-trigger="habit"
            type="button"
            class="habit-form__row"
            @click="onClickColorTrigger($event)"
          >
            <span class="habit-form__row-label">颜色</span>
            <span class="habit-form__row-value">
              <span class="habit-form__color-dot" :style="{ backgroundColor: newColor }" />
            </span>
          </button>

          <button
            data-time-of-day-trigger
            type="button"
            class="habit-form__row"
            @click="onClickTimeOfDayTrigger($event)"
          >
            <span class="habit-form__row-label">时段</span>
            <span class="habit-form__row-value">{{ GROUP_LABELS[newTimeOfDay] }}</span>
          </button>

          <div class="habit-form__row habit-form__row--static">
            <span class="habit-form__row-label">目标</span>
            <span class="habit-form__row-value">
              <input
                v-model.number="newTargetCount"
                type="number"
                min="1"
                max="99"
                class="habit-form__number"
              />
              <span class="habit-form__unit">次 / 天</span>
            </span>
          </div>

          <div class="habit-form__row habit-form__row--static">
            <span class="habit-form__row-label">提醒</span>
            <span class="habit-form__row-value">
              <input
                v-model="newRemindAt"
                type="time"
                class="habit-form__time"
              />
              <span v-if="!newRemindAt" class="habit-form__placeholder">不提醒</span>
            </span>
          </div>

          <button
            data-repeat-trigger
            type="button"
            class="habit-form__row"
            @click="onClickRepeatTrigger($event)"
          >
            <span class="habit-form__row-label">重复</span>
            <span class="habit-form__row-value">{{ repeatLabel(newRepeatRule) }}</span>
          </button>
        </div>

        <!-- 底部提示 -->
        <div class="habit-form__foot">
          <span class="habit-form__hint">{{ editingHabitId ? "回车保存" : "回车创建" }}</span>
        </div>
      </div>
    </a-modal>

    <!-- 图标 picker 弹层 -->
    <TeleportPopper
      v-model:visible="iconPickerOpen"
      :anchor="iconTriggerEl"
      placement="bottom-left"
    >
      <div class="habit-form__icon-grid">
        <button
          v-for="ic in ICON_OPTIONS"
          :key="ic"
          class="habit-form__icon-cell"
          :class="{ 'habit-form__icon-cell--active': newIcon === ic }"
          @click="newIcon = ic; iconPickerOpen = false"
        >
          {{ ic }}
        </button>
      </div>
    </TeleportPopper>

    <!-- 颜色 picker 弹层 -->
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

    <!-- 时段 picker 弹层 -->
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

    <!-- 重复 picker 弹层 -->
    <TeleportPopper
      v-model:visible="repeatPickerOpen"
      :anchor="repeatTriggerEl"
      placement="bottom-left"
    >
      <div class="sidebar-create__color-picker sidebar-create__timeofday">
        <button
          v-for="opt in REPEAT_OPTIONS"
          :key="opt.value"
          class="sidebar-create__timeofday-item"
          :class="{ 'sidebar-create__timeofday-item--active': newRepeatRule === opt.value }"
          @click="newRepeatRule = opt.value; repeatPickerOpen = false"
        >
          {{ opt.label }}
        </button>
      </div>
    </TeleportPopper>

    <!-- 「更多」菜单：编辑 / 删除 -->
    <TeleportPopper
      v-model:visible="moreMenuOpen"
      :anchor="moreTriggerEl"
      placement="bottom-right"
    >
      <div class="habit-more-menu">
        <button class="habit-more-menu__item" @click="startEditHabit">
          <icon-edit :size="14" />
          <span>编辑</span>
        </button>
        <button class="habit-more-menu__item habit-more-menu__item--danger" @click="askDeleteHabit">
          <icon-delete :size="14" />
          <span>删除</span>
        </button>
      </div>
    </TeleportPopper>

    <!-- 删除确认弹窗 -->
    <a-modal
      :visible="confirmDelete"
      :width="380"
      title="确认删除"
      @cancel="confirmDelete = false"
      @ok="confirmDeleteHabit"
    >
      <p>
        确定要删除习惯
        <strong>「{{ selectedHabit?.habit.name }}」</strong>
        吗？
      </p>
      <p class="habit-delete-warn">
        ⚠️ 该习惯的 {{ selectedHabit?.totalDays ?? 0 }} 条打卡记录将一并删除，且不可恢复。
      </p>
      <template #footer>
        <a-button @click="confirmDelete = false">取消</a-button>
        <a-button status="danger" type="primary" @click="confirmDeleteHabit">删除</a-button>
      </template>
    </a-modal>
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
  flex: 0 0 640px;
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
  gap: 12px;
  flex-shrink: 0;
}

.habit-detail__stat {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 18px 16px;
  background-color: var(--jt-surface);
  border-radius: 10px;
}

.habit-detail__stat-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--jt-text-tertiary);
}

.habit-detail__stat-value {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.habit-detail__stat-num {
  font-size: 30px;
  font-weight: 600;
  color: var(--jt-text-primary);
  line-height: 1;
}

.habit-detail__stat-unit {
  font-size: 13px;
  color: var(--jt-text-tertiary);
}

/* 月历 */
.habit-detail__calendar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
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
  font-size: 16px;
  font-weight: 600;
  color: var(--jt-text-primary);
}

.habit-detail__cal-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  padding: 0 4px;
}

.habit-detail__cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  /* 6 行（部分月跨 6 周）等高填满容器，配合行间 gap 留呼吸 */
  grid-template-rows: repeat(6, 1fr);
  gap: 14px 16px;
  padding: 4px 8px;
  justify-items: center;
  align-content: stretch;
  flex: 1;
  min-height: 0;
}

.habit-detail__cal-day {
  width: 100%;
  aspect-ratio: 1;
  max-width: 50px;
  border-radius: 50%;
  border: 1.5px solid var(--jt-border);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: transform 0.1s ease, background-color 0.1s ease;
  font-family: inherit;
}

.habit-detail__cal-day:hover:not(:disabled) {
  transform: scale(1.1);
}

.habit-detail__cal-day--off {
  border-color: transparent;
  cursor: not-allowed;
  opacity: 0.35;
}

.habit-detail__cal-day--today:not(.habit-detail__cal-day--done) {
  border-color: var(--jt-primary);
  border-width: 2px;
}

.habit-detail__cal-day--done {
  border-color: transparent;
}

.habit-detail__cal-day-num {
  font-size: 13px;
  color: var(--jt-text-primary);
}
.habit-detail__cal-day--off .habit-detail__cal-day-num {
  color: var(--jt-text-tertiary);
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

/* 「更多」菜单（编辑/删除） */
.habit-more-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 120px;
  padding: 4px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
}

.habit-more-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  border: none;
  background: transparent;
  border-radius: 5px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--jt-text-primary);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.habit-more-menu__item:hover {
  background-color: var(--jt-surface-hover);
}

.habit-more-menu__item--danger {
  color: var(--jt-error);
}

.habit-more-menu__item--danger:hover {
  background-color: rgba(245, 34, 45, 0.08);
}

/* 删除确认弹窗内的提示文字 */
.habit-delete-warn {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 8px 0 0;
}

/* === 习惯卡片/详情的 avatar emoji 文字 === */
.habit-card__avatar-icon,
.habit-detail__avatar-icon {
  font-size: 14px;
  line-height: 1;
}
.habit-detail__avatar-icon {
  font-size: 18px;
}

/* === 新建/编辑习惯弹窗（完整表单） === */
.habit-form-modal .arco-modal-header {
  display: none;
}
.habit-form-modal .arco-modal-body {
  padding: 0;
}
.habit-form-modal .arco-modal {
  border-radius: 12px;
  overflow: hidden;
}

.habit-form {
  display: flex;
  flex-direction: column;
}

/* 顶部：大图标 + 名称 + 关闭 */
.habit-form__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 14px;
}

.habit-form__avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  transition: transform 0.1s ease;
}
.habit-form__avatar:hover {
  transform: scale(1.05);
}

.habit-form__avatar-icon {
  font-size: 24px;
  line-height: 1;
}

.habit-form__name {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 16px;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  line-height: 1.4;
}
.habit-form__name::placeholder {
  color: var(--jt-text-tertiary);
}

.habit-form__close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.habit-form__close:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

/* 属性行：垂直堆叠 */
.habit-form__attrs {
  display: flex;
  flex-direction: column;
  padding: 4px 12px 12px;
  gap: 2px;
}

.habit-form__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 8px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
  transition: background-color 0.1s ease;
}
.habit-form__row:hover {
  background-color: var(--jt-surface-hover);
}

.habit-form__row-label {
  font-size: 13px;
  color: var(--jt-text-secondary);
  flex-shrink: 0;
}

.habit-form__row-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--jt-text-primary);
}

.habit-form__color-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: inline-block;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}

/* 静态行（直接嵌入 input）：number / time */
.habit-form__row--static {
  cursor: default;
}
.habit-form__row--static:hover {
  background-color: var(--jt-surface-hover);
}

.habit-form__number {
  width: 48px;
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--jt-text-primary);
  background-color: var(--jt-surface);
  outline: none;
  text-align: center;
}
.habit-form__number:focus {
  border-color: var(--jt-primary);
}

.habit-form__unit {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.habit-form__time {
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--jt-text-primary);
  background-color: var(--jt-surface);
  outline: none;
}
.habit-form__time:focus {
  border-color: var(--jt-primary);
}

.habit-form__placeholder {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

/* 底部提示 */
.habit-form__foot {
  padding: 0 20px 14px;
  text-align: right;
}
.habit-form__hint {
  font-size: 11px;
  color: var(--jt-text-tertiary);
}

/* === Icon picker grid === */
.habit-form__icon-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  padding: 8px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 10px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
}

.habit-form__icon-cell {
  width: 36px;
  height: 36px;
  border: 1.5px solid transparent;
  border-radius: 8px;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.1s ease, transform 0.1s ease;
}
.habit-form__icon-cell:hover {
  background-color: var(--jt-surface-hover);
  transform: scale(1.1);
}
.habit-form__icon-cell--active {
  background-color: var(--jt-accent-soft);
  border-color: var(--jt-primary);
}
</style>
