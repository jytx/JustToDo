<script setup lang="ts">
// 提醒弹层 —— 简化版：列表 + 自定义分钟数
import { ref, computed, watch } from "vue";
import { REMIND_PRESETS, matchRemindPreset } from "@/types";
// 注：复用 src/types 的 REMIND_PRESETS

const props = defineProps<{
  /** 当前提醒偏移（分钟），null = 不提醒 */
  value: number | null;
}>();

const emit = defineEmits<{
  confirm: [value: number | null];
  clear: [];
}>();

const currentPresetIndex = ref(0);
const customMinutes = ref(0);

watch(
  () => props.value,
  (v) => {
    const idx = matchRemindPreset(v);
    currentPresetIndex.value = idx;
    if (idx === REMIND_PRESETS.length - 1) {
      // 自定义
      customMinutes.value = typeof v === "number" ? v : 0;
    }
  },
  { immediate: true },
);

const isCustom = computed(() => REMIND_PRESETS[currentPresetIndex.value]?.preset === false);

function selectPreset(i: number) {
  currentPresetIndex.value = i;
}

function onConfirm() {
  const p = REMIND_PRESETS[currentPresetIndex.value];
  if (!p) return;
  if (p.value === null) {
    emit("confirm", null);
  } else if (p.preset) {
    emit("confirm", p.value);
  } else {
    emit("confirm", customMinutes.value);
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
        <icon-check v-if="currentPresetIndex === i" :size="12" class="reminder-popover__check" />
      </button>
    </div>

    <!-- 自定义分钟数 -->
    <div v-if="isCustom" class="reminder-popover__custom">
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
  width: 240px;
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
