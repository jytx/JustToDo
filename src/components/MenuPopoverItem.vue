<script setup lang="ts">
// 统一菜单项 —— 与 ReminderPopover / RecurrencePopover 同套视觉语言：
//   · 默认透明，hover 浅灰背景（--jt-surface-sunken）
//   · active 时主色软背景 + 主色文字，右侧出现 icon-check
//   · danger 时红字 + hover 淡错色背景
// 用作 <MenuPopover> 的子项，本质是个 <button>，天然可获焦 + Enter/Space 触发。
import { IconCheck } from "@arco-design/web-vue/es/icon";

defineProps<{
  /** 当前项是否处于"选中"状态（左侧 accent-soft 背景 + 右侧 icon-check） */
  active?: boolean;
  /** 危险项（删除类）：红字，hover 淡错色背景 */
  danger?: boolean;
  /** 禁用 */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  click: [];
}>();
</script>

<template>
  <button
    type="button"
    class="menu-popover-item"
    :class="{
      'menu-popover-item--active': active,
      'menu-popover-item--danger': danger,
    }"
    :disabled="disabled"
    @click="emit('click')"
  >
    <slot />
    <icon-check v-if="active" :size="12" class="menu-popover-item__check" />
  </button>
</template>

<style scoped>
.menu-popover-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  border: none;
  background: transparent;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s, color 0.12s;
}

/* 默认 hover：浅灰底 */
.menu-popover-item:hover:not(:disabled) {
  background-color: var(--jt-surface-sunken);
}

/* 选中态：主色淡背景 + 主色文字 */
.menu-popover-item--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}
.menu-popover-item--active:hover:not(:disabled) {
  background-color: var(--jt-accent-soft);
}

/* 危险态：错误红文字 */
.menu-popover-item--danger {
  color: var(--jt-error);
}
.menu-popover-item--danger:hover:not(:disabled) {
  /* 项目内已有的"淡错色背景"惯例：error 10% + transparent */
  background-color: color-mix(in srgb, var(--jt-error) 10%, transparent);
}

/* 禁用 */
.menu-popover-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 右侧自动填充的 ✓ 标记 */
.menu-popover-item__check {
  margin-left: auto;
  flex-shrink: 0;
}

/* keyboard focus-visible：细节但有用 */
.menu-popover-item:focus-visible {
  outline: 2px solid var(--jt-primary);
  outline-offset: -2px;
}
</style>
