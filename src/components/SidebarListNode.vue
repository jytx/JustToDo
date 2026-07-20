<script setup lang="ts">
// 侧边栏清单树形节点 —— 递归渲染目录和清单
// 支持拖拽排序和拖拽到其他目录
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ListTreeNode } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { useQuickAdd } from "@/composables/useQuickAdd";
import {
  IconFolder,
  IconMore,
  IconEdit,
  IconDelete,
  IconPlus,
  IconRight,
  IconDown,
} from "@arco-design/web-vue/es/icon";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = defineProps<{
  node: ListTreeNode;
  depth: number;
}>();

const taskStore = useTaskStore();
const router = useRouter();
const route = useRoute();
const quickAdd = useQuickAdd();

/**
 * 计算树节点左侧缩进。
 * 顶层节点也需要位于“清单”分组标题的右侧，每深入一级再增加 16px。
 */
function getNodePaddingLeft(depth: number): string {
  const baseIndent: number = 16;
  const levelIndent: number = 16;
  return `${baseIndent + depth * levelIndent}px`;
}

/** 当前清单项是否处于路由激活态（仅清单，非目录） */
const isActive = computed(
  () => !props.node.isFolder && route.name === "list" && route.params.id === props.node.id,
);

const expanded = ref(true);

const emit = defineEmits<{
  edit: [node: ListTreeNode];
  delete: [node: ListTreeNode];
  /** 拖拽放置：被拖拽的节点 ID，目标父级 ID，目标位置（before/after/inside） */
  move: [draggedId: string, targetNode: ListTreeNode, position: "before" | "after" | "inside"];
}>();

function onMenuClick(key: "edit" | "delete") {
  folderMenuOpen.value = false;
  listMenuOpen.value = false;
  if (key === "edit") emit("edit", props.node);
  else if (key === "delete") emit("delete", props.node);
}

/** 目录行更多菜单（独立 ref） */
const folderMenuOpen = ref(false);
/** 清单行更多菜单（独立 ref） */
const listMenuOpen = ref(false);

/** 点击清单行 → 路由跳转 */
function goToList() {
  if (!props.node.isFolder) {
    router.push(`/list/${props.node.id}`);
  }
}

// ─── 拖拽逻辑 ──────────────────────────────────────────

/** 当前 drag-over 状态：null / 'before' / 'after' / 'inside' */
const dragOver = ref<"before" | "after" | "inside" | null>(null);
const isDragging = ref(false);

/** 是否可拖动（inbox 不可拖） */
const canDrag = computed(() => props.node.id !== "inbox");

function onDragStart(e: DragEvent) {
  if (!canDrag.value) {
    e.preventDefault();
    return;
  }
  e.dataTransfer!.setData("text/plain", props.node.id);
  e.dataTransfer!.effectAllowed = "move";

  // 自定义拖拽幽灵图：创建一个简洁的小卡片
  const ghost = document.createElement("div");
  ghost.textContent = props.node.name;
  ghost.style.cssText = `
    position: absolute;
    top: -1000px;
    left: -1000px;
    padding: 4px 12px;
    background: var(--jt-primary);
    color: #fff;
    font-size: 13px;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `;
  document.body.appendChild(ghost);
  e.dataTransfer!.setDragImage(ghost, 10, 10);

  // 拖拽结束后移除幽灵元素
  setTimeout(() => document.body.removeChild(ghost), 0);

  isDragging.value = true;
}

function onDragEnd() {
  isDragging.value = false;
  dragOver.value = null;
}

function onDragOver(e: DragEvent) {
  // 收件箱位置固定，不接受其他清单的 before/after drop
  if (props.node.id === "inbox") return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;

  if (props.node.isFolder) {
    // 目录：上 1/3 = before，中间 1/3 = inside，下 1/3 = after
    if (y < h * 0.33) dragOver.value = "before";
    else if (y > h * 0.66) dragOver.value = "after";
    else dragOver.value = "inside";
  } else {
    // 清单：上半 = before，下半 = after
    if (y < h * 0.5) dragOver.value = "before";
    else dragOver.value = "after";
  }
}

function onDragLeave(e: DragEvent) {
  // 只有真正离开这个元素（不是进入子元素）才清除
  const related = e.relatedTarget as HTMLElement | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  dragOver.value = null;
}

function onDrop(e: DragEvent) {
  // 收件箱位置固定，不接受其他清单的 drop
  if (props.node.id === "inbox") {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  const draggedId = e.dataTransfer!.getData("text/plain");
  if (!draggedId || draggedId === props.node.id) {
    dragOver.value = null;
    return;
  }

  // 重新计算放置位置（不依赖 dragOver，因为它可能已被 dragLeave 清除）
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;

  let position: "before" | "after" | "inside";
  if (props.node.isFolder) {
    if (y < h * 0.33) position = "before";
    else if (y > h * 0.66) position = "after";
    else position = "inside";
  } else {
    position = y < h * 0.5 ? "before" : "after";
  }

  emit("move", draggedId, props.node, position);

  // 如果是放入目录且目录收起，展开它
  if (position === "inside" && props.node.isFolder) {
    expanded.value = true;
  }

  dragOver.value = null;
}
</script>

<template>
  <div class="list-node" :class="{ 'list-node--dragging': isDragging }">
    <!-- 目录 -->
    <div
      v-if="node.isFolder"
      class="list-node__row list-node__folder"
      :class="{
        'list-node--drag-over': dragOver === 'before' || dragOver === 'after',
        'list-node--drag-inside': dragOver === 'inside',
      }"
      :style="{ paddingLeft: getNodePaddingLeft(depth) }"
      :draggable="canDrag ? 'true' : 'false'"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <span class="list-node__expand" @click="expanded = !expanded">
        <icon-down v-if="expanded" :size="12" />
        <icon-right v-else :size="12" />
      </span>
      <icon-folder
        :size="16"
        class="list-node__folder-icon"
        :style="{ color: node.color }"
      />
      <span class="list-node__name">{{ node.name }}</span>
      <!-- 在目录下新建任务（hover 才显示） -->
      <button
        class="list-node__add-btn"
        title="在此目录下新建任务"
        @click.stop="quickAdd.open(node.id)"
      >
        <icon-plus :size="14" />
      </button>
      <MenuPopover v-model:visible="folderMenuOpen">
        <template #trigger>
          <button class="list-node__menu-btn" @click.stop="folderMenuOpen = !folderMenuOpen">
            <icon-more :size="16" />
          </button>
        </template>
        <MenuPopoverItem @click="onMenuClick('edit')">
          <icon-edit :size="15" />
          <span>编辑目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onMenuClick('delete')">
          <icon-delete :size="15" />
          <span>删除目录</span>
        </MenuPopoverItem>
      </MenuPopover>
    </div>

    <!-- 清单（非目录）—— 用 div 包裹以支持 draggable -->
    <div
      v-else
      class="list-node__row list-node__list-item"
      :class="{
        'list-node--active': isActive,
        'list-node--drag-over': dragOver === 'before' || dragOver === 'after',
      }"
      :style="{ paddingLeft: getNodePaddingLeft(depth) }"
      :draggable="canDrag ? 'true' : 'false'"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="goToList"
    >
      <span class="list-node__dot-placeholder" />
      <span
        class="list-node__dot"
        :style="{ backgroundColor: node.color }"
      />
      <span class="list-node__title">{{ node.name }}</span>
      <span v-if="taskStore.listCounts[node.id]" class="list-node__count">{{ taskStore.listCounts[node.id] }}</span>
      <MenuPopover v-if="node.id !== 'inbox'" v-model:visible="listMenuOpen">
        <template #trigger>
          <button class="list-node__menu-btn" @click.stop.prevent="listMenuOpen = !listMenuOpen">
            <icon-more :size="16" />
          </button>
        </template>
        <MenuPopoverItem @click="onMenuClick('edit')">
          <icon-edit :size="15" />
          <span>编辑清单</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onMenuClick('delete')">
          <icon-delete :size="15" />
          <span>删除清单</span>
        </MenuPopoverItem>
      </MenuPopover>
    </div>

    <!-- 递归渲染子节点 -->
    <div v-if="node.isFolder && expanded && node.children.length" class="list-node__children">
      <SidebarListNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        @edit="(n: ListTreeNode) => $emit('edit', n)"
        @delete="(n: ListTreeNode) => $emit('delete', n)"
        @move="(id: string, target: ListTreeNode, pos: 'before' | 'after' | 'inside') => $emit('move', id, target, pos)"
      />
    </div>
  </div>
</template>

<style scoped>
/* 通用行样式 */
.list-node__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  position: relative;
}

/* 清单行（router-link）去掉下划线 */
.list-node__list-item {
  text-decoration: none;
}

.list-node__list-item:hover {
  background-color: var(--jt-surface-hover);
}

.list-node__folder:hover {
  background-color: var(--jt-surface-hover);
}

/* 选中状态（路由激活） */
.list-node--active {
  background-color: var(--jt-accent-soft) !important;
  color: var(--jt-primary);
}

.list-node--active:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 15%, var(--jt-accent-soft)) !important;
}

/* 拖拽中：原行不变透明度（与标签行为一致，仅高亮落点行；半透明视觉由拖动浏览器提供） */

/* drag-over：整行 outline 高亮（与标签 --drag-over 视觉一致） */
.list-node--drag-over {
  outline: 1.5px solid var(--jt-primary);
  outline-offset: -1.5px;
  background-color: var(--jt-accent-soft);
}

/* dragable 行：grab cursor（与标签一致） */
.list-node__row[draggable="true"] {
  cursor: grab;
}
.list-node__row[draggable="true"]:active {
  cursor: grabbing;
}

/* drag-inside：放入目录 —— 用更深的 inset 阴影区别于排序提示 */
.list-node--drag-inside {
  background-color: color-mix(in srgb, var(--jt-primary) 12%, transparent) !important;
  box-shadow: inset 0 0 0 1.5px var(--jt-primary);
  border-radius: 8px;
}

/* 展开箭头 */
.list-node__expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
  cursor: pointer;
}

/* 文件夹图标（默认橙色，inline style 会覆盖为 node.color） */
.list-node__folder-icon {
  color: var(--jt-warning);
  flex-shrink: 0;
}

/* 名称 */
.list-node__name,
.list-node__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 色点占位（清单行对齐用） */
.list-node__dot-placeholder {
  width: 14px;
  flex-shrink: 0;
}

/* 色点 */
.list-node__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 任务计数 */
.list-node__count {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
  position: absolute;
  right: 8px;
  transition: right 0.15s;
}

/* hover 时计数左移给菜单按钮让位 */
.list-node__list-item:hover .list-node__count,
.list-node__folder:hover .list-node__count {
  right: 32px;
}

/* 在目录下新建任务按钮 —— 仅目录行有，hover 显示 */
.list-node__add-btn {
  position: absolute;
  right: 28px;
  margin: 0;
  padding: 0;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 5;
}

.list-node__folder:hover .list-node__add-btn {
  opacity: 1;
}

.list-node__add-btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

/* hover 时让位：让 + 按钮跟更多按钮共存时计数再往左一点 */
.list-node__folder:hover .list-node__count {
  right: 56px;
}

/* 更多按钮 */
.list-node__menu-btn {
  position: absolute;
  top: 50%;
  right: 4px;
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 5;
}

.list-node__row:hover .list-node__menu-btn {
  opacity: 1;
}

.list-node__menu-btn:hover {
  /* 选中态已有 accent-soft 背景，hover 不再叠加背景，只通过图标颜色加深反馈 */
  background-color: transparent;
  color: var(--jt-text-primary);
  color: var(--jt-text-primary);
}
</style>
