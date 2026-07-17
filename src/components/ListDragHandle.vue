<script setup lang="ts">
// 通用列表拖拽手柄：渲染 ⋮⋮ + 落点横线，与 useListDrag 状态机配套。
// 与 BlockDragHandle 共用视觉（六点 + 蓝色横线），但没 tiptap 依赖。
//
// 位置：手柄和横线都 absolute 定位在父级容器内（不 teleport 到 body），
// 这样手柄就在列表 DOM 中，鼠标从列表项移到手柄不会触发 mouseleave。

import { computed, type Ref } from "vue";
import { useListDrag, type HandlePosition, type IndicatorPosition } from "@/composables/useListDrag";

const props = defineProps<{
  /** 列表容器 ref（容器内子元素由 itemSelector 匹配） */
  containerRef: Ref<HTMLElement | null>;
  /** 可拖项 CSS 选择器 */
  itemSelector: string;
  /** 拖动结束回调 */
  onMove: (fromIndex: number, toIndex: number) => void | Promise<void>;
}>();

const { handlePos, indicatorPos, isDragging, onHandleMouseDown, onHandleMouseEnter, onHandleMouseLeave } =
  useListDrag({
    containerRef: props.containerRef,
    itemSelector: props.itemSelector,
    onMove: props.onMove,
  });

const handleStyle = computed(() => ({
  left: `${handlePos.value.left}px`,
  top: `${handlePos.value.top}px`,
  opacity: handlePos.value.visible ? 1 : 0,
  pointerEvents: handlePos.value.visible ? ("auto" as const) : ("none" as const),
  cursor: isDragging.value ? "grabbing" : "grab",
}));

const indicatorStyle = computed(() => ({
  left: `${indicatorPos.value.left}px`,
  top: `${indicatorPos.value.top}px`,
  width: `${indicatorPos.value.width}px`,
  opacity: indicatorPos.value.visible ? 1 : 0,
}));
</script>

<template>
  <div
    class="list-drag-handle"
    :class="{ 'list-drag-handle--dragging': isDragging }"
    :style="handleStyle"
    @mousedown="onHandleMouseDown"
    @mouseenter="onHandleMouseEnter"
    @mouseleave="onHandleMouseLeave"
  ></div>
  <div class="list-drag-indicator" :style="indicatorStyle"></div>
</template>

<style scoped>
.list-drag-handle {
  position: absolute;
  z-index: 5;
  width: 18px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--jt-text-tertiary);
  cursor: grab;
  border-radius: 4px;
  transition: background-color 0.12s, color 0.12s, opacity 0.12s;
  user-select: none;
}

/* 六点 ⋮⋮（每列 3 个） */
.list-drag-handle::before,
.list-drag-handle::after {
  content: "";
  position: absolute;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background-color: currentColor;
  box-shadow:
    0 -5px 0 0 currentColor,
    0 5px 0 0 currentColor;
}
.list-drag-handle::before {
  left: 5px;
}
.list-drag-handle::after {
  left: 10px;
}

.list-drag-handle:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.list-drag-handle--dragging {
  cursor: grabbing;
  color: var(--jt-primary);
}

/* 落点横线 */
.list-drag-indicator {
  position: absolute;
  z-index: 5;
  height: 2px;
  background-color: var(--jt-primary);
  border-radius: 1px;
  pointer-events: none;
  transition: opacity 0.1s;
}

/* 横线两端的圆点强调落点位置 */
.list-drag-indicator::before {
  content: "";
  position: absolute;
  left: -4px;
  top: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--jt-primary);
}
</style>
