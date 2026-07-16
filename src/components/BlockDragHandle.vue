<script setup lang="ts">
// 块拖拽手柄 + 落点横线（自定义鼠标事件实现，非 HTML5 drag）
// 通过 useBlockDrag 状态机驱动；本组件只负责渲染 + 绑定 mousedown。
//
// 两个元素都 Teleport 到 body + position:fixed，避免祖先 overflow/transform 干扰。
import { computed, toRef } from "vue";
import type { Editor } from "@tiptap/vue-3";
import { useBlockDrag } from "@/composables/useBlockDrag";

const props = defineProps<{
  /** Tiptap editor 实例（来自 useEditor 的 ref 解包值） */
  editor: Editor | undefined;
}>();

// editor 是 prop（非 ref），useBlockDrag 需要 Ref，用 toRef 转为响应式 ref
const editorRef = toRef(props, "editor");

const { handlePos, indicatorPos, isDragging, onHandleMouseDown, onHandleMouseEnter, onHandleMouseLeave } =
  useBlockDrag(editorRef);

/** 手柄样式（fixed 定位 + 显隐） */
const handleStyle = computed(() => ({
  left: `${handlePos.value.left}px`,
  top: `${handlePos.value.top}px`,
  opacity: handlePos.value.visible ? 1 : 0,
  pointerEvents: handlePos.value.visible ? ("auto" as const) : ("none" as const),
  cursor: isDragging.value ? "grabbing" : "grab",
}));

/** 横线样式（fixed 定位 + 显隐） */
const indicatorStyle = computed(() => ({
  left: `${indicatorPos.value.left}px`,
  top: `${indicatorPos.value.top}px`,
  width: `${indicatorPos.value.width}px`,
  opacity: indicatorPos.value.visible ? 1 : 0,
}));
</script>

<template>
  <teleport to="body">
    <!-- 拖拽手柄：⋮⋮ 六点图标 -->
    <div
      class="block-drag-handle"
      :class="{ 'block-drag-handle--dragging': isDragging }"
      :style="handleStyle"
      @mousedown="onHandleMouseDown"
      @mouseenter="onHandleMouseEnter"
      @mouseleave="onHandleMouseLeave"
    ></div>

    <!-- 落点横线：拖拽时显示在哪两个块之间 -->
    <div class="block-drag-indicator" :style="indicatorStyle"></div>
  </teleport>
</template>

<style scoped>
/* 拖拽手柄 —— 18×22 的可点击区，⋮⋮ 六点用 ::before/::after 画 */
.block-drag-handle {
  position: fixed;
  /* z-index 必须 > 详情面板（.detail-panel 是 fixed z-index:1000），
     否则手柄被面板完全遮盖、永远看不见。2001 留出余量。 */
  z-index: 2001;
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

/* 两列圆点（每列 3 个，用 box-shadow 堆叠出另外两个） */
.block-drag-handle::before,
.block-drag-handle::after {
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
.block-drag-handle::before {
  left: 5px;
}
.block-drag-handle::after {
  left: 10px;
}

.block-drag-handle:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.block-drag-handle--dragging {
  cursor: grabbing;
  color: var(--jt-primary);
}

/* 落点横线 —— 2px 主题色横线，对齐编辑器内容宽度。
   z-index 略低于手柄（2000 < 2001），且同样 > 详情面板的 1000。 */
.block-drag-indicator {
  position: fixed;
  z-index: 2000;
  height: 2px;
  background-color: var(--jt-primary);
  border-radius: 1px;
  pointer-events: none;
  transition: opacity 0.1s;
}

.block-drag-indicator::before {
  /* 横线两端的圆点，强调落点位置 */
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
