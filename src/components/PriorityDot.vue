<script setup lang="ts">
// 优先级色点 —— 任务卡片右侧的优先级视觉标识
// 高=红 中=橙 低=蓝 无=空心灰圈
import { computed } from "vue";
import { PRIORITY_COLORS, type Priority } from "@/types";

const props = defineProps<{
  priority: Priority;
  size?: number;
}>();

const colorValue = computed(() => {
  const c = PRIORITY_COLORS[props.priority];
  if (c === "error") return "var(--jt-error)";
  if (c === "warning") return "var(--jt-warning)";
  if (c === "info") return "#3B82F6";
  return "var(--jt-text-tertiary)";
});

const dotSize = computed(() => `${props.size ?? 8}px`);
const isNone = computed(() => props.priority === 0);
</script>

<template>
  <span
    class="priority-dot"
    :class="{ 'priority-dot--none': isNone }"
    :style="{
      width: dotSize,
      height: dotSize,
      backgroundColor: isNone ? 'transparent' : colorValue,
      borderColor: colorValue,
    }"
    :title="`优先级 ${props.priority}`"
  />
</template>

<style scoped>
.priority-dot {
  display: inline-block;
  border-radius: 50%;
  flex-shrink: 0;
  border: 1.5px solid transparent;
  box-sizing: border-box;
}

.priority-dot--none {
  border-style: solid;
}
</style>
