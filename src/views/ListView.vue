<script setup lang="ts">
// 清单视图 —— 任务列表区主视图
// 含：列表头（标题/日期/计数）、未完成任务列表、完成区折叠、添加栏、空状态
import { computed, watch, onMounted } from "vue";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { formatPageDate } from "@/utils/date";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";

const props = defineProps<{ id: string }>();

const listStore = useListStore();
const taskStore = useTaskStore();

const currentList = computed(() => listStore.getById(props.id));

const pageTitle = computed(() => currentList.value?.name ?? "清单");
const openCount = computed(() => taskStore.openTasks.length);

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
  <div class="list-view">
    <!-- 列表头 -->
    <header class="list-view__header">
      <h1 class="list-view__title">{{ pageTitle }}</h1>
      <p class="list-view__subtitle">
        {{ formatPageDate() }} · {{ openCount }} 个待办
      </p>
    </header>

    <!-- 顶部添加栏 -->
    <div class="list-view__add-bar">
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
            })
        "
      />
    </div>

    <a-divider class="mb-2" />

    <!-- 未完成任务 -->
    <div class="list-view__tasks">
      <TaskListItem
        v-for="task in taskStore.openTasks"
        :key="task.id"
        :task="task"
        @select="taskStore.selectTask(task.id)"
        @reorder="(draggedId: string, targetId: string, pos: 'before' | 'after') => taskStore.reorderTasks(draggedId, targetId, pos)"
      />
    </div>

    <!-- 完成区（折叠） -->
    <a-collapse
      v-if="taskStore.doneTasks.length"
      :bordered="false"
      class="mt-4 list-view__done"
    >
      <a-collapse-item
        key="done"
        :header="`已完成 · ${taskStore.doneTasks.length}`"
        class="list-view__done-header"
      >
        <TaskListItem
          v-for="task in taskStore.doneTasks"
          :key="task.id"
          :task="task"
          @toggle="taskStore.toggleTask(task.id, !task.done)"
          @select="taskStore.selectTask(task.id)"
          @delete="taskStore.deleteTask(task.id)"
        />
      </a-collapse-item>
    </a-collapse>

    <!-- 空状态 -->
    <div v-if="!taskStore.loading && taskStore.currentTasks.length === 0" class="list-view__empty">
      <span class="list-view__empty-icon">✨</span>
      <p class="list-view__empty-title">这个清单还没有任务</p>
      <p class="list-view__empty-hint">在上方添加你的第一个任务</p>
    </div>
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
  font-size: 24px;
  font-weight: 600;
  color: var(--jt-text-primary);
  margin: 0;
}

.list-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
}

.list-view__tasks {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
}

.list-view__done {
  margin: 8px 12px;
}

.list-view__done-header {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-secondary);
  min-height: 40px;
}

.list-view__empty {
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
  font-size: 18px;
  font-weight: 500;
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
</style>
