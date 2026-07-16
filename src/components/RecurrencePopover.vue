<script setup lang="ts">
// 重复弹层 —— 选择频率 + 间隔
import { ref, computed, watch } from "vue";
import { RECURRENCE_FREQS, formatRecurrence, type RecurrenceFreq } from "@/types";

const props = defineProps<{
  freq: RecurrenceFreq | null;
  interval: number;
}>();

const emit = defineEmits<{
  confirm: [freq: RecurrenceFreq | null, interval: number];
  clear: [];
}>();

const localFreq = ref<RecurrenceFreq | null>(null);
const localInterval = ref(1);

watch(
  () => [props.freq, props.interval],
  ([f, i]) => {
    localFreq.value = f as RecurrenceFreq | null;
    localInterval.value = (i as number) || 1;
  },
  { immediate: true },
);

const summary = computed(() =>
  formatRecurrence(localFreq.value, localInterval.value),
);

function onConfirm() {
  if (!localFreq.value) {
    emit("confirm", null, 1);
  } else {
    emit("confirm", localFreq.value, localInterval.value);
  }
}
</script>

<template>
  <div class="recurrence-popover">
    <div class="recurrence-popover__list">
      <button
        type="button"
        class="recurrence-popover__item"
        :class="{ 'recurrence-popover__item--active': localFreq === null }"
        @click="localFreq = null"
      >
        <icon-close :size="14" />
        <span>不重复</span>
        <icon-check v-if="localFreq === null" :size="12" class="recurrence-popover__check" />
      </button>
      <button
        v-for="f in RECURRENCE_FREQS"
        :key="f.value"
        type="button"
        class="recurrence-popover__item"
        :class="{ 'recurrence-popover__item--active': localFreq === f.value }"
        @click="localFreq = f.value as RecurrenceFreq"
      >
        <icon-refresh :size="14" />
        <span>{{ f.label }}</span>
        <icon-check v-if="localFreq === f.value" :size="12" class="recurrence-popover__check" />
      </button>
    </div>

    <!-- 间隔输入（仅设置频率时显示） -->
    <div v-if="localFreq" class="recurrence-popover__interval">
      <label>间隔</label>
      <a-input-number
        v-model="localInterval"
        :min="1"
        :max="365"
        :step="1"
        size="mini"
        style="width: 90px"
      />
      <span class="recurrence-popover__summary">{{ summary }}</span>
    </div>

    <div class="recurrence-popover__footer">
      <button
        type="button"
        class="recurrence-popover__btn recurrence-popover__btn--primary"
        @click="onConfirm"
      >
        确定
      </button>
    </div>
  </div>
</template>

<style scoped>
.recurrence-popover {
  width: 240px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 8px;
}

.recurrence-popover__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recurrence-popover__item {
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

.recurrence-popover__item:hover {
  background: var(--jt-surface-sunken);
}

.recurrence-popover__item--active {
  background: var(--jt-accent-soft);
  color: var(--jt-primary);
}

.recurrence-popover__check {
  margin-left: auto;
}

.recurrence-popover__interval {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-top: 4px;
  border-top: 1px solid var(--jt-border);
  font-size: 12px;
  color: var(--jt-text-secondary);
}

.recurrence-popover__summary {
  margin-left: auto;
  color: var(--jt-text-tertiary);
  font-family: var(--font-mono);
}

.recurrence-popover__footer {
  padding: 8px 4px 4px;
  margin-top: 4px;
  border-top: 1px solid var(--jt-border);
}

.recurrence-popover__btn {
  width: 100%;
  height: 28px;
  border-radius: 6px;
  border: none;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-body);
}

.recurrence-popover__btn--primary {
  background: var(--jt-primary);
  color: #fff;
}
</style>
