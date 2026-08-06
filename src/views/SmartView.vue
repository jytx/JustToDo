<script setup lang="ts">
// 智能视图 —— 今天 / 未来 7 天 / 全部
// 跨清单聚合视图，任务项额外显示清单归属色点。
// 支持列表/看板/时间线三种视图切换（与清单视图一致，偏好按 "smart:{viewId}" 独立持久化）
import { computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { formatPageDate } from "@/utils/date";
import { useTaskPanelContextMenu } from "@/composables/useTaskPanelContextMenu";
import { useTaskDragReorder } from "@/composables/useTaskDragReorder";
import { useBatchSelect } from "@/composables/useBatchSelect";
import type { SmartViewId } from "@/api/db";
import { getViewPref, type ListView } from "@/composables/useViewPrefs";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";
import KanbanView from "@/views/KanbanView.vue";
import TimelineView from "@/views/TimelineView.vue";

const props = defineProps<{ view: SmartViewId }>();

const route = useRoute();
const router = useRouter();
const listStore = useListStore();
const taskStore = useTaskStore();

/** 当前视图形态（读 query ?view=：list 默认 / kanban 看板 / timeline 时间线） */
const currentView = computed<ListView>(() => {
  const v = route.query.view;
  if (v === "kanban") return "kanban";
  if (v === "timeline") return "timeline";
  return "list";
});

/** 偏好作用域（智能视图专用 namespace，与清单偏好隔离） */
const scope = computed(() => "smart:" + props.view);

/** 从偏好恢复视图：query 无 view 时按上次选择补上（与清单视图一致）。
 *  智能视图（today/upcoming/all）复用同一组件，切视图时组件不重挂载，
 *  必须在 watch(props.view) 里同步恢复。 */
function restoreViewPref(): void {
  const pref = getViewPref(scope.value);
  // 仅在 query 没有 view 时补上（用户显式带了 view 则尊重，如点链接进来）
  if (!route.query.view) {
    router.replace({ query: { ...route.query, view: pref.view } });
  }
}

const VIEW_TITLES: Record<SmartViewId, string> = {
  today: "今天",
  upcoming: "未来 7 天",
  all: "全部",
};

const VIEW_EMPTY: Record<SmartViewId, string> = {
  today: "今天没有任务了",
  upcoming: "未来 7 天没有任务",
  all: "还没有任何任务",
};

const pageTitle = computed(() => VIEW_TITLES[props.view]);
const openCount = computed(() => taskStore.openTasks.length);
const dbError = computed(() => listStore.error);

const listColorMap = computed(() => {
  const map: Record<string, string> = {};
  for (const l of listStore.lists) {
    map[l.id] = l.color;
  }
  return map;
});

/** 智能视图下新建任务的默认清单（收件箱或第一个未归档清单） */
const defaultListId = computed(() => {
  const inbox = listStore.lists.find((l) => l.id === "inbox");
  return inbox?.id ?? listStore.activeLists[0]?.id ?? "inbox";
});

// 面板右键菜单：新建任务归属默认清单
const { ctxMenu, onContextMenu, onCreateTask } = useTaskPanelContextMenu(
  () => defaultListId.value,
);

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

async function onAddTask(payload: { title: string; priority: import("@/types").Priority; dueStartAt: string | null; dueEndAt: string | null; tagIds: string[]; note?: string }) {
  const task = await taskStore.createTask({
    title: payload.title,
    listId: defaultListId.value,
    priority: payload.priority,
    dueStartAt: payload.dueStartAt,
    dueEndAt: payload.dueEndAt,
    tagIds: payload.tagIds,
  });
  if (payload.note) {
    await taskStore.updateTask(task.id, { note: payload.note });
  }
}

watch(
  () => props.view,
  async (newView) => {
    restoreViewPref();
    await taskStore.loadSmartView(newView);
  },
);

onMounted(async () => {
  restoreViewPref();
  await listStore.loadLists();
  await taskStore.loadSmartView(props.view);
});
</script>

<template>
  <!-- 看板视图（query ?view=kanban）：跨清单强制优先级维度，复用 loadSmartView 的数据 -->
  <KanbanView v-if="currentView === 'kanban'" :scope="scope" :smart-view="props.view" :default-list-id="defaultListId" />
  <!-- 时间线视图（query ?view=timeline）：跨清单，双击建任务进默认收件箱 -->
  <TimelineView v-else-if="currentView === 'timeline'" :scope="scope" :smart-view="props.view" :default-list-id="defaultListId" />
  <!-- 列表视图（默认） -->
  <div v-else class="smart-view" @contextmenu="onRootContextMenu">
    <!-- 列表头 -->
    <header class="smart-view__header">
      <h1 class="smart-view__title">{{ pageTitle }}</h1>
      <p class="smart-view__subtitle">
        {{ formatPageDate() }}
        <template v-if="openCount"> · {{ openCount }} 个待办</template>
      </p>
    </header>

    <!-- 顶部添加栏 -->
    <div class="smart-view__add-bar">
      <AddTaskBar
        :list-id="defaultListId"
        @add="onAddTask"
      />
    </div>

    <div class="mb-2" />

    <!-- 数据库错误提示（用于诊断） -->
    <div v-if="dbError" class="smart-view__error">
      ⚠️ 数据库错误：{{ dbError }}
    </div>

    <!-- 未完成任务与完成区共用折叠面板和滚动容器 -->
    <div v-if="taskStore.currentTasks.length > 0" class="smart-view__content">
      <a-collapse
        :bordered="false"
        :default-active-key="['open']"
        class="smart-view__collapse"
      >
        <a-collapse-item
          v-if="taskStore.openTasks.length > 0"
          key="open"
          :header="`未完成 · ${taskStore.openTasks.length}`"
          class="smart-view__collapse-header"
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
                show-list-dot
                :list-color="listColorMap[task.listId] || '#6B7280'"
                :batch-mode="taskStore.batchMode"
                :batch-selected="taskStore.isBatchSelected(task.id)"
                @toggle="taskStore.toggleTask(task.id, !task.done)"
                @select="(e) => onTaskRowSelect(task.id, e)"
                @delete="taskStore.deleteTask(task.id)"
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
          class="smart-view__collapse-header"
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
      class="smart-view__empty"
    >
      <span class="smart-view__empty-icon">✨</span>
      <p class="smart-view__empty-title">{{ VIEW_EMPTY[view] }}</p>
      <p class="smart-view__empty-hint">在上方添加新任务</p>
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
.smart-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.smart-view__header {
  padding: 24px 24px 12px;
}

.smart-view__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--jt-text-primary);
  margin: 0;
  line-height: 1.3;
}

.smart-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
  font-weight: 400;
  letter-spacing: 0;
}

.smart-view__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.smart-view__error {
  margin: 12px 24px;
  padding: 12px 16px;
  background-color: rgba(220, 38, 38, 0.1);
  color: var(--jt-error);
  border-radius: 8px;
  font-size: 13px;
  font-family: var(--font-mono);
  word-break: break-all;
}

.smart-view__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.smart-view__list-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 15px;
  margin-left: 4px;
}

.smart-view__item :deep(.task-item) {
  flex: 1;
}

.smart-view__collapse {
  margin: 8px 12px;
}

/* 去掉 Arco Collapse 内容区默认左侧缩进，任务行自带内边距 */
.smart-view__collapse :deep(.arco-collapse-item-content) {
  padding-left: 0;
}

/* === TransitionGroup FLIP 动画（拖拽实时让位）===
   关键：.task-flip-move 让位置变化的元素平滑过渡（"挤走"效果）。 */
.task-flip-move {
  transition: transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}

.smart-view__collapse-header {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-secondary);
  min-height: 40px;
}

.smart-view__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}

.smart-view__empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.smart-view__empty-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--jt-text-primary);
  margin: 0 0 4px;
}

.smart-view__empty-hint {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  margin: 0;
}

.smart-view__add-bar {
  flex-shrink: 0;
  padding: 0 8px 8px;
}
</style>
