<script setup lang="ts">
// 提醒弹层 —— 两种互斥提醒方式：
//   1. 相对截止时间偏移（准点 / 提前 N 分钟），用 remindOffsetMinutes —— 预设列表直接选
//   2. 指定绝对时刻（如 8月20日 15:00），用 remindAt —— hover「指定时刻…」
//      在弹层左外侧级联展开 DatePopover（单时刻模式，与截止日期同款月历 + 时分面板）
// 同一时刻只有一种生效，选中一种确认时会清空另一种（由调用方落库时保证）。
import { ref, computed, watch } from "vue";
import {
  REMIND_PRESETS,
  matchRemindPreset,
  type ReminderConfirmPayload,
} from "@/types";
import { parseLocalIso } from "@/utils/date";
import DatePopover from "./DatePopover.vue";

const props = defineProps<{
  /** 当前相对提醒偏移（分钟），null = 不提醒 */
  value: number | null;
  /** 当前指定时刻提醒（本地字面量），null = 未启用 */
  remindAt: string | null;
}>();

const emit = defineEmits<{
  confirm: [payload: ReminderConfirmPayload];
  clear: [];
}>();

// ─── 一级：预设列表（相对偏移） ──────────────────────
// 当前选中预设索引；NO_PRESET(-1) = 任务为指定时刻提醒（无预设高亮）
const NO_PRESET = -1;
const currentPresetIndex = ref(0);
const customMinutes = ref(0);

const isCustomOffset = computed(
  () => REMIND_PRESETS[currentPresetIndex.value]?.preset === false,
);

watch(
  () => [props.value, props.remindAt] as const,
  ([v, at]) => {
    if (at != null) {
      currentPresetIndex.value = NO_PRESET;
      return;
    }
    const idx = matchRemindPreset(v);
    currentPresetIndex.value = idx;
    if (idx === REMIND_PRESETS.length - 1) {
      customMinutes.value = typeof v === "number" ? v : 0;
    }
  },
  { immediate: true },
);

function selectPreset(i: number): void {
  currentPresetIndex.value = i;
}

/** 一级底部「确定」：按当前选中的预设确认偏移提醒 */
function onConfirm(): void {
  const p = REMIND_PRESETS[currentPresetIndex.value];
  if (!p) return;
  if (p.value === null) {
    emit("confirm", { type: "offset", value: null });
  } else if (p.preset) {
    emit("confirm", { type: "offset", value: p.value });
  } else {
    emit("confirm", { type: "offset", value: customMinutes.value });
  }
}

// ─── 指定时刻：级联面板（hover 展开，复用 DatePopover） ──
// 显隐控制：mouseenter 打开，mouseleave 后延迟 200ms 关闭
// （留出鼠标从入口项横移进面板的时间窗口；进入面板即取消关闭）
const atPanelVisible = ref(false);
let atPanelCloseTimer: number | null = null;

/** 任务当前是否为指定时刻提醒（「指定时刻…」项高亮） */
const isAtActive = computed(() => props.remindAt != null);

/** 「指定时刻…」项展示的当前生效时刻（如 "8月20日 15:00"） */
const atLabel = computed<string | null>(() => {
  const d = props.remindAt ? parseLocalIso(props.remindAt) : null;
  if (!d) return null;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
});

/** 级联面板回填值：已设提醒用原值，否则默认今天下一个整点（方便微调） */
const atPreviewIso = computed<string>(() => props.remindAt ?? nextHourIso());

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 今天下一个整点的本地字面量（指定时刻的默认值） */
function nextHourIso(): string {
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}T${pad2(next.getHours())}:00:00`;
}

function openAtPanel(): void {
  cancelCloseAtPanel();
  atPanelVisible.value = true;
}

function scheduleCloseAtPanel(): void {
  if (atPanelCloseTimer !== null) window.clearTimeout(atPanelCloseTimer);
  atPanelCloseTimer = window.setTimeout(() => {
    atPanelVisible.value = false;
    atPanelCloseTimer = null;
  }, 200);
}

function cancelCloseAtPanel(): void {
  if (atPanelCloseTimer !== null) {
    window.clearTimeout(atPanelCloseTimer);
    atPanelCloseTimer = null;
  }
}

/** hover 到其他预设项时立即收起面板 */
function hideAtPanel(): void {
  cancelCloseAtPanel();
  atPanelVisible.value = false;
}

/** 级联面板确定：DatePopover 单时刻 confirm(start, null) → 指定时刻提醒 */
function onAtConfirm(start: string | null): void {
  if (!start) {
    // 未选任何日期就确定（理论上不可达，快捷「无日期」走 clear 路径）：按不提醒兜底
    emit("clear");
    return;
  }
  emit("confirm", { type: "at", remindAt: start });
}
</script>

<template>
  <div class="reminder-popover">
    <!-- 一级：预设列表（hover「指定时刻…」时左外侧级联展开时刻面板） -->
    <div class="reminder-popover__list">
      <button
        v-for="(p, i) in REMIND_PRESETS"
        :key="i"
        type="button"
        class="reminder-popover__item"
        :class="{ 'reminder-popover__item--active': currentPresetIndex === i }"
        @mouseenter="hideAtPanel"
        @click="selectPreset(i)"
      >
        <icon-notification v-if="p.value !== null" :size="14" />
        <icon-close v-else :size="14" />
        <span>{{ p.label }}</span>
        <icon-check
          v-if="currentPresetIndex === i"
          :size="12"
          class="reminder-popover__check"
        />
      </button>
      <!-- 指定时刻：绝对时间提醒，hover 展开左侧级联面板选日期 + 时分 -->
      <button
        type="button"
        class="reminder-popover__item"
        :class="{ 'reminder-popover__item--active': isAtActive }"
        @mouseenter="openAtPanel"
        @mouseleave="scheduleCloseAtPanel"
      >
        <icon-clock-circle :size="14" />
        <span>指定时刻<template v-if="atLabel"> · {{ atLabel }}</template></span>
        <icon-right :size="12" class="reminder-popover__check" />
      </button>
    </div>

    <!-- 自定义分钟数（偏移模式） -->
    <div v-if="isCustomOffset" class="reminder-popover__custom">
      <label>提前</label>
      <a-input-number
        v-model="customMinutes"
        :min="0"
        :max="10080"
        :step="5"
        size="mini"
        style="width: 100px"
      />
      <span>分钟</span>
    </div>

    <!-- 级联面板：复用 DatePopover（单时刻模式：快捷 + 月历 + 时分 + 清除/确定） -->
    <div
      v-if="atPanelVisible"
      class="reminder-popover__at"
      @mouseenter="cancelCloseAtPanel"
      @mouseleave="scheduleCloseAtPanel"
    >
      <DatePopover
        :enable-range="false"
        :start-iso="atPreviewIso"
        :end-iso="null"
        @confirm="onAtConfirm"
        @clear="emit('clear')"
      />
    </div>

    <div class="reminder-popover__footer">
      <button
        type="button"
        class="reminder-popover__btn reminder-popover__btn--ghost"
        @click="emit('clear')"
      >
        不提醒
      </button>
      <button
        type="button"
        class="reminder-popover__btn reminder-popover__btn--primary"
        @click="onConfirm"
      >
        确定
      </button>
    </div>
  </div>
</template>

<style scoped>
.reminder-popover {
  /* 级联面板（.reminder-popover__at）的定位锚 */
  position: relative;
  width: 260px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 8px;
}

.reminder-popover__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.reminder-popover__item {
  display: flex;
  align-items: center;
  gap: 10px;
  border: none;
  background: transparent;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
}

.reminder-popover__item:hover {
  background: var(--jt-surface-sunken);
}

.reminder-popover__item--active {
  background: var(--jt-accent-soft);
  color: var(--jt-primary);
}

.reminder-popover__check {
  margin-left: auto;
}

.reminder-popover__custom {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-top: 4px;
  border-top: 1px solid var(--jt-border);
  font-size: 12px;
  color: var(--jt-text-secondary);
}

/* 级联面板：悬停「指定时刻…」时在弹层左外侧展开。
 * 详情面板固定在窗口右侧，弹层左侧空间充足；紧贴弹层边缘方便鼠标横移。
 * 无需自绘背景：内嵌的 DatePopover 自带卡片样式。 */
.reminder-popover__at {
  position: absolute;
  top: 0;
  /* 紧贴弹层左缘（-2px 让边距视觉上无缝） */
  right: calc(100% - 2px);
}

.reminder-popover__footer {
  display: flex;
  gap: 8px;
  padding: 8px 4px 4px;
  margin-top: 4px;
  border-top: 1px solid var(--jt-border);
}

.reminder-popover__btn {
  flex: 1;
  height: 28px;
  border-radius: 6px;
  border: none;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-body);
}

.reminder-popover__btn--ghost {
  background: transparent;
  color: var(--jt-text-secondary);
}

.reminder-popover__btn--ghost:hover {
  background: var(--jt-surface-sunken);
}

.reminder-popover__btn--primary {
  background: var(--jt-primary);
  color: #fff;
}
</style>
