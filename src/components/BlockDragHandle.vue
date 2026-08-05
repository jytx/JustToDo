<script setup lang="ts">
// 块拖拽手柄 + 落点横线（自定义鼠标事件实现，非 HTML5 drag）
// 通过 useBlockDrag 状态机驱动；本组件只负责渲染 + 绑定 mousedown。
//
// 位置：手柄和横线都 absolute 定位，渲染在父级 editor wrapper 内
// （不 teleport 到 body），坐标相对 wrapper 左/上边缘计算。
// 这样鼠标从 editor 内容区移到手柄不会触发 editor 的 mouseleave，
// 避免手柄一碰就消失、必须来回挪动才能按下的体验问题。
//
// 手柄「纯点击」（按下未移动）唤起 BlockHandleMenu 块操作菜单
// （转换当前块 / 在上方添加 / 在下方添加）。
import { computed, ref, toRef } from "vue";
import type { Editor } from "@tiptap/vue-3";
import { useBlockDrag } from "@/composables/useBlockDrag";
import BlockHandleMenu from "./BlockHandleMenu.vue";

/** 顶层块节点信息（传给 BlockHandleMenu） */
interface BlockInfo {
  blockPos: number;
  blockSize: number;
  /** 菜单定位锚点（手柄视口坐标） */
  anchorRect: { left: number; top: number; bottom: number };
}

const props = defineProps<{
  /** Tiptap editor 实例（来自 useEditor 的 ref 解包值） */
  editor: Editor | undefined;
}>();

/** 当前打开的块菜单信息（null = 关闭） */
const blockMenu = ref<BlockInfo | null>(null);

/** 由 useBlockDrag 触发的「手柄纯点击」回调：算出当前块信息并唤起菜单 */
function openBlockMenu(blockIndex: number): void {
  const ed = props.editor;
  if (!ed) return;
  const doc = ed.state.doc;
  if (blockIndex < 0 || blockIndex >= doc.childCount) return;

  // 累加前序块 nodeSize 得到当前块的起始 pos
  let blockPos = 0;
  for (let i = 0; i < blockIndex; i++) {
    blockPos += doc.child(i).nodeSize;
  }
  const blockSize = doc.child(blockIndex).nodeSize;

  // 手柄视口坐标（用于菜单 fixed 定位）：从 handlePos（相对 wrapper）换算
  const wrapperRect = ed.view.dom.getBoundingClientRect();
  // handlePos 在 onHandleMouseDown 重置后是 hover 块的居中位置，
  // 这里重新基于当前手柄位置算 anchor（手柄在 wrapper 左侧）
  const handleEl = document.querySelector(".block-drag-handle") as HTMLElement | null;
  const left = handleEl
    ? handleEl.getBoundingClientRect().left
    : wrapperRect.left;
  const top = handleEl ? handleEl.getBoundingClientRect().top : wrapperRect.top;

  blockMenu.value = {
    blockPos,
    blockSize,
    anchorRect: { left, top, bottom: top + 22 },
  };
}

// editor 是 prop（非 ref），useBlockDrag 需要 Ref，用 toRef 转为响应式 ref
const editorRef = toRef(props, "editor");

const { handlePos, indicatorPos, isDragging, onHandleMouseDown, onHandleMouseEnter, onHandleMouseLeave } =
  useBlockDrag(editorRef, openBlockMenu);

/** 手柄样式（absolute 定位，坐标相对父级 editor wrapper） */
const handleStyle = computed(() => ({
  left: `${handlePos.value.left}px`,
  top: `${handlePos.value.top}px`,
  opacity: handlePos.value.visible ? 1 : 0,
  pointerEvents: handlePos.value.visible ? ("auto" as const) : ("none" as const),
  cursor: isDragging.value ? "grabbing" : "grab",
}));

/** 横线样式（absolute 定位，坐标相对父级 editor wrapper） */
const indicatorStyle = computed(() => ({
  left: `${indicatorPos.value.left}px`,
  top: `${indicatorPos.value.top}px`,
  width: `${indicatorPos.value.width}px`,
  opacity: indicatorPos.value.visible ? 1 : 0,
}));
</script>

<template>
  <!-- 不 teleport：手柄和横线渲染在父级 editor wrapper 内，
       absolute 定位，hover 链不断。 -->
  <div class="block-drag-handle" :class="{ 'block-drag-handle--dragging': isDragging }" :style="handleStyle" @mousedown="onHandleMouseDown" @mouseenter="onHandleMouseEnter" @mouseleave="onHandleMouseLeave"></div>
  <div class="block-drag-indicator" :style="indicatorStyle"></div>
  <!-- 手柄纯点击唤起的块操作菜单 -->
  <BlockHandleMenu
    v-if="blockMenu && editor"
    :editor="editor"
    :block-pos="blockMenu.blockPos"
    :block-size="blockMenu.blockSize"
    :anchor-rect="blockMenu.anchorRect"
    @close="blockMenu = null"
  />
</template>

<style scoped>
/* 拖拽手柄 —— 18×22 的可点击区，⋮⋮ 六点用 ::before/::after 画 */
.block-drag-handle {
  position: absolute;
  /* z-index 仅需 > editor 内容（默认 auto=0）即可；不需抗详情面板遮盖（手柄在面板 DOM 内） */
  z-index: 1;
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

/* 落点横线 —— 2px 主题色横线，对齐 editor 内容区宽度 */
.block-drag-indicator {
  position: absolute;
  z-index: 1;
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
