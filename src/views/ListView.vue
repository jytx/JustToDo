<script setup lang="ts">
// 清单视图 —— 任务列表区主视图
// 含：列表头（标题/日期/计数）、未完成任务列表、完成区折叠、添加栏、空状态
import { computed, watch, onMounted } from "vue";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { formatPageDate } from "@/utils/date";
import { useTaskPanelContextMenu } from "@/composables/useTaskPanelContextMenu";
import { useTaskDragReorder } from "@/composables/useTaskDragReorder";
import { useBatchSelect } from "@/composables/useBatchSelect";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";

const props = defineProps<{ id: string }>();

const listStore = useListStore();
const taskStore = useTaskStore();

// 面板右键菜单：新建任务归属当前清单
const { ctxMenu, onContextMenu, onCreateTask } = useTaskPanelContextMenu(() => props.id);

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

const currentList = computed(() => listStore.getById(props.id));

const pageTitle = computed(() => currentList.value?.name ?? "清单");
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

// 切换清单时重新加载任务
watch(
  () => props.id,
  async (newId) => {
    await taskStore.loadTasks(newId);
  },
);

onMounted(async () => {
  await listStore.loadLists();
  await taskStore.loadTasks(props.id);
});
</script>

<template>
  <div class="list-view" @contextmenu="onRootContextMenu">
    <!-- 列表头 -->
    <header class="list-view__header">
      <h1 class="list-view__title">
        {{ pageTitle }}
        <!-- 已归档清单/目录：低饱和度胶囊角标 -->
        <span v-if="currentList?.archived" class="list-view__archived-tag">已归档</span>
      </h1>
      <p class="list-view__subtitle">
        {{ formatPageDate() }} · {{ openCount }} 个待办
      </p>
    </header>

    <!-- 顶部添加栏：归档清单下隐藏（产品策略：归档区不可新建任务） -->
    <div v-if="!currentList?.archived" class="list-view__add-bar">
      <AddTaskBar
        :list-id="props.id"
        @add="
          (payload) =>
            taskStore.createTask({
              title: payload.title,
              listId: props.id,
              priority: payload.priority,
              dueStartAt: payload.dueStartAt,
              dueEndAt: payload.dueEndAt,
              tagIds: payload.tagIds,
            })
        "
      />
    </div>

    <div class="mb-2" />

    <!-- 未完成任务与完成区共用折叠面板和滚动容器 -->
    <div v-if="taskStore.currentTasks.length > 0" class="list-view__content">
      <a-collapse
        :bordered="false"
        :default-active-key="['open']"
        class="list-view__collapse"
      >
        <a-collapse-item
          v-if="taskStore.openTasks.length > 0"
          key="open"
          :header="`未完成 · ${taskStore.openTasks.length}`"
          class="list-view__collapse-header"
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
          class="list-view__collapse-header"
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
    <div v-if="!taskStore.loading && taskStore.currentTasks.length === 0" class="list-view__empty">
      <span class="list-view__empty-icon">✨</span>
      <p class="list-view__empty-title">这个清单还没有任务</p>
      <p class="list-view__empty-hint">在上方添加你的第一个任务</p>
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
.list-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.list-view__header {
  padding: 24px 24px 12px;
}

.list-view__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--jt-text-primary);
  margin: 0;
  line-height: 1.3;
}

.list-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
  font-weight: 400;
  letter-spacing: 0;
}

.list-view__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.list-view__collapse {
  margin: 8px 12px;
}

/* 去掉 Arco Collapse 内容区默认左侧缩进，任务行自带内边距 */
.list-view__collapse :deep(.arco-collapse-item-content) {
  padding-left: 0;
}

/* === TransitionGroup FLIP 动画（拖拽实时让位）===
   关键：.task-flip-move 让位置变化的元素平滑过渡（"挤走"效果）。 */
.task-flip-move {
  transition: transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}

.list-view__collapse-header {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-secondary);
  min-height: 40px;
}

.list-view__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}

.list-view__empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.list-view__empty-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--jt-text-primary);
  margin: 0 0 4px;
}

.list-view__empty-hint {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  margin: 0;
}

.list-view__add-bar {
  flex-shrink: 0;
  padding: 0 8px 8px;
}

/* 已归档角标：低饱和度灰底胶囊，置于标题右侧 */
.list-view__archived-tag {
  display: inline-block;
  margin-left: 10px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.2px;
  color: var(--jt-text-secondary);
  background-color: var(--jt-surface-hover);
  border-radius: 10px;
  vertical-align: middle;
  font-family: var(--font-body);
}
</style>
