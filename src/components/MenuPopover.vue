<script setup lang="ts">
// 统一菜单容器 —— 封装 <Popover> + 容器外观（与 ReminderPopover / RecurrencePopover 完全一致）：
//   · 240px 宽 · 12px 圆角 · 浅阴影 · surface 背景 · 8px padding
// 用法：
//   <MenuPopover v-model:visible="open">
//     <template #trigger><button @click="open = !open">⋯</button></template>
//     <MenuPopoverItem @click="onDelete">删除</MenuPopoverItem>
//     <MenuPopoverItem danger @click="onRemove">移除</MenuPopoverItem>
//   </MenuPopover>
import Popover from "./Popover.vue";

defineProps<{
  visible: boolean;
  /** 默认 bottom-right（与原 Arco position="br" 等价） */
  placement?:
    | "bottom-left"
    | "bottom-right"
    | "bottom-center"
    | "top-left"
    | "top-right"
    | "top-center";
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();
</script>

<template>
  <Popover
    :visible="visible"
    :placement="placement ?? 'bottom-right'"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <template #trigger>
      <slot name="trigger" />
    </template>
    <div class="menu-popover">
      <slot />
    </div>
  </Popover>
</template>

<style scoped>
.menu-popover {
  /* 自适应宽度：内容驱动 + 上下限，避免 240px 在 "H3 标题" 等短文本下空荡荡 */
  width: max-content;
  min-width: 120px;
  max-width: 220px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
