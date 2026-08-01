<script setup lang="ts">
// 侧边栏清单树形节点 —— 递归渲染目录和清单
// 支持拖拽排序和拖拽到其他目录
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ListTreeNode } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { useSettingsStore } from "@/stores/settings";
import {
  IconFolder,
  IconMore,
  IconEdit,
  IconDelete,
  IconPlus,
  IconRight,
  IconDown,
  IconArchive,
} from "@arco-design/web-vue/es/icon";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = defineProps<{
  node: ListTreeNode;
  depth: number;
  /**
   * 只读模式（归档区使用）：
   * - 隐藏行内 + 号（在该目录下新建清单）
   * - 目录行的 MenuPopover 不渲染（"+ 子目录 / 编辑 / 删除 / 归档" 等都禁掉）
   * - 清单行的 MenuPopover 仅保留右键菜单项（无 hover 菜单）
   * 任务的右键菜单由调用方通过 ctxmenu 事件自行实现，这里不参与
   * 默认 false
   */
  readonly?: boolean;
  /** 节点类型：'task'（默认，清单/目录）| 'note'（笔记本/笔记本目录）。
   *  决定路由前缀（/list vs /notebook）、计数来源、菜单文案。 */
  kind?: "task" | "note";
}>();

const taskStore = useTaskStore();
const settingsStore = useSettingsStore();
const router = useRouter();
const route = useRoute();

/** 是否为笔记本节点（kind='note'）：影响路由、计数、菜单文案 */
const isNote = computed(() => props.kind === "note");
/** 对应的路由名与路径前缀 */
const routeName = computed(() => (isNote.value ? "notebook" : "list"));
// routePrefix 保留供后续扩展使用（暂未在模板内直接使用 —— 兼容路由前缀）
const routePrefix = computed(() => (isNote.value ? "/notebook" : "/list"));

/**
 * 计算树节点左侧缩进。
 * 顶层节点也需要位于“清单”分组标题的右侧，每深入一级再增加 16px。
 */
function getNodePaddingLeft(depth: number): string {
  const baseIndent: number = 16;
  const levelIndent: number = 16;
  return `${baseIndent + depth * levelIndent}px`;
}

/** 当前清单/笔记本项是否处于路由激活态（仅叶节点，非目录） */
const isActive = computed(
  () =>
    !props.node.isFolder &&
    route.name === routeName.value &&
    route.params.id === props.node.id,
);

const expanded = ref(true);

const emit = defineEmits<{
  edit: [node: ListTreeNode];
  delete: [node: ListTreeNode];
  /** 在该目录下新建子目录 */
  addFolder: [node: ListTreeNode];
  /** 在该目录下新建清单 */
  addList: [node: ListTreeNode];
  /** 在该清单下新建任务（仅清单菜单） */
  addTask: [node: ListTreeNode];
  /** 归档当前节点（目录或清单）；TheSidebar 调 store.archiveTree */
  archive: [node: ListTreeNode];
  /** AI 总结当前节点（目录/清单/笔记本），与右键菜单对齐 */
  aiSummary: [node: ListTreeNode];
  /** 拖拽放置：被拖拽的节点 ID，目标父级 ID，目标位置（before/after/inside） */
  move: [draggedId: string, targetNode: ListTreeNode, position: "before" | "after" | "inside"];
  /** 右键菜单：鼠标事件 + 当前节点（向上冒泡到 TheSidebar 统一处理） */
  contextmenu: [event: MouseEvent, node: ListTreeNode];
}>();

/** 菜单点击的 key（addFolder 仅目录菜单有，addTask 仅清单菜单有） */
function onMenuClick(key: "edit" | "delete" | "addFolder" | "addTask" | "archive" | "aiSummary") {
  folderMenuOpen.value = false;
  listMenuOpen.value = false;
  if (key === "edit") emit("edit", props.node);
  else if (key === "delete") emit("delete", props.node);
  else if (key === "addFolder") emit("addFolder", props.node);
  else if (key === "addTask") emit("addTask", props.node);
  else if (key === "archive") emit("archive", props.node);
  else if (key === "aiSummary") emit("aiSummary", props.node);
}

/** 目录行更多菜单（独立 ref） */
const folderMenuOpen = ref(false);
/** 清单行更多菜单（独立 ref） */
const listMenuOpen = ref(false);

/** 点击清单/笔记本行 → 路由跳转（按 kind 决定前缀） */
function goToList() {
  if (!props.node.isFolder) {
    router.push(`${routePrefix.value}/${props.node.id}`);
  }
}

// ─── 拖拽逻辑 ──────────────────────────────────────────

/** 当前 drag-over 状态：null / 'before' / 'after' / 'inside' */
const dragOver = ref<"before" | "after" | "inside" | null>(null);
const isDragging = ref(false);

/** 是否可拖动（inbox / default-notebook 位置固定，不可拖） */
const canDrag = computed(
  () => props.node.id !== "inbox" && props.node.id !== "default-notebook",
);

function onDragStart(e: DragEvent) {
  if (!canDrag.value) {
    e.preventDefault();
    return;
  }
  e.dataTransfer!.setData("text/plain", props.node.id);
  e.dataTransfer!.effectAllowed = "move";
  // 不设置自定义 setDragImage，让浏览器默认用整个清单项的半透明截图作为拖拽视觉，
  // 体现"整行被移动"的效果（而不是只有文字的小卡片）。
  isDragging.value = true;
}

function onDragEnd() {
  isDragging.value = false;
  dragOver.value = null;
}

function onDragOver(e: DragEvent) {
  // 始终 preventDefault + 设 dropEffect="move"，保证整个侧边栏区域都显示
  // "可移动"光标，避免鼠标经过 inbox 时光标闪烁成禁止/加号。
  // inbox 是否真正接受 drop 由 onDrop 里的业务判断决定。
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  // 收件箱 / 默认笔记本位置固定，不参与落点高亮（仅作过路）
  if (props.node.id === "inbox" || props.node.id === "default-notebook") return;

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

/** dragenter：拖拽进入元素时立即锁定 dropEffect="move"，
 *  消除"刚拖起来那一瞬间"光标闪成默认 +/copy 的现象（react-dnd issue #414）。
 *  dragenter 到首个 dragover 之间存在光标未定窗口，必须在此显式声明。 */
function onDragEnter(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
}

function onDragLeave(e: DragEvent) {
  // 只有真正离开这个元素（不是进入子元素）才清除
  const related = e.relatedTarget as HTMLElement | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  dragOver.value = null;
}

function onDrop(e: DragEvent) {
  // 收件箱 / 默认笔记本位置固定，不接受其他节点的 drop
  if (props.node.id === "inbox" || props.node.id === "default-notebook") {
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
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @contextmenu.prevent="emit('contextmenu', $event, node)"
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
      <!-- 在该目录下新建清单/笔记本（hover 才显示）；只读模式（归档区）隐藏 -->
      <button
        v-if="!readonly"
        class="list-node__add-btn"
        :title="isNote ? '在此目录下新建笔记本' : '在此目录下新建清单'"
        @click.stop="emit('addList', node)"
      >
        <icon-plus :size="14" />
      </button>
      <MenuPopover v-if="!readonly" v-model:visible="folderMenuOpen">
        <template #trigger>
          <button class="list-node__menu-btn" @click.stop="folderMenuOpen = !folderMenuOpen">
            <icon-more :size="16" />
          </button>
        </template>
        <MenuPopoverItem @click="onMenuClick('addFolder')">
          <icon-plus :size="15" />
          <span>添加子目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onMenuClick('edit')">
          <icon-edit :size="15" />
          <span>编辑目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onMenuClick('delete')">
          <icon-delete :size="15" />
          <span>删除目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem v-if="settingsStore.aiEnabled && !node.archived" @click="onMenuClick('aiSummary')">
          <icon-robot :size="15" />
          <span>AI 总结</span>
        </MenuPopoverItem>
        <!-- 归档：仅主页（未归档）显示。归档区由 contextmenu 触发取消归档，
             hover 菜单不暴露，避免误点导致跨树来回 -->
        <MenuPopoverItem v-if="!node.archived" @click="onMenuClick('archive')">
          <icon-archive :size="15" />
          <span>归档目录</span>
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
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="goToList"
      @contextmenu.prevent="emit('contextmenu', $event, node)"
    >
      <span class="list-node__dot-placeholder" />
      <span
        class="list-node__dot"
        :style="{ backgroundColor: node.color }"
      />
      <span class="list-node__title">{{ node.name }}</span>
      <span v-if="(isNote ? taskStore.noteCounts : taskStore.listCounts)[node.id]" class="list-node__count">{{ (isNote ? taskStore.noteCounts : taskStore.listCounts)[node.id] }}</span>
      <MenuPopover
        v-if="!readonly && node.id !== 'inbox' && node.id !== 'default-notebook'"
        v-model:visible="listMenuOpen"
      >
        <template #trigger>
          <button class="list-node__menu-btn" @click.stop.prevent="listMenuOpen = !listMenuOpen">
            <icon-more :size="16" />
          </button>
        </template>
        <MenuPopoverItem @click="onMenuClick('addTask')">
          <icon-plus :size="15" />
          <span>{{ isNote ? "新建笔记" : "新建任务" }}</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onMenuClick('edit')">
          <icon-edit :size="15" />
          <span>{{ isNote ? "编辑笔记本" : "编辑清单" }}</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onMenuClick('delete')">
          <icon-delete :size="15" />
          <span>{{ isNote ? "删除笔记本" : "删除清单" }}</span>
        </MenuPopoverItem>
        <MenuPopoverItem v-if="settingsStore.aiEnabled && !node.archived" @click="onMenuClick('aiSummary')">
          <icon-robot :size="15" />
          <span>AI 总结</span>
        </MenuPopoverItem>
        <!-- 归档：仅主页（未归档）显示 -->
        <MenuPopoverItem v-if="!node.archived" @click="onMenuClick('archive')">
          <icon-archive :size="15" />
          <span>{{ isNote ? "归档笔记本" : "归档清单" }}</span>
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
        :readonly="readonly"
        :kind="kind"
        @edit="(n: ListTreeNode) => $emit('edit', n)"
        @delete="(n: ListTreeNode) => $emit('delete', n)"
        @addFolder="(n: ListTreeNode) => $emit('addFolder', n)"
        @addList="(n: ListTreeNode) => $emit('addList', n)"
        @addTask="(n: ListTreeNode) => $emit('addTask', n)"
        @archive="(n: ListTreeNode) => $emit('archive', n)"
        @move="(id: string, target: ListTreeNode, pos: 'before' | 'after' | 'inside') => $emit('move', id, target, pos)"
        @contextmenu="(e: MouseEvent, n: ListTreeNode) => $emit('contextmenu', e, n)"
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

/* 不可拖拽行（收件箱 inbox）—— 在渲染层彻底阻止拖拽。
 * WKWebView (macOS) 中 draggable="false" 的元素其子文本节点仍默认可被
 * 原生拖拽，可能导致原生拖拽会话异常。-webkit-user-drag: none 是 WebKit
 * 专用属性，在渲染层阻止元素及其子元素启动拖拽，作为防御性保护。 */
.list-node__row[draggable="false"] {
  -webkit-user-drag: none;
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
