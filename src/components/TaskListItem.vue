<script setup lang="ts">
// 任务列表项 —— 支持树形递归（子任务嵌套展开）
// 含：展开箭头、复选框、标题、优先级色点、截止日期、hover 操作菜单
import { ref, computed, watch } from "vue";
import type { Task } from "@/types";
import { formatDueDate } from "@/utils/date";
import { useTaskStore } from "@/stores/task";
import TaskCheckbox from "./TaskCheckbox.vue";
import PriorityDot from "./PriorityDot.vue";

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

defineEmits<{
  select: [];
}>();

const taskStore = useTaskStore();

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
</script>

<template>
  <div class="task-tree-node">
    <!-- 当前任务行 -->
    <div
      class="task-item"
      :class="{ 'task-item--done': task.done }"
      :style="{ paddingLeft: depth * 20 + 'px' }"
      @click="$emit('select')"
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
        <div v-if="childCount || dueInfo" class="task-item__meta">
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
        <a-dropdown trigger="click" position="br" :popup-offset="4">
          <button
            class="task-item__menu-btn"
            @click.stop
          >
            <icon-more :size="16" />
          </button>
          <template #content>
            <a-menu class="task-item-ctx-menu" @menu-item-click="() => taskStore.deleteTask(task.id)">
              <a-menu-item key="delete" class="task-item-ctx-menu--danger">
                <icon-delete :size="15" />
                <span style="margin-left: 8px">删除任务</span>
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
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
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.task-item:hover {
  background-color: var(--jt-surface-hover);
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
  margin-top: 8px;
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

<!-- 任务项上下文菜单（非 scoped，弹层渲染到 body） -->
<style>
/* 去掉外层容器的 padding（菜单项本身保持不变） */
.arco-dropdown:has(.task-item-ctx-menu) {
  padding: 0;
}

.task-item-ctx-menu .arco-menu-inner {
  padding: 0;
}

.task-item-ctx-menu .arco-menu-item {
  margin-bottom: 0;
}

.task-item-ctx-menu .arco-menu-item .arco-icon {
  margin-right: 0;
}

.task-item-ctx-menu {
  min-width: 100px;
}

.task-item-ctx-menu--danger {
  color: var(--jt-error) !important;
}

.task-item-ctx-menu--danger .arco-icon {
  color: var(--jt-error);
}
</style>
