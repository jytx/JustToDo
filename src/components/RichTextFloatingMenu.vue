<script setup lang="ts">
// RichTextFloatingMenu —— 空段落浮 + 按钮（Notion-like 体验）
//
// 监听 editor 的 selectionUpdate：判断光标是否在一个**完全空**的 paragraph
// 上、是则在该 paragraph 左侧垂直居中位置浮一个"+ "按钮。点击按钮
// → 在光标位置 insertContent('/')，让 Tiptap suggestion 自动触发 slash menu。
//
// 位置取自 editor.view.coordsAtPos(pos)；按钮 absolute 定位到 body。
import { ref, onBeforeUnmount, watch, computed } from "vue";
import type { Editor } from "@tiptap/vue-3";

const props = defineProps<{
  editor: Editor | null;
}>();

/** 按钮位置（基于视口） */
const pos = ref<{ left: number; top: number } | null>(null);

/** 当前光标所在段落是否为空文本且不在 list/code 内 */
const isEmpty = ref(false);

function recompute() {
  const e = props.editor;
  if (!e) {
    isEmpty.value = false;
    pos.value = null;
    return;
  }
  const { $from } = e.state.selection;
  // 当前段落父级：parent 的第一个祖先若是 paragraph 节点
  const parent = $from.parent;
  // 父段若是 paragraph，且文本为空（不含 placeholder 字符），且前面没内容（行首）
  if (parent.type.name === "paragraph" && parent.textContent === "" && $from.parentOffset === 0) {
    isEmpty.value = true;
    const coords = e.view.coordsAtPos($from.pos);
    pos.value = {
      left: coords.left - 28, // 按钮位于段落左外
      top: coords.top + (coords.bottom - coords.top) / 2 - 14,
    };
  } else {
    isEmpty.value = false;
    pos.value = null;
  }
}

watch(
  () => props.editor,
  (e) => {
    if (!e) return;
    e.on("selectionUpdate", recompute);
    e.on("update", recompute);
    recompute();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  const e = props.editor;
  if (!e) return;
  e.off("selectionUpdate", recompute);
  e.off("update", recompute);
});

function onAddClick() {
  const e = props.editor;
  if (!e) return;
  // 插入 / 让 suggestion 自动接管
  e.chain().focus().insertContent("/").run();
}

const visible = computed(() => isEmpty.value && pos.value !== null);
const style = computed(() => {
  if (!pos.value) return {};
  return {
    position: "fixed" as const,
    left: pos.value.left + "px",
    top: pos.value.top + "px",
    zIndex: 100,
  };
});
</script>

<template>
  <Teleport to="body">
    <button
      v-if="visible"
      class="floating-add-btn"
      :style="style"
      type="button"
      aria-label="插入 block"
      @mousedown.prevent
      @click="onAddClick"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M13 5C13 4.44772 12.5523 4 12 4C11.4477 4 11 4.44772 11 5V11H5C4.44772 11 4 11.4477 4 12C4 12.5523 4.44772 13 5 13H11V19C11 19.5523 11.4477 20 12 20C12.5523 20 13 19.5523 13 19V13H19C19.5523 13 20 12.5523 20 12C20 11.4477 19.5523 11 19 11H13V5Z" />
      </svg>
    </button>
  </Teleport>
</template>

<style scoped>
.floating-add-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background-color: transparent;
  color: var(--jt-text-tertiary);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}

.floating-add-btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
</style>
