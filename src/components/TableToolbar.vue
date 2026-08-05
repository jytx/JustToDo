<script setup lang="ts">
// 表格浮动工具条 —— 光标在表格内时，在表格上方浮现一排操作按钮。
//
// 操作：左/右加列、上/下加行、删当前列/行、合并/拆分单元格、切换表头行、删除表格。
// 定位：fixed，锚到表格 DOM 的顶部居中（editor.isActive('table') 时显示）。
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { Editor } from "@tiptap/vue-3";

/** 单个操作按钮定义 */
interface TableAction {
  key: string;
  title: string;
  /** 执行的 editor 命令链 */
  run: (editor: Editor) => void;
  /** 是否禁用（如合并单元格在单选区时禁用） */
  disabled?: (editor: Editor) => boolean;
}

const props = defineProps<{
  editor: Editor | undefined;
}>();

/** 工具条是否显示（光标在表格内） */
const visible = ref(false);
/** 工具条 fixed 定位 */
const pos = ref({ left: 0, top: 0 });

/** 操作列表 */
const actions = computed<TableAction[]>(() => [
  { key: "colBefore", title: "左侧插入列", run: (e) => e.chain().focus().addColumnBefore().run() },
  { key: "colAfter", title: "右侧插入列", run: (e) => e.chain().focus().addColumnAfter().run() },
  { key: "delCol", title: "删除列", run: (e) => e.chain().focus().deleteColumn().run() },
  { key: "rowBefore", title: "上方插入行", run: (e) => e.chain().focus().addRowBefore().run() },
  { key: "rowAfter", title: "下方插入行", run: (e) => e.chain().focus().addRowAfter().run() },
  { key: "delRow", title: "删除行", run: (e) => e.chain().focus().deleteRow().run() },
  {
    key: "merge",
    title: "合并单元格",
    run: (e) => e.chain().focus().mergeCells().run(),
    disabled: (e) => !e.can().mergeCells(),
  },
  {
    key: "split",
    title: "拆分单元格",
    run: (e) => e.chain().focus().splitCell().run(),
    disabled: (e) => !e.can().splitCell(),
  },
  { key: "header", title: "切换表头行", run: (e) => e.chain().focus().toggleHeaderRow().run() },
  { key: "delete", title: "删除表格", run: (e) => e.chain().focus().deleteTable().run() },
]);

/** 计算工具条位置（表格顶部居中） */
function updatePos(): void {
  const ed = props.editor;
  if (!ed) return;
  const sel = ed.state.selection;
  // 找光标所在 table 节点的位置
  let tblPos = -1;
  ed.state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
    if (node.type.name === "table") {
      tblPos = pos;
      return false;
    }
    return true;
  });
  if (tblPos < 0) {
    visible.value = false;
    return;
  }
  // 用 view.nodeDOM 把 pos 转成 DOM 元素
  const dom = ed.view.nodeDOM(tblPos);
  if (!(dom instanceof HTMLElement)) {
    visible.value = false;
    return;
  }
  const r = dom.getBoundingClientRect();
  pos.value = {
    left: r.left + r.width / 2,
    top: r.top - 4,
  };
  visible.value = true;
}

/** editor 选区变化时重算显示状态 + 位置 */
function onSelectionUpdate(): void {
  const ed = props.editor;
  if (!ed) {
    visible.value = false;
    return;
  }
  if (ed.isActive("table")) {
    updatePos();
  } else {
    visible.value = false;
  }
}

/** 滚动时跟随更新位置 */
function onScroll(): void {
  if (visible.value) updatePos();
}

let scrollEl: HTMLElement | null = null;
function findScrollParent(): void {
  const pm = document.querySelector(".ProseMirror");
  let el: HTMLElement | null = pm?.parentElement ?? null;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
      scrollEl = el;
      return;
    }
    el = el.parentElement;
  }
  scrollEl = null;
}

watch(
  () => props.editor,
  (ed) => {
    if (!ed) return;
    ed.on("selectionUpdate", onSelectionUpdate);
    ed.on("transaction", onSelectionUpdate);
    findScrollParent();
    scrollEl?.addEventListener("scroll", onScroll, { passive: true });
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener("scroll", onScroll, true);
});
onBeforeUnmount(() => {
  const ed = props.editor;
  ed?.off("selectionUpdate", onSelectionUpdate);
  ed?.off("transaction", onSelectionUpdate);
  scrollEl?.removeEventListener("scroll", onScroll);
  window.removeEventListener("scroll", onScroll, true);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible && editor" class="table-toolbar" :style="{ left: pos.left + 'px', top: pos.top + 'px' }">
      <button
        v-for="a in actions"
        :key="a.key"
        type="button"
        class="table-toolbar__btn"
        :class="{ 'table-toolbar__btn--danger': a.key === 'delete' }"
        :title="a.title"
        :disabled="a.disabled ? a.disabled(editor) : false"
        @click="a.run(editor)"
      >
        {{ a.title }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.table-toolbar {
  position: fixed;
  transform: translate(-50%, -100%);
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 4px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}
.table-toolbar__btn {
  box-sizing: border-box;
  border: none;
  background: transparent;
  color: var(--jt-text-secondary);
  font-size: 12px;
  font-family: var(--font-body);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.12s, color 0.12s;
}
.table-toolbar__btn:hover:not(:disabled) {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
.table-toolbar__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.table-toolbar__btn--danger {
  color: var(--jt-error);
}
.table-toolbar__btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--jt-error) 10%, transparent);
  color: var(--jt-error);
}
</style>
