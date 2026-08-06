<script setup lang="ts">
// 看板视图 —— 作为清单的视图（由 ListView 按 ?view=kanban 条件渲染）
// 支持两种分列维度：按优先级（无/低/中/高）或按分组（Group）
// 只显示当前清单的任务，拖拽跨列改对应字段（priority / groupId）+ 列内排序
import { computed, reactive, ref, watch } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useGroupStore } from "@/stores/group";
import { useKanbanStore } from "@/stores/kanban";
import { type Task, type Priority } from "@/types";
import { formatDueDate } from "@/utils/date";
import PriorityDot from "@/components/PriorityDot.vue";
import TaskCheckbox from "@/components/TaskCheckbox.vue";
import { useKanbanDrag, type KanbanColumnDef } from "@/composables/useKanbanDrag";
import type { SmartViewId } from "@/api/db";
import { useBatchSelect } from "@/composables/useBatchSelect";
import ContextMenu from "@/components/ContextMenu.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";

/**
 * 看板视图既可挂在清单下（scope="list:{id}"，支持优先级/分组两种维度），
 * 也可挂在智能视图下（scope="smart:{viewId}"，跨清单强制优先级维度——
 * 分组是清单内概念，跨清单 groupId 冲突无意义）。
 */
const props = defineProps<{
  scope: string;
  smartView?: SmartViewId;
  defaultListId?: string;
}>();

const taskStore = useTaskStore();
const listStore = useListStore();
const groupStore = useGroupStore();
const kanbanStore = useKanbanStore();

/** 是否处于跨清单模式（智能视图 smartView 传入 / 标签 scope="tag:xxx"）
 *  跨清单时强制 priority 维度，不按 listId 过滤 */
const isSmart = computed(
  () => props.smartView !== undefined || props.scope.startsWith("tag:"),
);
/** 实际生效的看板维度：智能视图强制 priority，清单模式取 store 选择 */
const effectiveMode = computed<"priority" | "group">(() =>
  isSmart.value ? "priority" : kanbanStore.mode,
);
/** 从 scope 解析清单 id（仅清单模式有效；右键新建任务归属用） */
const listId = computed(() => {
  if (isSmart.value) return null;
  return props.scope.startsWith("list:") ? props.scope.slice(5) : props.scope;
});

// 数据由父级（ListView/SmartView）加载到 store，看板复用同一 store 数据。
// 清单模式兜底：清单切换时确保分组刷新（任务由父级 watch 触发）。
// 智能视图模式不加载分组（强制 priority 维度）。
watch(
  () => props.scope,
  async (newScope) => {
    if (isSmart.value) return;
    const id = newScope.startsWith("list:") ? newScope.slice(5) : newScope;
    await groupStore.loadGroups(id);
  },
  { immediate: true },
);

// 预加载子任务缓存：任务列表变化后批量拉取各根任务的子任务到 subtaskCache，
// 供卡片展示「子任务进度 + 展开明细」。父级 ListView/SmartView 已加载 currentTasks。
watch(
  () => taskStore.openTasks,
  () => { void taskStore.preloadSubtaskCounts(); },
  { immediate: true },
);

// ─── 子任务展开状态（父卡片 id 集合） ───
const expandedCardIds = ref<Set<string>>(new Set());
/** 切换某父卡片的子任务展开/收起 */
function toggleCardExpand(taskId: string): void {
  const next = new Set(expandedCardIds.value);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  expandedCardIds.value = next;
}
/** 某任务的子任务（从 store 缓存读，未加载返回空） */
function subtasksOf(taskId: string): Task[] {
  return taskStore.getCachedSubtasks(taskId);
}
/** 子任务完成进度文本「已完成/总数」 */
function subtaskProgressText(taskId: string): string {
  const subs = subtasksOf(taskId);
  const done = subs.filter((t) => t.done).length;
  return `${done}/${subs.length}`;
}
/** 子任务完成百分比（0–100，用于进度条填充宽度） */
function subtaskProgressPercent(taskId: string): number {
  const subs = subtasksOf(taskId);
  if (subs.length === 0) return 0;
  return Math.round((subs.filter((t) => t.done).length / subs.length) * 100);
}
/** 某任务是否有子任务（决定是否显示子任务区） */
function hasSubtasks(taskId: string): boolean {
  return taskId in taskStore.subtaskCache && subtasksOf(taskId).length > 0;
}

/** 优先级模式的固定列定义 */
const PRIORITY_COLUMNS: { priority: Priority; label: string; color: string }[] = [
  { priority: 0, label: "无优先级", color: "var(--jt-text-tertiary)" },
  { priority: 1, label: "低", color: "#3B82F6" },
  { priority: 2, label: "中", color: "var(--jt-warning)" },
  { priority: 3, label: "高", color: "var(--jt-error)" },
];

/** 当前模式的列定义（computed：优先级模式固定 4 列；分组模式从任务的去重 groupId 生成）。
 *  智能视图模式强制 priority（effectiveMode 已处理）。 */
const columnDefs = computed<KanbanColumnDef[]>(() => {
  if (effectiveMode.value === "priority") {
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

/** 任务 → 列键（按当前生效模式） */
function getColumnKey(task: Task): string {
  if (effectiveMode.value === "priority") return String(task.priority ?? 0);
  return task.groupId ?? "__ungrouped__";
}

/** 跨列持久化（按当前生效模式改对应字段） */
async function onCrossColumn(taskId: string, toKey: string): Promise<void> {
  if (effectiveMode.value === "priority") {
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

/** 生效模式切换时重新分桶（getColumnKey 变了，composable 的 watch 不会自动触发） */
watch(
  () => effectiveMode.value,
  () => syncFromStore(),
);

/** scope 变化（如 list→tag 跨路由复用本组件）时强制重新分桶，
 *  避免上一个视图的 localColumns 残留导致显示多余卡片 */
watch(
  () => props.scope,
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

/** 点击卡片：修饰键或多选模式 → 多选增减；普通点击 → 打开详情。
 *  统一转发给 onTaskRowSelect（内部按修饰键/批量模式分流） */
function onCardClick(taskId: string, e: MouseEvent): void {
  onTaskRowSelect(taskId, e);
}

/** 复选框切换完成 */
function onToggle(task: Task): void {
  taskStore.toggleTask(task.id, !task.done);
}

// ─── 右键菜单（参照 TimelineView 的菜单项：多选/新建/删除） ───
const { batchCtxMenu, onTaskRowSelect, onBatchContextMenu } = useBatchSelect();

const ctxMenu = reactive<{ visible: boolean; x: number; y: number; taskId: string }>({
  visible: false,
  x: 0,
  y: 0,
  taskId: "",
});

/** 卡片右键：多选模式下走批量菜单，否则弹单任务菜单 */
function onCardContextMenu(e: MouseEvent, task: Task): void {
  // 多选模式：右键的任务若未选中则先加入选中集合，关单任务菜单，让事件冒泡弹批量菜单
  if (taskStore.batchMode) {
    if (!taskStore.isBatchSelected(task.id)) {
      taskStore.toggleBatchSelect(task.id);
    }
    ctxMenu.visible = false;
    blankMenu.visible = false;
    return; // 不 stop，冒泡到 .kanban 的 onRootContextMenu 弹批量菜单
  }
  e.preventDefault();
  e.stopPropagation();
  ctxMenu.taskId = task.id;
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.visible = true;
  blankMenu.visible = false;
}

/** 空白区右键菜单状态（非多选模式下右键空白处弹「新建任务」） */
const blankMenu = reactive<{ visible: boolean; x: number; y: number; listId: string; priority: Priority }>({
  visible: false,
  x: 0,
  y: 0,
  listId: "",
  priority: 0,
});

/** 根容器右键分流（卡片外的空白区）：
 *  - 多选模式 → 弹批量菜单
 *  - 非多选 → 弹「新建任务」空白菜单（归属当前清单/默认清单） */
function onRootContextMenu(e: MouseEvent): void {
  // 多选模式下右键空白：弹批量菜单
  if (taskStore.batchMode && taskStore.batchSelectedIdsArr.length > 0) {
    onBatchContextMenu(e);
    return;
  }
  // 卡片右键已 stopPropagation，到这里说明是空白区
  e.preventDefault();
  blankMenu.x = e.clientX;
  blankMenu.y = e.clientY;
  // 清单模式用当前清单；智能视图用默认清单
  blankMenu.listId = isSmart.value ? (props.defaultListId ?? "inbox") : (listId.value ?? "inbox");
  blankMenu.priority = 0;
  blankMenu.visible = true;
  ctxMenu.visible = false;
}

/** 空白区右键的新建任务（空标题 + 选中打开详情） */
async function onBlankAddTask(): Promise<void> {
  const listId = blankMenu.listId || "inbox";
  blankMenu.visible = false;
  const created = await taskStore.createTask({
    title: "",
    listId,
    priority: blankMenu.priority,
  });
  taskStore.selectTask(created.id);
}

/** 新建任务（与所点任务同清单同列，空标题 + 选中打开详情）。
 *  智能视图模式下：归属所点任务的清单（若可取），否则默认清单；不继承 groupId */
async function onCtxAddTask(): Promise<void> {
  const task = taskMap.value.get(ctxMenu.taskId);
  ctxMenu.visible = false;
  // 清单模式归属当前清单；智能视图模式归属所点任务清单或默认清单
  const targetListId = isSmart.value
    ? (task?.listId ?? props.defaultListId ?? "inbox")
    : (listId.value ?? "inbox");
  const created = await taskStore.createTask({
    title: "",
    listId: targetListId,
    groupId: isSmart.value ? undefined : (task?.groupId ?? undefined),
    priority: effectiveMode.value === "priority" ? (task?.priority ?? 0) : undefined,
  });
  taskStore.selectTask(created.id);
}

/** 删除任务（走 store 的删除确认弹窗） */
function onCtxDelete(): void {
  const id = ctxMenu.taskId;
  ctxMenu.visible = false;
  taskStore.requestDelete(id);
}

/** 进入多选模式（选中当前任务） */
function onCtxBatchSelect(): void {
  ctxMenu.visible = false;
  taskStore.toggleBatchSelect(ctxMenu.taskId);
}

/** 列 dragover */
function onDragOver(e: DragEvent): void {
  onColumnDragOver(e, columnRefs.value);
}
</script>

<template>
  <!-- 根容器绑 contextmenu：空白区右键弹新建菜单；多选模式下右键弹批量菜单 -->
  <div class="kanban" @contextmenu="onRootContextMenu($event)">
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
            v-if="effectiveMode === 'priority'"
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
              'kanban__card--batch-selected': taskStore.batchMode && taskStore.isBatchSelected(task.id),
            }"
            draggable="true"
            @dragstart="onCardDragStart(task.id, col.key)"
            @dragend="onCardDragEnd"
            @click="onCardClick(task.id, $event)"
            @contextmenu="onCardContextMenu($event, task)"
          >
            <!-- 完成复选框（多选模式下隐藏，由批量勾选框取代） -->
            <TaskCheckbox
              v-if="!taskStore.batchMode"
              :done="task.done"
              :priority="task.priority"
              size="small"
              @click.stop
              @toggle="onToggle(task)"
            />
            <!-- 批量多选勾选框（仅 batchMode 下显示，圆形区别于方形完成框） -->
            <span
              v-if="taskStore.batchMode"
              class="kanban__batch-check"
              :class="{ 'kanban__batch-check--on': taskStore.isBatchSelected(task.id) }"
              @click.stop="onTaskRowSelect(task.id, $event)"
            >
              <icon-check v-if="taskStore.isBatchSelected(task.id)" :size="11" style="color: #fff" />
            </span>
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
            <!-- 子任务区（仅有子任务时显示）：收起态显示进度，展开态列出明细可勾选 -->
            <div v-if="hasSubtasks(task.id)" class="kanban__subtasks">
              <button
                class="kanban__subtasks-header"
                @click.stop="toggleCardExpand(task.id)"
              >
                <icon-right
                  class="kanban__subtasks-arrow"
                  :class="{ 'kanban__subtasks-arrow--open': expandedCardIds.has(task.id) }"
                  :size="12"
                />
                <span class="kanban__subtasks-count">子任务 {{ subtaskProgressText(task.id) }}</span>
                <span class="kanban__subtasks-bar">
                  <span
                    class="kanban__subtasks-bar-fill"
                    :style="{ width: subtaskProgressPercent(task.id) + '%' }"
                  ></span>
                </span>
              </button>
              <!-- 展开的子任务明细 -->
              <div v-if="expandedCardIds.has(task.id)" class="kanban__subtasks-list">
                <div
                  v-for="sub in subtasksOf(task.id)"
                  :key="sub.id"
                  class="kanban__subtask"
                  :class="{ 'kanban__subtask--done': sub.done }"
                  @click.stop="onCardClick(sub.id, $event)"
                >
                  <span
                    class="kanban__subtask-check"
                    :class="{ 'kanban__subtask-check--done': sub.done }"
                    @click.stop="onToggle(sub)"
                  ></span>
                  <span class="kanban__subtask-title">{{ sub.title || '(未命名)' }}</span>
                </div>
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

    <!-- 右键菜单（参照时间线菜单：多选/新建/删除） -->
    <ContextMenu v-model:visible="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y">
      <MenuPopoverItem @click="onCtxBatchSelect">
        <icon-check-circle :size="15" />
        <span>多选</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="onCtxAddTask">
        <icon-plus :size="15" />
        <span>新建任务</span>
      </MenuPopoverItem>
      <MenuPopoverItem danger @click="onCtxDelete">
        <icon-delete :size="15" />
        <span>删除任务</span>
      </MenuPopoverItem>
    </ContextMenu>

    <!-- 空白区右键菜单（新建任务） -->
    <ContextMenu v-model:visible="blankMenu.visible" :x="blankMenu.x" :y="blankMenu.y">
      <MenuPopoverItem @click="onBlankAddTask">
        <icon-plus :size="15" />
        <span>新建任务</span>
      </MenuPopoverItem>
    </ContextMenu>

    <!-- 批量操作菜单（多选模式下右键选中任务时弹出） -->
    <BatchContextMenu
      v-model:visible="batchCtxMenu.visible"
      :x="batchCtxMenu.x"
      :y="batchCtxMenu.y"
    />
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
  flex-wrap: wrap; /* 允许子任务区换行到底部 */
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  background: var(--jt-surface);
  border-radius: 8px;
  border: 1px solid var(--jt-border);
  cursor: grab;
  transition: box-shadow 0.12s, border-color 0.12s;
}
/* 批量多选勾选框（仅 batchMode 下显示，圆形区别于方形完成框，与时间线一致） */
.kanban__batch-check {
  width: 16px; height: 16px;
  border: 2px solid var(--jt-text-tertiary);
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
}
.kanban__batch-check--on {
  background: var(--jt-primary);
  border-color: var(--jt-primary);
}
.kanban__card:hover {
  border-color: var(--jt-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

/* === 子任务区（父卡片底部，Trello 风格进度+展开明细）=== */
.kanban__subtasks {
  width: 100%; /* flex-wrap 下占满整行，换到卡片底部 */
  margin-top: 4px;
}
.kanban__subtasks-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  padding: 2px 0;
  cursor: pointer;
  color: var(--jt-text-tertiary);
  font-size: 11px;
}
.kanban__subtasks-arrow {
  transition: transform 0.15s ease;
  flex-shrink: 0;
}
.kanban__subtasks-arrow--open {
  transform: rotate(90deg);
}
.kanban__subtasks-count {
  flex-shrink: 0;
  font-weight: 500;
}
/* 进度条：细轨道 + 主色填充 */
.kanban__subtasks-bar {
  flex: 1;
  height: 4px;
  background: var(--jt-border);
  border-radius: 2px;
  overflow: hidden;
}
.kanban__subtasks-bar-fill {
  display: block;
  height: 100%;
  background: var(--jt-primary);
  border-radius: 2px;
  transition: width 0.2s ease;
}
/* 展开的子任务明细列表 */
.kanban__subtasks-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kanban__subtask {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.kanban__subtask:hover {
  background: var(--jt-surface-hover);
}
/* 子任务复选框：小方形，与 TaskCheckbox 区分（更小） */
.kanban__subtask-check {
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--jt-text-tertiary);
  border-radius: 3px;
  flex-shrink: 0;
  position: relative;
  transition: background 0.12s, border-color 0.12s;
}
.kanban__subtask-check--done {
  background: var(--jt-primary);
  border-color: var(--jt-primary);
}
.kanban__subtask-check--done::after {
  content: '✓';
  color: #fff;
  font-size: 9px;
  line-height: 1;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
.kanban__subtask-title {
  font-size: 11px;
  color: var(--jt-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kanban__subtask--done .kanban__subtask-title {
  color: var(--jt-text-tertiary);
  text-decoration: line-through;
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
/* 多选模式下批量选中的卡片高亮（与单选态区分，用主色左条带） */
.kanban__card--batch-selected {
  border-color: var(--jt-primary) !important;
  background-color: var(--jt-accent-soft) !important;
  box-shadow: inset 3px 0 0 var(--jt-primary) !important;
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
