<script setup lang="ts">
// 提醒弹层 —— 两种互斥提醒方式：
//   1. 相对截止时间偏移（准点 / 提前 N 分钟），用 remindOffsetMinutes
//   2. 指定绝对时刻（如 15:00），用 remindAt
// 同一时刻只有一种生效，选中一种确认时会清空另一种（由调用方落库时保证）。
import { ref, computed, watch } from "vue";
import {
  REMIND_PRESETS,
  matchRemindPreset,
  type ReminderConfirmPayload,
} from "@/types";
import { parseLocalIso } from "@/utils/date";

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

// 选中项索引：0..REMIND_PRESETS.length-1 为预设/自定义偏移；
// REMIND_PRESETS.length 为追加的「指定时刻」项
const AT_INDEX = REMIND_PRESETS.length;
const currentPresetIndex = ref(0);
const customMinutes = ref(0);
// 指定时刻的日期（YYYY-MM-DD）与时分，内部维护，确认时拼成本地字面量
const atDate = ref("");
const atHour = ref(9);
const atMinute = ref(0);

// 小时 0-23、分钟 5 步进（与 DatePopover 时分 picker 保持一致）
const hourOptions: number[] = Array.from({ length: 24 }, (_, i) => i);
const minuteOptions: number[] = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const isCustomOffset = computed(
  () => REMIND_PRESETS[currentPresetIndex.value]?.preset === false,
);
const isAt = computed(() => currentPresetIndex.value === AT_INDEX);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 把内部的日期 + 时分拼成本地字面量 "YYYY-MM-DDTHH:mm:ss" */
function buildAtIso(): string {
  return `${atDate.value}T${pad2(atHour.value)}:${pad2(atMinute.value)}:00`;
}

watch(
  () => [props.value, props.remindAt] as const,
  ([v, at]) => {
    if (at) {
      // 当前是指定时刻提醒：选中「指定时刻」并回填日期/时分
      currentPresetIndex.value = AT_INDEX;
      const d = parseLocalIso(at);
      if (d) {
        atDate.value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
          d.getDate(),
        )}`;
        atHour.value = d.getHours();
        // 分钟对齐到 5 步进（picker 只能选 5 的倍数）
        atMinute.value = Math.round(d.getMinutes() / 5) * 5;
        if (atMinute.value === 60) {
          atMinute.value = 55;
        }
      } else {
        initAtToNextHour();
      }
    } else {
      const idx = matchRemindPreset(v);
      currentPresetIndex.value = idx;
      if (idx === REMIND_PRESETS.length - 1) {
        // 自定义偏移
        customMinutes.value = typeof v === "number" ? v : 0;
      }
    }
  },
  { immediate: true },
);

/** 把「指定时刻」初始化为今天下一个整点（方便用户微调） */
function initAtToNextHour(): void {
  const now = new Date();
  atDate.value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
    now.getDate(),
  )}`;
  atHour.value = (now.getHours() + 1) % 24;
  atMinute.value = 0;
}

function selectPreset(i: number): void {
  currentPresetIndex.value = i;
  // 首次切到「指定时刻」时若未初始化，补一个默认值
  if (i === AT_INDEX && !atDate.value) {
    initAtToNextHour();
  }
}

function setHour(h: number): void {
  atHour.value = h;
}
function setMinute(m: number): void {
  atMinute.value = m;
}

function onConfirm(): void {
  if (isAt.value) {
    if (!atDate.value) initAtToNextHour();
    emit("confirm", { type: "at", remindAt: buildAtIso() });
    return;
  }
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
</script>

<template>
  <div class="reminder-popover">
    <div class="reminder-popover__list">
      <button
        v-for="(p, i) in REMIND_PRESETS"
        :key="i"
        type="button"
        class="reminder-popover__item"
        :class="{ 'reminder-popover__item--active': currentPresetIndex === i }"
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
      <!-- 指定时刻（绝对时间提醒，与上面的偏移互斥） -->
      <button
        type="button"
        class="reminder-popover__item"
        :class="{ 'reminder-popover__item--active': isAt }"
        @click="selectPreset(AT_INDEX)"
      >
        <icon-clock-circle :size="14" />
        <span>指定时刻…</span>
        <icon-check v-if="isAt" :size="12" class="reminder-popover__check" />
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

    <!-- 指定时刻选择器：日期 + 时分网格 -->
    <div v-if="isAt" class="reminder-popover__at">
      <div class="reminder-popover__at-date">
        <label>日期</label>
        <input
          v-model="atDate"
          type="date"
          class="reminder-popover__date-input"
        />
      </div>
      <div class="reminder-popover__time-cols">
        <div class="reminder-popover__time-col">
          <div class="reminder-popover__time-head">时</div>
          <div class="reminder-popover__time-grid reminder-popover__time-grid--hour">
            <button
              v-for="h in hourOptions"
              :key="h"
              type="button"
              class="reminder-popover__time-cell"
              :class="{ 'reminder-popover__time-cell--selected': h === atHour }"
              @click="setHour(h)"
            >
              {{ pad2(h) }}
            </button>
          </div>
        </div>
        <div class="reminder-popover__time-col">
          <div class="reminder-popover__time-head">分</div>
          <div class="reminder-popover__time-grid reminder-popover__time-grid--minute">
            <button
              v-for="m in minuteOptions"
              :key="m"
              type="button"
              class="reminder-popover__time-cell"
              :class="{ 'reminder-popover__time-cell--selected': m === atMinute }"
              @click="setMinute(m)"
            >
              {{ pad2(m) }}
            </button>
          </div>
        </div>
      </div>
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

/* 指定时刻选择器 */
.reminder-popover__at {
  padding: 8px 12px;
  margin-top: 4px;
  border-top: 1px solid var(--jt-border);
}

.reminder-popover__at-date {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin-bottom: 8px;
}

.reminder-popover__date-input {
  flex: 1;
  height: 28px;
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 0 8px;
  font-size: 12px;
  font-family: var(--font-body);
  background: var(--jt-surface);
  color: var(--jt-text-primary);
}

.reminder-popover__time-cols {
  display: flex;
  gap: 8px;
}

.reminder-popover__time-col {
  flex: 1;
  min-width: 0;
}

.reminder-popover__time-head {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-align: center;
  margin-bottom: 4px;
}

.reminder-popover__time-grid {
  display: grid;
  gap: 2px;
  max-height: 144px;
  overflow-y: auto;
}

.reminder-popover__time-grid--hour {
  grid-template-columns: repeat(4, 1fr);
}

.reminder-popover__time-grid--minute {
  grid-template-columns: repeat(4, 1fr);
}

.reminder-popover__time-cell {
  border: none;
  background: transparent;
  padding: 4px 0;
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--font-mono, var(--font-body));
  color: var(--jt-text-primary);
  cursor: pointer;
}

.reminder-popover__time-cell:hover {
  background: var(--jt-surface-sunken);
}

.reminder-popover__time-cell--selected {
  background: var(--jt-primary);
  color: #fff;
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
