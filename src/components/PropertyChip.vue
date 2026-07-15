<script setup lang="ts">
// 通用 chip 组件 —— 详情面板属性行的统一外观
// 滴答清单风格：圆角胶囊，icon + 文字，hover 浅色背景，active 强调
import { useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  /** 是否已设置值（影响颜色/背景） */
  active?: boolean;
  /** 整体禁用 */
  disabled?: boolean;
  /** 紧凑变体（用在小 footer） */
  compact?: boolean;
  /** 只显示图标（窄屏塌缩用），由父级通过 a-tooltip 提供文字提示 */
  iconOnly?: boolean;
}>();

// emit click 事件，让父级 a-trigger / a-button 等组件能正常 attach onClick
const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

const attrs = useAttrs();

function onClick(e: MouseEvent) {
  if (props.disabled) return;
  emit("click", e);
}
</script>

<template>
  <button
    type="button"
    class="property-chip"
    :class="{
      'property-chip--active': active,
      'property-chip--compact': compact,
      'property-chip--icon-only': iconOnly,
    }"
    :disabled="disabled"
    v-bind="attrs"
    @click="onClick"
  >
    <slot name="icon">
      <span v-if="false" class="property-chip__icon" />
    </slot>
    <span v-if="!iconOnly" class="property-chip__content">
      <slot />
    </span>
    <slot name="suffix" />
  </button>
</template>

<style scoped>
.property-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--jt-text-tertiary);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
  white-space: nowrap;
  user-select: none;
  flex-shrink: 0;
}

.property-chip:hover:not(:disabled) {
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-secondary);
}

.property-chip:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.property-chip--active {
  color: var(--jt-text-primary);
  background-color: transparent;
}

.property-chip--active:hover {
  background-color: var(--jt-surface-sunken);
}

/* 紧凑变体（footer 用） */
.property-chip--compact {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: 5px;
}

/* 只显示图标（窄屏塌缩用） */
.property-chip--icon-only {
  width: 28px;
  padding: 0;
  justify-content: center;
}

.property-chip--icon-only.property-chip--compact {
  width: 24px;
}

.property-chip__content {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
</style>
