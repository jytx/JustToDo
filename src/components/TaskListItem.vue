<script setup lang="ts">
// 任务列表项 —— 支持树形递归（子任务嵌套展开）
// 含：展开箭头、复选框、标题、优先级色点、截止日期、hover 操作菜单
import { ref, computed, watch, reactive } from "vue";
import type { Task } from "@/types";
import { PRIORITY_COLORS } from "@/types";
import { formatDueDate } from "@/utils/date";
import { useTaskStore } from "@/stores/task";
import TaskCheckbox from "./TaskCheckbox.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import ContextMenu from "./ContextMenu.vue";

const props = withDefaults(
  defineProps<{
    task: Task;
    /** 嵌套深度（根任务 = 0） */
    depth?: number;
    /** 是否显示清单色点（智能视图跨清单时用） */
    showListDot?: boolean;
    listColor?: string;
    /** 是否正在被拖拽（由父视图传入，用于源行半透明） */
    dragging?: boolean;
  }>(),
  { depth: 0, showListDot: false, dragging: false },
);

const emit = defineEmits<{
  select: [];
  reorder: [draggedId: string, targetId: string, position: "before" | "after"];
  /** 拖拽开始：通知父视图记录 draggingId（FLIP 实时让位用） */
  dragstart: [taskId: string];
  /** 拖拽结束：通知父视图持久化最终顺序 */
  dragend: [];
}>();

// ─── 拖拽排序（仅根任务 depth=0 且未完成 且 当前为手动排序模式时启用） ──────────────
const taskStore = useTaskStore();

/** 笔记（kind='note'）：无完成/日期/重复概念，UI 隐藏这些区块。
 *  笔记仍可拖拽排序（复用任务的拖拽逻辑，仅去掉 done 限制）。 */
const isNote = computed(() => props.task.kind === "note");

const canDrag = computed(
  () =>
    props.depth === 0 &&
    (isNote.value || !props.task.done) &&
    taskStore.currentSort.field === "manual",
);
const dragOver = ref<"before" | "after" | null>(null);

function onDragStart(e: DragEvent) {
  if (!canDrag.value) {
    e.preventDefault();
    return;
  }
  e.dataTransfer!.setData("text/plain", props.task.id);
  e.dataTransfer!.effectAllowed = "move";
  e.dataTransfer!.dropEffect = "move";
  // 通知父视图记录 draggingId（FLIP 实时让位用）
  emit("dragstart", props.task.id);
  // 不设置自定义 setDragImage，让浏览器默认用整个任务项的半透明截图作为拖拽视觉，
  // 体现"整行被移动"的效果（而不是只有文字的小卡片）。
}

function onDragEnd() {
  dragOver.value = null;
  // 通知父视图持久化最终顺序（WKWebView 的 drop 不可靠，以 dragend 为准）
  emit("dragend");
}

function onDragOver(e: DragEvent) {
  // 始终 preventDefault + 设 dropEffect="move"，保证整个列表区域都显示
  // "可移动"光标，避免鼠标在可拖/不可拖行之间移动时光标闪烁成禁止/加号。
  // 是否真正执行 reorder 由 onDrop 里的业务判断决定。
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  // 不可拖拽的行不参与落点高亮（仅作过路），但仍 preventDefault 避免光标闪烁
  if (!canDrag.value) return;
  dragOver.value = computeDropPosition(e);
}

/** dragenter：拖拽进入元素时立即锁定 dropEffect="move"，
 *  消除"刚拖起来那一瞬间"光标闪成默认 +/copy 的现象（react-dnd issue #414）。
 *  dragenter 到首个 dragover 之间存在光标未定窗口，必须在此显式声明。 */
function onDragEnter(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
}

/** 计算拖拽放置位置：与 SidebarListNode 保持一致 —— 上 1/3 为 before，下 2/3 为 after */
function computeDropPosition(e: DragEvent): "before" | "after" {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  return y < rect.height / 3 ? "before" : "after";
}

function onDragLeave(e: DragEvent) {
  const related = e.relatedTarget as HTMLElement | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  dragOver.value = null;
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  const draggedId = e.dataTransfer!.getData("text/plain");
  if (!draggedId || draggedId === props.task.id || !canDrag.value) {
    dragOver.value = null;
    return;
  }

  const position = computeDropPosition(e);

  emit("reorder", draggedId, props.task.id, position);
  dragOver.value = null;
}

/** 是否被选中（详情面板打开时） */
const isSelected = computed(() => taskStore.selectedTaskId === props.task.id);

/** 是否被键盘导航聚焦（仅视觉高亮，不打开详情面板） */
const isFocused = computed(() => taskStore.focusedTaskId === props.task.id);

/** 任务项根元素 ref（用于 scrollIntoView） */
const itemRef = ref<HTMLElement>();

// 焦点变化时滚动到可视区域
watch(isFocused, (focused) => {
  if (focused) {
    // 用 nearest 模式：仅当不可见时才滚动，避免抢滚动条
    itemRef.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});

const dueInfo = computed(() => formatDueDate(props.task.dueStartAt, props.task.dueEndAt));

/** 优先级对应的颜色（高=红 中=橙 低=蓝）*/
const priorityColor = computed<string>(() => {
  const token = PRIORITY_COLORS[props.task.priority];
  if (token === "error") return "var(--jt-error)";
  if (token === "warning") return "var(--jt-warning)";
  if (token === "info") return "#3B82F6";
  return "var(--jt-text-tertiary)";
});

// ─── 子任务展开 / 懒加载 ───────────────────────────────
const expanded = ref(false);
const childSubtasks = computed(() =>
  taskStore.getCachedSubtasks(props.task.id),
);

// ─── 任务标签（从 store 缓存读取，用于任务项显示） ───────────────────────────────
const taskTags = computed(() => taskStore.taskTagMap[props.task.id] ?? []);

/** 是否有子任务（需要先加载才知道）——先假设可能有，首次展开时加载 */
const hasSubtasksLoaded = computed(() => props.task.id in taskStore.subtaskCache);
const childCount = computed(() => childSubtasks.value.length);

/** 子任务完成数 */
const childDoneCount = computed(() =>
  childSubtasks.value.filter((t) => t.done).length,
);

/** 子任务进度百分比（0–100，用于底边进度条的填充宽度）。
 *  无子任务时为 0，渲染层用 hasSubtasks 控制是否显示底边。 */
const childProgress = computed(() => {
  if (childCount.value <= 0) return 0;
  return Math.round((childDoneCount.value / childCount.value) * 100);
});

/** 是否显示底边进度条（有子任务才显示） */
const hasSubtaskProgress = computed(
  () => hasSubtasksLoaded.value && childCount.value > 0,
);

async function toggleExpand() {
  expanded.value = !expanded.value;
}

/** 直接 toggle 当前任务 */
async function doToggle() {
  await taskStore.toggleTask(props.task.id, !props.task.done);
}

// 当子任务缓存更新后，如果展开状态下子任务为空，自动收起
watch(childCount, (n) => {
  if (n === 0 && expanded.value && hasSubtasksLoaded.value) {
    expanded.value = false;
  }
});

// ─── 任务行右侧更多菜单 ──────────────────────────────
const menuOpen = ref(false);

function onDelete() {
  menuOpen.value = false;
  taskStore.requestDelete(props.task.id);
}

// ─── 右键菜单 ──────────────────────────────────────
/** 右键菜单状态：可见性 + 鼠标坐标 */
const ctxMenu = reactive<{ visible: boolean; x: number; y: number }>({
  visible: false,
  x: 0,
  y: 0,
});

/** 打开右键菜单：记录鼠标坐标 */
function onContextMenu(e: MouseEvent): void {
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.visible = true;
}

/** 新建同级任务：与当前任务同一父级、同一清单。
 *  - 当前是顶层任务（parentId=null）→ 新建顶层任务
 *  - 当前是子任务（parentId 非空）→ 新建同父子任务
 *  走「空标题 + 选中打开详情面板」范式，让用户直接输入标题。 */
async function onCtxAddSiblingTask(): Promise<void> {
  ctxMenu.visible = false;
  const created = await taskStore.createTask({
    title: "",
    listId: props.task.listId,
    parentId: props.task.parentId,
    kind: props.task.kind,
  });
  taskStore.selectTask(created.id);
}

/** 新建子任务：在当前任务下创建下级任务。
 *  复用 TaskDetailPanel.addSubtask 的范式：createSubtask(空标题) → 刷新子任务 → 选中。 */
async function onCtxAddSubtask(): Promise<void> {
  ctxMenu.visible = false;
  await taskStore.createSubtask(props.task, "");
  await taskStore.loadSubtasks(props.task.id);
  const sub = taskStore.subtasks[taskStore.subtasks.length - 1];
  if (sub) taskStore.selectTask(sub.id);
}

/** 删除任务（走现有的删除确认弹窗） */
function onCtxDelete(): void {
  ctxMenu.visible = false;
  taskStore.requestDelete(props.task.id);
}
</script>

<template>
  <div class="task-tree-node" :data-task-id="task.id">
    <!-- 当前任务行 -->
    <div
      ref="itemRef"
      class="task-item"
      :class="{
        'task-item--done': task.done,
        'task-item--selected': isSelected,
        'task-item--focused': isFocused,
        'task-item--drag-over': dragOver === 'before' || dragOver === 'after',
        'task-item--dragging': dragging,
        'task-item--has-subtasks': hasSubtaskProgress,
        'task-item--subtasks-done': hasSubtaskProgress && childProgress >= 100,
      }"
      :style="{
        paddingLeft: depth * 20 + 'px',
        '--jt-subtask-progress': childProgress + '%',
      }"
      :draggable="canDrag ? 'true' : 'false'"
      @click="$emit('select')"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @contextmenu.prevent.stop="onContextMenu($event)"
    >
      <!-- 展开箭头（无子任务时不显示） -->
      <span
        v-if="hasSubtasksLoaded && childCount > 0"
        class="task-item__expand"
        @click.stop="toggleExpand"
      >
        <icon-right v-if="!expanded" :size="14" />
        <icon-down v-else :size="14" />
      </span>
      <!-- 无子任务时占位，保持缩进对齐 -->
      <span v-else class="task-item__expand-placeholder" />

      <!-- 复选框（笔记无完成概念，隐藏） -->
      <TaskCheckbox v-if="!isNote" :done="task.done" @toggle="doToggle" />

      <!-- 笔记图标徽章（区分于任务；标签/搜索视图中任务和笔记全局共用） -->
      <icon-file v-else :size="14" class="task-item__note-icon" />

      <!-- 清单色点（智能视图） -->
      <span
        v-if="showListDot"
        class="task-item__list-dot"
        :style="{ backgroundColor: listColor || '#6B7280' }"
      />

      <div class="task-item__body">
        <span class="task-item__title">{{ task.title }}</span>
        <!-- 标签 chips（独立一行，显示在标题下方） -->
        <div v-if="taskTags.length" class="task-item__tags">
          <span
            v-for="tag in taskTags"
            :key="tag.id"
            class="task-item__tag"
          >{{ tag.name }}</span>
        </div>
        <div v-if="task.recurrenceFreq || dueInfo" class="task-item__meta">
          <span v-if="task.recurrenceFreq" class="task-item__recurrence" title="重复任务">
            <icon-refresh :size="12" />
          </span>
          <span
            v-if="dueInfo"
            class="task-item__due"
            :class="{
              'task-item__due--overdue': dueInfo.overdue,
              'task-item__due--today': dueInfo.isToday,
            }"
          >
            <icon-exclamation-circle :size="12" />
            {{ dueInfo.text }}
          </span>
        </div>
      </div>

      <!-- 优先级火焰图标（常驻显示，无优先级时不渲染）-->
      <icon-fire
        v-if="task.priority > 0"
        :size="14"
        class="task-item__priority"
        :style="{ color: priorityColor }"
      />

      <div class="task-item__actions">
        <MenuPopover v-model:visible="menuOpen">
          <template #trigger>
            <button
              class="task-item__menu-btn"
              @click.stop="menuOpen = !menuOpen"
            >
              <icon-more :size="16" />
            </button>
          </template>
          <MenuPopoverItem danger @click="onDelete">
            <icon-delete :size="15" />
            <span>{{ isNote ? "删除笔记" : "删除任务" }}</span>
          </MenuPopoverItem>
        </MenuPopover>
      </div>

      <!-- 子任务进度条（贴底，仅当有子任务时渲染；详见 .task-item__subtask-bar） -->
      <div v-if="hasSubtaskProgress" class="task-item__subtask-bar">
        <div class="task-item__subtask-bar-fill" />
      </div>
    </div>

    <!-- 递归渲染子任务 -->
    <div v-if="expanded && childSubtasks.length" class="task-tree-node__children">
      <TaskListItem
        v-for="sub in childSubtasks"
        :key="sub.id"
        :task="sub"
        :depth="depth + 1"
        @select="taskStore.selectTask(sub.id)"
      />
    </div>

    <!-- 右键菜单：新建同级 / 新建子项 / 删除（文案随 kind：任务/笔记） -->
    <ContextMenu v-model:visible="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y">
      <MenuPopoverItem @click="onCtxAddSiblingTask">
        <icon-plus :size="15" />
        <span>{{ isNote ? "新建笔记" : "新建任务" }}</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="onCtxAddSubtask">
        <icon-branch :size="15" />
        <span>{{ isNote ? "新建子笔记" : "新建子任务" }}</span>
      </MenuPopoverItem>
      <MenuPopoverItem danger @click="onCtxDelete">
        <icon-delete :size="15" />
        <span>{{ isNote ? "删除笔记" : "删除任务" }}</span>
      </MenuPopoverItem>
    </ContextMenu>
  </div>
</template>

<style scoped>
.task-tree-node {
  display: flex;
  flex-direction: column;
}

.task-item {
  position: relative; /* 子任务进度条（绝对定位贴底）的定位基准 */
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  /* 裁切贴底的子任务进度条，使其两端自动贴合本行的 8px 圆角，
   * 呈现"行底边的彩色加粗版"效果，弧度与任务行一致。
   * 菜单浮层（MenuPopover）已 teleport 到 body，不受此裁切影响。 */
  overflow: hidden;
}

/* 子任务进度条 —— 用任务行底边作为进度可视化（替代独立的文字计数）
 * 设计：
 *  - 无子任务：不渲染，行底完全透明（保持原样）
 *  - 有子任务：底边一条浅色「轨道」（满宽，铺满行底）
 *  - 部分完成：轨道上叠一条按 doneCount/totalCount 比例的深色「填充」
 *  - 全部完成：填充满宽（100%），整体变深
 * 横向铺满 + 贴底，由父级 .task-item 的 overflow:hidden + 8px 圆角
 * 自动裁切两端，弧度与任务行一致。
 * 宽度比例通过 CSS 变量 --jt-subtask-progress 注入（如 "33%"）。 */
.task-item__subtask-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background-color: color-mix(in srgb, var(--jt-text-tertiary) 22%, transparent);
  overflow: hidden;
  pointer-events: none; /* 不拦截行点击 */
}

/* 填充条：宽度 = 已完成子任务占比，主色；全完成时整体变绿 */
.task-item__subtask-bar-fill {
  height: 100%;
  width: var(--jt-subtask-progress, 0%);
  background-color: var(--jt-primary);
  transition: width 0.25s ease, background-color 0.25s ease;
}

/* 全部子任务完成：填充变绿，强化完成语义 */
.task-item--subtasks-done .task-item__subtask-bar-fill {
  background-color: var(--jt-success);
}

.task-item:hover {
  background-color: var(--jt-surface-hover);
}

/* 选中状态 —— 与侧边栏清单 .list-node--active 完全对齐：
 *  - 底色用 --jt-accent-soft；hover 时叠 15% primary 加深
 *  - 加 !important 压过 .task-item:hover，否则选中行悬停时
 *    会被 --jt-surface-hover 浅灰覆盖，表现为"看不出选中"。 */
.task-item--selected {
  background-color: var(--jt-accent-soft) !important;
}

.task-item--selected:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 15%, var(--jt-accent-soft)) !important;
}

/* 键盘导航焦点状态（虚线边框，区别于选中的背景色） */
.task-item--focused {
  outline: 2px solid var(--jt-primary);
  outline-offset: -2px;
}

/* 拖拽排序视觉反馈 —— 与侧边栏清单节点（SidebarListNode）一致：
 * 整行 outline 高亮 + accent-soft 背景；不使用上下细线/半透明。 */
.task-item--drag-over {
  outline: 1.5px solid var(--jt-primary);
  outline-offset: -1.5px;
  background-color: var(--jt-accent-soft);
}

/* 可拖拽行：grab cursor（与清单行一致） */
.task-item[draggable="true"] {
  cursor: grab;
}
.task-item[draggable="true"]:active {
  cursor: grabbing;
}

/* 拖拽中的源行：半透明留在原位（与模板卡片 .tpl-card--dragging 一致） */
.task-item--dragging {
  opacity: 0.4;
}

/* 不可拖拽行（已完成任务 / 非手动排序）—— 在渲染层彻底阻止拖拽。
 * WKWebView (macOS) 中 draggable="false" 的元素其子文本节点仍默认可被
 * 原生拖拽，可能导致原生拖拽会话异常。-webkit-user-drag: none 是 WebKit
 * 专用属性，在渲染层阻止元素及其子元素启动拖拽，作为防御性保护。 */
.task-item[draggable="false"] {
  -webkit-user-drag: none;
}

.task-item__expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s;
}

.task-item__expand:hover {
  background-color: var(--jt-surface-hover);
}

/* 无子任务时的占位，保持缩进对齐 */
.task-item__expand-placeholder {
  display: block;
  width: 16px;
  height: 20px;
  flex-shrink: 0;
  margin-top: 1px;
}

.task-item__list-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* 笔记图标徽章（替代复选框位置，与复选框等宽对齐） */
.task-item__note-icon {
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
}

.task-item__body {
  flex: 1;
  min-width: 0;
}

.task-item__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
  line-height: 1.5;
  word-break: break-word;
  transition: all 0.2s ease;
}

.task-item--done .task-item__title {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

/* 标签 chips 行（标题下方独立一行） */
.task-item__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

/* 单个标签 chip —— 轻量视觉，不抢标题焦点 */
.task-item__tag {
  font-size: 11px;
  line-height: 1.4;
  padding: 0 6px;
  border-radius: 4px;
  background-color: var(--jt-accent-soft);
  color: var(--jt-text-secondary);
  white-space: nowrap;
}

/* 已完成任务的标签弱化（与标题删除线一致的处理） */
.task-item--done .task-item__tag {
  opacity: 0.5;
}

.task-item__meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--jt-text-secondary);
}

.task-item__recurrence {
  display: inline-flex;
  align-items: center;
  color: var(--jt-primary);
  opacity: 0.7;
}

.task-item__due {
  display: flex;
  align-items: center;
  gap: 2px;
}

.task-item__due--overdue {
  color: var(--jt-error);
}

.task-item__due--today {
  font-weight: 600;
}

/* 优先级火焰图标（常驻显示，无优先级时 v-if 不渲染）*/
.task-item__priority {
  flex-shrink: 0;
  margin-right: 4px;
}

.task-item__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.task-item:hover .task-item__actions {
  opacity: 1;
}

.task-item__menu-btn {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.task-item__menu-btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
</style>
