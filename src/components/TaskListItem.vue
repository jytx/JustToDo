<script setup lang="ts">
// 任务列表项 —— 支持树形递归（子任务嵌套展开）
// 含：展开箭头、复选框、标题、优先级色点、截止日期、hover 操作菜单
import { ref, computed, watch } from "vue";
import type { Task } from "@/types";
import { formatDueDate } from "@/utils/date";
import { useTaskStore } from "@/stores/task";
import TaskCheckbox from "./TaskCheckbox.vue";
import PriorityDot from "./PriorityDot.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = withDefaults(
  defineProps<{
    task: Task;
    /** 嵌套深度（根任务 = 0） */
    depth?: number;
    /** 是否显示清单色点（智能视图跨清单时用） */
    showListDot?: boolean;
    listColor?: string;
  }>(),
  { depth: 0, showListDot: false },
);

const emit = defineEmits<{
  select: [];
  reorder: [draggedId: string, targetId: string, position: "before" | "after"];
}>();

// ─── 拖拽排序（仅根任务 depth=0 且未完成 且 当前为手动排序模式时启用） ──────────────
const taskStore = useTaskStore();
const canDrag = computed(
  () =>
    props.depth === 0 &&
    !props.task.done &&
    taskStore.currentSort.field === "manual",
);
const dragOver = ref<"before" | "after" | null>(null);
const isDragging = ref(false);

function onDragStart(e: DragEvent) {
  if (!canDrag.value) {
    e.preventDefault();
    return;
  }
  e.dataTransfer!.setData("text/plain", props.task.id);
  e.dataTransfer!.effectAllowed = "move";

  // 自定义幽灵图：任务标题
  const ghost = document.createElement("div");
  ghost.textContent = props.task.title;
  ghost.style.cssText = `position:absolute;top:-1000px;left:-1000px;padding:5px 12px;background:var(--jt-primary,#4F46E5);color:#fff;font-size:13px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.2);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
  document.body.appendChild(ghost);
  e.dataTransfer!.setDragImage(ghost, 15, 12);
  setTimeout(() => document.body.removeChild(ghost), 0);

  isDragging.value = true;
}

function onDragEnd() {
  isDragging.value = false;
  dragOver.value = null;
}

function onDragOver(e: DragEvent) {
  if (!canDrag.value) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  dragOver.value = computeDropPosition(e);
}

/** 计算拖拽放置位置：上半区 60% 为 before，下半区 40% 为 after */
function computeDropPosition(e: DragEvent): "before" | "after" {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  return y < rect.height * 0.6 ? "before" : "after";
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

// ─── 子任务展开 / 懒加载 ───────────────────────────────
const expanded = ref(false);
const childSubtasks = computed(() =>
  taskStore.getCachedSubtasks(props.task.id),
);

/** 是否有子任务（需要先加载才知道）——先假设可能有，首次展开时加载 */
const hasSubtasksLoaded = computed(() => props.task.id in taskStore.subtaskCache);
const childCount = computed(() => childSubtasks.value.length);

/** 子任务完成数 */
const childDoneCount = computed(() =>
  childSubtasks.value.filter((t) => t.done).length,
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
</script>

<template>
  <div class="task-tree-node">
    <!-- 当前任务行 -->
    <div
      ref="itemRef"
      class="task-item"
      :class="{
        'task-item--done': task.done,
        'task-item--selected': isSelected,
        'task-item--focused': isFocused,
        'task-item--dragging': isDragging,
        'task-item--drag-before': dragOver === 'before',
        'task-item--drag-after': dragOver === 'after',
      }"
      :style="{ paddingLeft: depth * 20 + 'px' }"
      :draggable="canDrag ? 'true' : 'false'"
      @click="$emit('select')"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
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

      <TaskCheckbox :done="task.done" @toggle="doToggle" />

      <!-- 清单色点（智能视图） -->
      <span
        v-if="showListDot"
        class="task-item__list-dot"
        :style="{ backgroundColor: listColor || '#6B7280' }"
      />

      <div class="task-item__body">
        <span class="task-item__title">{{ task.title }}</span>
        <div v-if="task.recurrenceFreq || childCount || dueInfo" class="task-item__meta">
          <span v-if="task.recurrenceFreq" class="task-item__recurrence" title="重复任务">
            <icon-refresh :size="12" />
          </span>
          <span v-if="hasSubtasksLoaded && childCount" class="task-item__subtasks">
            └ {{ childDoneCount }}/{{ childCount }} 个子任务
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

      <div class="task-item__actions">
        <PriorityDot :priority="task.priority" />
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
            <span>删除任务</span>
          </MenuPopoverItem>
        </MenuPopover>
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
  </div>
</template>

<style scoped>
.task-tree-node {
  display: flex;
  flex-direction: column;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.task-item:hover {
  background-color: var(--jt-surface-hover);
}

/* 选中状态 */
.task-item--selected {
  background-color: var(--jt-accent-soft);
}

.task-item--selected:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 15%, var(--jt-accent-soft));
}

/* 键盘导航焦点状态（虚线边框，区别于选中的背景色） */
.task-item--focused {
  outline: 2px solid var(--jt-primary);
  outline-offset: -2px;
}

/* 拖拽排序视觉反馈 */
.task-item--dragging {
  opacity: 0.3;
}

/* drag-before：顶部插入线 + 淡背景 */
.task-item--drag-before {
  background-color: color-mix(in srgb, var(--jt-primary) 5%, transparent) !important;
}
.task-item--drag-before::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 12px;
  right: 12px;
  height: 2px;
  background: var(--jt-primary);
  border-radius: 1px;
  z-index: 10;
}

/* drag-after：底部插入线 + 淡背景 */
.task-item--drag-after {
  background-color: color-mix(in srgb, var(--jt-primary) 5%, transparent) !important;
}
.task-item--drag-after::after {
  content: "";
  position: absolute;
  bottom: -1px;
  left: 12px;
  right: 12px;
  height: 2px;
  background: var(--jt-primary);
  border-radius: 1px;
  z-index: 10;
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

.task-item__meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--jt-text-secondary);
}

.task-item__subtasks {
  display: flex;
  align-items: center;
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
