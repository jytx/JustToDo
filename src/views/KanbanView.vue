<script setup lang="ts">
// 看板视图 —— 作为清单的视图（由 ListView 按 ?view=kanban 条件渲染）
// 支持两种分列维度：按优先级（无/低/中/高）或按分组（Group）
// 只显示当前清单的任务，拖拽跨列改对应字段（priority / groupId）+ 列内排序
import { computed, watch } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useGroupStore } from "@/stores/group";
import { useKanbanStore } from "@/stores/kanban";
import { type Task, type Priority } from "@/types";
import { formatDueDate } from "@/utils/date";
import PriorityDot from "@/components/PriorityDot.vue";
import TaskCheckbox from "@/components/TaskCheckbox.vue";
import { useKanbanDrag, type KanbanColumnDef } from "@/composables/useKanbanDrag";

const props = defineProps<{ id: string }>();

const taskStore = useTaskStore();
const listStore = useListStore();
const groupStore = useGroupStore();
const kanbanStore = useKanbanStore();

// 数据由父级 ListView 加载（loadTasks + loadGroups），看板复用同一 store 数据。
// 这里仅兜底：清单切换时确保分组刷新（任务由 ListView 的 watch 触发）。
watch(
  () => props.id,
  async (newId) => {
    await groupStore.loadGroups(newId);
  },
  { immediate: true },
);

/** 优先级模式的固定列定义 */
const PRIORITY_COLUMNS: { priority: Priority; label: string; color: string }[] = [
  { priority: 0, label: "无优先级", color: "var(--jt-text-tertiary)" },
  { priority: 1, label: "低", color: "#3B82F6" },
  { priority: 2, label: "中", color: "var(--jt-warning)" },
  { priority: 3, label: "高", color: "var(--jt-error)" },
];

/** 当前模式的列定义（computed：优先级模式固定 4 列；分组模式从任务的去重 groupId 生成） */
const columnDefs = computed<KanbanColumnDef[]>(() => {
  if (kanbanStore.mode === "priority") {
    return PRIORITY_COLUMNS.map((c) => ({ key: String(c.priority), label: c.label, color: c.color }));
  }
  // 分组模式：从任务提取去重 groupId，按 groupStore.currentGroups（已按本清单过滤+排序）取名
  const usedIds = new Set<string>();
  for (const t of taskStore.openTasks) {
    usedIds.add(t.groupId ?? "__ungrouped__");
  }
  // 已知分组按 sortOrder 排序在前，未知/未分组在后
  const known = groupStore.currentGroups
    .filter((g) => usedIds.has(g.id))
    .map((g) => ({ key: g.id, label: g.name, color: "var(--jt-text-tertiary)" }));
  const result: KanbanColumnDef[] = [...known];
  if (usedIds.has("__ungrouped__")) {
    result.push({ key: "__ungrouped__", label: "未分组", color: "var(--jt-text-tertiary)" });
  }
  // 兜底：没有任何分组时显示一个空列
  if (result.length === 0) result.push({ key: "__ungrouped__", label: "未分组", color: "var(--jt-text-tertiary)" });
  return result;
});

/** 任务 → 列键（按当前模式） */
function getColumnKey(task: Task): string {
  if (kanbanStore.mode === "priority") return String(task.priority ?? 0);
  return task.groupId ?? "__ungrouped__";
}

/** 跨列持久化（按当前模式改对应字段） */
async function onCrossColumn(taskId: string, toKey: string): Promise<void> {
  if (kanbanStore.mode === "priority") {
    await taskStore.updateTask(taskId, { priority: Number(toKey) as Priority });
  } else {
    // 分组模式的"未分组"列键不写回（保持 groupId 为 null 不现实，后端总会兜底默认组；
    // 这里 toKey 是真实 groupId 或 __ungrouped__——后者不持久化，仅视觉归类）
    if (toKey !== "__ungrouped__") {
      await taskStore.updateTask(taskId, { groupId: toKey });
    }
  }
}

/** 列容器 DOM 引用（列键 → HTMLElement，dragover 判断用） */
const columnRefs = computed<Map<string, HTMLElement>>(() => new Map());
function setColumnRef(key: string, el: HTMLElement | null): void {
  if (el) columnRefs.value.set(key, el);
  else columnRefs.value.delete(key);
}

/** 当前所有列键（供 composable 初始化 localColumns + 遍历） */
function columnKeys(): string[] {
  return columnDefs.value.map((c) => c.key);
}

/** 拖拽 composable（参数化列键，两种模式共用） */
const {
  localColumns,
  draggingId,
  syncFromStore,
  onCardDragStart,
  onColumnDragOver,
  onColumnDrop,
  onCardDragEnd,
} = useKanbanDrag(
  () => taskStore.openTasks,
  getColumnKey,
  onCrossColumn,
  columnKeys,
);

/** 模式切换时重新分桶（getColumnKey 变了，composable 的 watch 不会自动触发） */
watch(
  () => kanbanStore.mode,
  () => syncFromStore(),
);

/** 根据 id 取任务对象 */
const taskMap = computed<Map<string, Task>>(() => {
  return new Map(taskStore.openTasks.map((t) => [t.id, t]));
});

/** 获取某列的任务列表（按 localColumns 顺序） */
function getColumnTasks(key: string): Task[] {
  return (localColumns.value[key] ?? [])
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
        v-for="col in columnDefs"
        :key="col.key"
        :ref="(el) => setColumnRef(col.key, el as HTMLElement)"
        class="kanban__column"
        @dragover="onDragOver"
        @drop="onColumnDrop"
      >
        <!-- 列头：优先级模式用 PriorityDot，分组模式用普通色点 -->
        <div class="kanban__column-header">
          <PriorityDot
            v-if="kanbanStore.mode === 'priority'"
            :priority="Number(col.key) as Priority"
            :size="10"
          />
          <span v-else class="kanban__column-dot" :style="{ backgroundColor: col.color }"></span>
          <span class="kanban__column-title">{{ col.label }}</span>
          <span class="kanban__column-count">{{ getColumnTasks(col.key).length }}</span>
        </div>

        <!-- 卡片列表 -->
        <TransitionGroup name="kanban-flip" tag="div" class="kanban__cards">
          <div
            v-for="task in getColumnTasks(col.key)"
            :key="task.id"
            :data-card-id="task.id"
            class="kanban__card"
            :class="{
              'kanban__card--dragging': draggingId === task.id,
              'kanban__card--selected': taskStore.selectedTaskId === task.id,
            }"
            draggable="true"
            @dragstart="onCardDragStart(task.id, col.key)"
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
        <div v-if="getColumnTasks(col.key).length === 0" class="kanban__column-empty">
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
  box-sizing: border-box;
  /* 避开 AppLayout 的 topbar（absolute top:40px + 高度 24px + 间距） */
  padding-top: 72px;
}

/* 列容器：水平排列 + 横向滚动 */
.kanban__board {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 16px 16px;
}

/* 单列 */
.kanban__column {
  flex: 1;
  min-width: 240px;
  max-width: 320px;
  min-height: 0;
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
/* 分组模式列头色点（替代优先级模式的 PriorityDot） */
.kanban__column-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
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
/* 选中态：主色边框 + 强调软背景（与 TaskListItem 选中态对齐，
 * 用 !important 压过 hover 的边框/阴影，否则选中卡片 hover 时会被覆盖） */
.kanban__card--selected {
  border-color: var(--jt-primary) !important;
  background-color: var(--jt-accent-soft) !important;
  box-shadow: 0 0 0 1px var(--jt-primary) !important;
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
