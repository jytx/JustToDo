<script setup lang="ts">
// 看板视图 —— 按优先级分 4 列（无/低/中/高），显示全部未完成任务
// 支持拖拽跨列改优先级 + 列内排序
import { ref, computed, onMounted } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import {
  type Task,
  type Priority,
} from "@/types";
import { formatDueDate } from "@/utils/date";
import PriorityDot from "@/components/PriorityDot.vue";
import TaskCheckbox from "@/components/TaskCheckbox.vue";
import { useKanbanDrag } from "@/composables/useKanbanDrag";

const taskStore = useTaskStore();
const listStore = useListStore();

onMounted(async () => {
  await taskStore.loadSmartView("all");
});

/** 列定义（优先级 → 列信息） */
const COLUMN_DEFS: { priority: Priority; label: string; color: string }[] = [
  { priority: 0, label: "无优先级", color: "var(--jt-text-tertiary)" },
  { priority: 1, label: "低", color: "#3B82F6" },
  { priority: 2, label: "中", color: "var(--jt-warning)" },
  { priority: 3, label: "高", color: "var(--jt-error)" },
];

/** 列容器 DOM 引用（dragover 判断用） */
const columnRefs = ref<Map<Priority, HTMLElement>>(new Map());
function setColumnRef(priority: Priority, el: HTMLElement | null): void {
  if (el) columnRefs.value.set(priority, el);
  else columnRefs.value.delete(priority);
}

/** 拖拽 composable */
const {
  localColumns,
  draggingId,
  onCardDragStart,
  onColumnDragOver,
  onColumnDrop,
  onCardDragEnd,
} = useKanbanDrag(() => taskStore.openTasks);

/** 根据 id 取任务对象 */
const taskMap = computed<Map<string, Task>>(() => {
  return new Map(taskStore.openTasks.map((t) => [t.id, t]));
});

/** 获取某列的任务列表（按 localColumns 顺序） */
function getColumnTasks(priority: Priority): Task[] {
  return localColumns.value[priority]
    .map((id) => taskMap.value.get(id))
    .filter((t): t is Task => t !== undefined);
}

/** 获取清单颜色 */
function getListColor(listId: string): string {
  return listStore.getById(listId)?.color || "#6B7280";
}

/** 格式化截止日期 */
function dueInfo(task: Task) {
  return formatDueDate(task.dueStartAt, task.dueEndAt);
}

/** 点击卡片打开详情 */
function onCardClick(taskId: string): void {
  taskStore.selectTask(taskId);
}

/** 复选框切换完成 */
function onToggle(task: Task): void {
  taskStore.toggleTask(task.id, !task.done);
}

/** 列 dragover */
function onDragOver(e: DragEvent): void {
  onColumnDragOver(e, columnRefs.value);
}
</script>

<template>
  <div class="kanban">
    <!-- 列容器（水平滚动） -->
    <div class="kanban__board">
      <div
        v-for="col in COLUMN_DEFS"
        :key="col.priority"
        :ref="(el) => setColumnRef(col.priority, el as HTMLElement)"
        class="kanban__column"
        @dragover="onDragOver"
        @drop="onColumnDrop"
      >
        <!-- 列头 -->
        <div class="kanban__column-header">
          <PriorityDot :priority="col.priority" :size="10" />
          <span class="kanban__column-title">{{ col.label }}</span>
          <span class="kanban__column-count">{{ getColumnTasks(col.priority).length }}</span>
        </div>

        <!-- 卡片列表 -->
        <TransitionGroup name="kanban-flip" class="kanban__cards">
          <div
            v-for="task in getColumnTasks(col.priority)"
            :key="task.id"
            :data-card-id="task.id"
            class="kanban__card"
            :class="{ 'kanban__card--dragging': draggingId === task.id }"
            draggable="true"
            @dragstart="onCardDragStart(task.id, col.priority)"
            @dragend="onCardDragEnd"
            @click="onCardClick(task.id)"
          >
            <!-- 复选框 -->
            <TaskCheckbox
              :done="task.done"
              :priority="task.priority"
              size="small"
              @click.stop
              @toggle="onToggle(task)"
            />
            <!-- 内容区 -->
            <div class="kanban__card-body">
              <span class="kanban__card-title">{{ task.title }}</span>
              <div class="kanban__card-meta">
                <span
                  v-if="task.listId"
                  class="kanban__card-dot"
                  :style="{ backgroundColor: getListColor(task.listId) }"
                ></span>
                <span
                  v-if="dueInfo(task)"
                  class="kanban__card-due"
                  :class="{ 'kanban__card-due--overdue': dueInfo(task)?.overdue }"
                >{{ dueInfo(task)?.text }}</span>
              </div>
            </div>
          </div>
        </TransitionGroup>

        <!-- 空列占位 -->
        <div v-if="getColumnTasks(col.priority).length === 0" class="kanban__column-empty">
          <span>拖拽任务到这里</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kanban {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 列容器：水平排列 + 横向滚动 */
.kanban__board {
  display: flex;
  gap: 12px;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 16px 16px;
}

/* 单列 */
.kanban__column {
  flex: 1;
  min-width: 240px;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--jt-surface-sunken);
  border-radius: 10px;
  border: 1px solid var(--jt-border);
  overflow: hidden;
}

/* 列头 */
.kanban__column-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--jt-border);
  flex-shrink: 0;
}
.kanban__column-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
}
.kanban__column-count {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  background: var(--jt-surface);
  padding: 0 6px;
  border-radius: 8px;
  line-height: 18px;
}

/* 卡片列表 */
.kanban__cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  overflow-y: auto;
  flex: 1;
}

/* 单张卡片 */
.kanban__card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  background: var(--jt-surface);
  border-radius: 8px;
  border: 1px solid var(--jt-border);
  cursor: grab;
  transition: box-shadow 0.12s, border-color 0.12s;
}
.kanban__card:hover {
  border-color: var(--jt-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
.kanban__card:active {
  cursor: grabbing;
}
.kanban__card--dragging {
  opacity: 0.4;
}

.kanban__card-body {
  flex: 1;
  min-width: 0;
}
.kanban__card-title {
  font-size: 13px;
  line-height: 1.5;
  color: var(--jt-text-primary);
  word-break: break-word;
}
.kanban__card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.kanban__card-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.kanban__card-due {
  font-size: 11px;
  color: var(--jt-text-secondary);
}
.kanban__card-due--overdue {
  color: var(--jt-error);
}

/* 空列占位 */
.kanban__column-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

/* FLIP 动画 */
.kanban-flip-move {
  transition: transform 0.2s ease;
}
</style>
