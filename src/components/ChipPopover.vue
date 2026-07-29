<script setup lang="ts">
// 通用 chip 下拉浮窗 —— 仅作为容器占位
//
// 用途：chips 行 (提醒/重复/优先级/标签) 与附件 AttachmentPopover 完全同款
//   - 内部用 Arco 原生 <a-popover> 实现，让外层 <a-tooltip> 能正常 hover 显示
//   - trigger 是默认 slot (PropertyChip 由调用方传入)
//   - 下拉内容通过 #content 命名 slot 传入 (ReminderPopover / RecurrencePopover 等)
//
// 与项目内 <Popover> 的区别：项目内 Popover 不暴露 trigger 协议给 Arco a-tooltip，
//   a-tooltip 在嵌套项目内 Popover 时 hover 检测失败。采用 Arco a-popover 后，
//   a-tooltip 与 a-popover 之间 trigger 互通，hover 黑色气泡正常工作。
//
// 用法：
//   <a-tooltip :content="...">
//     <ChipPopover v-model:visible="reminderVisible">
//       <PropertyChip @click="reminderVisible = !reminderVisible">...</PropertyChip>
//       <template #content>
//         <ReminderPopover ... />
//       </template>
//     </ChipPopover>
//   </a-tooltip>

import { computed, onMounted, onBeforeUnmount } from "vue";

const props = defineProps<{
  /** v-model:visible */
  visible: boolean;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

/** 显隐双向同步（computed getter/setter 替代 v-model 链式） */
const popoverVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

/** ESC 关闭浮窗。
 *  Arco a-popover 原生不响应 ESC，这里补一个监听。
 *  不做 stopPropagation：AppLayout 的 ESC 守卫会通过 .arco-popover-popup 检测到
 *  本浮窗仍在 DOM 中而 return（不关详情面板），实现「逐层关闭」。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.visible) {
    emit("update:visible", false);
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <a-popover
    v-model:popup-visible="popoverVisible"
    :show-arrow="true"
    :arrow-style="{ backgroundColor: 'transparent' }"
    :content-style="{ padding: 0, border: 'none', background: 'transparent', boxShadow: 'none' }"
    :popup-style="{ padding: 0 }"
    position="bottom"
    trigger="click"
  >
    <!-- a-popover 的 trigger 是默认 slot -->
    <slot />
    <template #content>
      <slot name="content" />
    </template>
  </a-popover>
</template>
