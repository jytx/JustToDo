<script setup lang="ts">
// 笔记本视图 —— 笔记列表区主视图
// 与 ListView 结构对称，差异：副标题文案、无「已完成」折叠区、添加栏走笔记模式（无日期）。
// 笔记复用 tasks 表（kind='note'）：无起止时间/完成/重复/提醒，但支持富文本、标签、子笔记、附件、拖拽排序。
import { computed, watch, onMounted } from "vue";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { formatPageDate } from "@/utils/date";
import { useTaskPanelContextMenu } from "@/composables/useTaskPanelContextMenu";
import { useTaskDragReorder } from "@/composables/useTaskDragReorder";
import { useBatchSelect } from "@/composables/useBatchSelect";
import { useNoteImport } from "@/composables/useNoteImport";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";

const props = defineProps<{ id: string }>();

const listStore = useListStore();
const taskStore = useTaskStore();

// 面板右键菜单：新建笔记归属当前笔记本
const { ctxMenu, onContextMenu, onCreateTask } = useTaskPanelContextMenu(
  () => props.id,
  "note",
);

// 批量多选：修饰键点击转发 + 批量右键菜单状态（与 ListView 一致）
const { batchCtxMenu, onTaskRowSelect, onBatchContextMenu } = useBatchSelect();

/** 根容器右键分流：多选模式下优先弹批量菜单，否则弹面板菜单（新建笔记） */
function onRootContextMenu(e: MouseEvent): void {
  if (taskStore.batchMode && taskStore.batchSelectedIdsArr.length > 0) {
    onBatchContextMenu(e);
  } else {
    onContextMenu(e);
  }
}

const currentList = computed(() => listStore.getById(props.id));

const pageTitle = computed(() => currentList.value?.name ?? "笔记本");
const noteCount = computed(() => taskStore.currentTasks.length);

// 拖拽实时让位（FLIP 动画）—— 笔记无 done 概念，全部条目可拖拽
const {
  containerRef: openContainerRef,
  draggingId,
  orderedTasks,
  onTaskDragStart,
  onContainerDragOver,
  onContainerDrop,
  onTaskDragEnd,
} = useTaskDragReorder(() => taskStore.currentTasks);

// 切换笔记本时重新加载笔记
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

/** 添加笔记：创建后如果有 AI 生成的正文(note)，写入 note 字段 */
async function onAdd(payload: { title: string; priority: import("@/types").Priority; dueStartAt: string | null; dueEndAt: string | null; tagIds: string[]; note?: string }) {
  const task = await taskStore.createTask({
    title: payload.title,
    listId: props.id,
    priority: payload.priority,
    kind: "note",
    tagIds: payload.tagIds,
  });
  if (payload.note) {
    await taskStore.updateTask(task.id, { note: payload.note });
  }
}

// 导入笔记（面板右键菜单入口；默认笔记本无侧边栏菜单，此入口是其唯一导入途径）
const { pickAndImport } = useNoteImport();
function onImportNotes(): void {
  ctxMenu.visible = false;
  void pickAndImport(props.id);
}
</script>

<template>
  <div class="note-view" @contextmenu="onRootContextMenu">
    <!-- 列表头 -->
    <header class="note-view__header">
      <h1 class="note-view__title">
        {{ pageTitle }}
        <span v-if="currentList?.archived" class="note-view__archived-tag">已归档</span>
      </h1>
      <p class="note-view__subtitle">
        {{ formatPageDate() }} · {{ noteCount }} 个笔记
      </p>
    </header>

    <!-- 顶部添加栏：归档笔记本下隐藏（与清单视图策略一致） -->
    <div v-if="!currentList?.archived" class="note-view__add-bar">
      <AddTaskBar
        :list-id="props.id"
        kind="note"
        @add="onAdd"
      />
    </div>

    <div class="mb-2" />

    <!-- 笔记列表（无已完成区，笔记 done 恒 0） -->
    <div v-if="taskStore.currentTasks.length > 0" class="note-view__content">
      <div ref="openContainerRef" @dragover="onContainerDragOver" @drop="onContainerDrop">
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
    </div>

    <!-- 空状态 -->
    <div v-if="!taskStore.loading && taskStore.currentTasks.length === 0" class="note-view__empty">
      <span class="note-view__empty-icon">📝</span>
      <p class="note-view__empty-title">这个笔记本还没有笔记</p>
      <p class="note-view__empty-hint">在上方记录你的第一条笔记</p>
    </div>

    <!-- 面板右键菜单：新建笔记 / 导入笔记 -->
    <ContextMenu v-model:visible="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y">
      <MenuPopoverItem @click="onCreateTask">
        <icon-plus :size="15" />
        <span>新建笔记</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="onImportNotes">
        <icon-import :size="15" />
        <span>导入笔记…</span>
      </MenuPopoverItem>
    </ContextMenu>

    <!-- 批量操作右键菜单：多选模式下右键选中笔记时弹出（kind=note：隐藏任务专属项） -->
    <BatchContextMenu
      v-model:visible="batchCtxMenu.visible"
      :x="batchCtxMenu.x"
      :y="batchCtxMenu.y"
      kind="note"
    />
  </div>
</template>

<style scoped>
.note-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.note-view__header {
  padding: 24px 24px 12px;
}

.note-view__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--jt-text-primary);
  margin: 0;
  line-height: 1.3;
}

.note-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
  font-weight: 400;
  letter-spacing: 0;
}

.note-view__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px;
}

/* TransitionGroup FLIP 动画（拖拽实时让位），与 ListView 一致 */
.task-flip-move {
  transition: transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}

.note-view__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}

.note-view__empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.note-view__empty-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--jt-text-primary);
  margin: 0 0 4px;
}

.note-view__empty-hint {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  margin: 0;
}

.note-view__add-bar {
  flex-shrink: 0;
  padding: 0 8px 8px;
}

/* 已归档角标：低饱和度灰底胶囊，与 ListView 一致 */
.note-view__archived-tag {
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
