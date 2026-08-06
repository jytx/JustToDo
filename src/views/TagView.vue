<script setup lang="ts">
// 标签视图 —— 显示某个标签下的所有任务
// 支持列表/看板/时间线三种形态（query ?view= 切换），看板/时间线复用 KanbanView/TimelineView
import { computed, watch, onMounted } from "vue";
import { useRoute } from "vue-router";
import { useTaskStore } from "@/stores/task";
import { useTagStore } from "@/stores/tag";
import { formatPageDate } from "@/utils/date";
import { useTaskPanelContextMenu } from "@/composables/useTaskPanelContextMenu";
import { useTaskDragReorder } from "@/composables/useTaskDragReorder";
import { useBatchSelect } from "@/composables/useBatchSelect";
import type { Priority } from "@/types";
import type { ListView } from "@/composables/useViewPrefs";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";
import KanbanView from "@/views/KanbanView.vue";
import TimelineView from "@/views/TimelineView.vue";

const props = defineProps<{ id: string }>();

const route = useRoute();
const taskStore = useTaskStore();
const tagStore = useTagStore();

/** 当前视图形态（query ?view=：list 默认 / kanban 看板 / timeline 时间线） */
const currentView = computed<ListView>(() => {
  const v = route.query.view;
  if (v === "kanban") return "kanban";
  if (v === "timeline") return "timeline";
  return "list";
});

// 面板右键菜单：新建任务归属收件箱（与 AddTaskBar 行为一致）
const { ctxMenu, onContextMenu, onCreateTask } = useTaskPanelContextMenu(() => "inbox");

// 批量多选：修饰键点击转发 + 批量右键菜单状态
const { batchCtxMenu, onTaskRowSelect, onBatchContextMenu } = useBatchSelect();

/** 根容器右键分流：多选模式下优先弹批量菜单，否则弹面板菜单（新建任务） */
function onRootContextMenu(e: MouseEvent): void {
  if (taskStore.batchMode && taskStore.batchSelectedIdsArr.length > 0) {
    onBatchContextMenu(e);
  } else {
    onContextMenu(e);
  }
}

const currentTag = computed(() => tagStore.tags.find((t) => t.id === props.id));
const pageTitle = computed(() => `# ${currentTag.value?.name ?? "标签"}`);
const openCount = computed(() => taskStore.openTasks.length);

// 拖拽实时让位（FLIP 动画）—— 仅未完成区启用
const {
  containerRef: openContainerRef,
  draggingId,
  orderedTasks,
  onTaskDragStart,
  onContainerDragOver,
  onContainerDrop,
  onTaskDragEnd,
} = useTaskDragReorder(() => taskStore.openTasks);

// 添加任务（直接加到收件箱）；用户在添加栏选择的标签随 payload.tagIds 一并关联
async function onAdd(payload: { title: string; priority: Priority; dueStartAt: string | null; dueEndAt: string | null; tagIds: string[]; note?: string }) {
  const task = await taskStore.createTask({
    title: payload.title,
    listId: 'inbox',
    priority: payload.priority,
    dueStartAt: payload.dueStartAt,
    dueEndAt: payload.dueEndAt,
    tagIds: payload.tagIds,
  });
  if (payload.note) {
    await taskStore.updateTask(task.id, { note: payload.note });
  }
}

// 切换标签时重新加载
watch(
  () => props.id,
  async (newId) => {
    await tagStore.loadTags();
    await taskStore.loadTagTasks(newId);
  },
);

onMounted(async () => {
  await tagStore.loadTags();
  await taskStore.loadTagTasks(props.id);
});
</script>

<template>
  <!-- 看板视图（query ?view=kanban） -->
  <KanbanView v-if="currentView === 'kanban'" :scope="'tag:' + props.id" default-list-id="inbox" />
  <!-- 时间线视图（query ?view=timeline） -->
  <TimelineView v-else-if="currentView === 'timeline'" :scope="'tag:' + props.id" default-list-id="inbox" />
  <!-- 列表视图（默认） -->
  <div v-else class="tag-view" @contextmenu="onRootContextMenu">
    <header class="tag-view__header">
      <h1 class="tag-view__title">{{ pageTitle }}</h1>
      <p class="tag-view__subtitle">
        {{ formatPageDate() }} · {{ openCount }} 个待办
      </p>
    </header>

    <!-- 顶部添加栏 -->
    <div class="tag-view__add-bar">
      <AddTaskBar :list-id="'inbox'" @add="onAdd" />
    </div>

    <div class="mb-2" />

    <!-- 未完成任务与完成区共用折叠面板和滚动容器 -->
    <div v-if="taskStore.currentTasks.length > 0" class="tag-view__content">
      <a-collapse
        :bordered="false"
        :default-active-key="['open']"
        class="tag-view__collapse"
      >
        <a-collapse-item
          v-if="taskStore.openTasks.length > 0"
          key="open"
          :header="`未完成 · ${taskStore.openTasks.length}`"
          class="tag-view__collapse-header"
        >
          <!-- 外层 div 挂容器级 dragover/drop（FLIP 实时让位）；
               TransitionGroup 做 FLIP 动画，task-flip-move 让位过渡 -->
          <div
            ref="openContainerRef"
            @dragover="onContainerDragOver"
            @drop="onContainerDrop"
          >
            <TransitionGroup name="task-flip" tag="div">
              <TaskListItem
                v-for="task in orderedTasks"
                :key="task.id"
                :task="task"
                :dragging="draggingId === task.id"
                :batch-mode="taskStore.batchMode"
                :batch-selected="taskStore.isBatchSelected(task.id)"
                @select="(e) => onTaskRowSelect(task.id, e)"
                @dragstart="onTaskDragStart"
                @dragend="onTaskDragEnd"
              />
            </TransitionGroup>
          </div>
        </a-collapse-item>

        <a-collapse-item
          v-if="taskStore.doneTasks.length > 0"
          key="done"
          :header="`已完成 · ${taskStore.doneTasks.length}`"
          class="tag-view__collapse-header"
        >
          <TaskListItem
            v-for="task in taskStore.doneTasks"
            :key="task.id"
            :task="task"
            :batch-mode="taskStore.batchMode"
            :batch-selected="taskStore.isBatchSelected(task.id)"
            @toggle="taskStore.toggleTask(task.id, !task.done)"
            @select="(e) => onTaskRowSelect(task.id, e)"
            @delete="taskStore.deleteTask(task.id)"
          />
        </a-collapse-item>
      </a-collapse>
    </div>

    <!-- 空状态 -->
    <div
      v-if="!taskStore.loading && taskStore.currentTasks.length === 0"
      class="tag-view__empty"
    >
      <span class="tag-view__empty-icon">🏷️</span>
      <p class="tag-view__empty-title">这个标签还没有任务</p>
      <p class="tag-view__empty-hint">在上方添加新任务</p>
    </div>

    <!-- 面板右键菜单：新建任务 -->
    <ContextMenu v-model:visible="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y">
      <MenuPopoverItem @click="onCreateTask">
        <icon-plus :size="15" />
        <span>新建任务</span>
      </MenuPopoverItem>
    </ContextMenu>

    <!-- 批量操作右键菜单：多选模式下右键选中任务时弹出 -->
    <BatchContextMenu
      v-model:visible="batchCtxMenu.visible"
      :x="batchCtxMenu.x"
      :y="batchCtxMenu.y"
    />
  </div>
</template>

<style scoped>
.tag-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.tag-view__header {
  padding: 24px 24px 12px;
}

.tag-view__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--jt-text-primary);
  margin: 0;
  line-height: 1.3;
}

.tag-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
  font-weight: 400;
  letter-spacing: 0;
}

.tag-view__add-bar {
  flex-shrink: 0;
  padding: 0 8px 8px;
}

.tag-view__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.tag-view__collapse {
  margin: 8px 12px;
}

/* 去掉 Arco Collapse 内容区默认左侧缩进，任务行自带内边距 */
.tag-view__collapse :deep(.arco-collapse-item-content) {
  padding-left: 0;
}

/* === TransitionGroup FLIP 动画（拖拽实时让位）===
   关键：.task-flip-move 让位置变化的元素平滑过渡（"挤走"效果）。 */
.task-flip-move {
  transition: transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}

.tag-view__collapse-header {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-secondary);
  min-height: 40px;
}

.tag-view__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}

.tag-view__empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.tag-view__empty-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--jt-text-primary);
  margin: 0 0 4px;
}

.tag-view__empty-hint {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  margin: 0;
}
</style>
