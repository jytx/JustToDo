<script setup lang="ts">
// 标签视图 —— 显示某个标签下的所有任务
import { computed, watch, onMounted } from "vue";
import { useTaskStore } from "@/stores/task";
import { useTagStore } from "@/stores/tag";
import { formatPageDate } from "@/utils/date";
import type { Priority } from "@/types";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";

const props = defineProps<{ id: string }>();

const taskStore = useTaskStore();
const tagStore = useTagStore();

const currentTag = computed(() => tagStore.tags.find((t) => t.id === props.id));
const pageTitle = computed(() => `# ${currentTag.value?.name ?? "标签"}`);
const openCount = computed(() => taskStore.openTasks.length);

// 添加任务到当前标签（直接加到收件箱，未来可扩展为标签关联）
async function onAdd(payload: { title: string; priority: Priority; dueStartAt: string | null; dueEndAt: string | null }) {
  await taskStore.createTask({
    title: payload.title,
    listId: 'inbox',
    priority: payload.priority,
    dueStartAt: payload.dueStartAt,
    dueEndAt: payload.dueEndAt,
  });
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
  <div class="tag-view">
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

    <a-divider class="mb-2" />

    <!-- 未完成任务 -->
    <div class="tag-view__tasks">
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
      class="mt-4 tag-view__done"
    >
      <a-collapse-item
        key="done"
        :header="`已完成 · ${taskStore.doneTasks.length}`"
        class="tag-view__done-header"
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
    <div
      v-if="!taskStore.loading && taskStore.currentTasks.length === 0"
      class="tag-view__empty"
    >
      <span class="tag-view__empty-icon">🏷️</span>
      <p class="tag-view__empty-title">这个标签还没有任务</p>
      <p class="tag-view__empty-hint">在上方添加新任务</p>
    </div>
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
  font-size: 24px;
  font-weight: 600;
  color: var(--jt-text-primary);
  margin: 0;
}

.tag-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
}

.tag-view__add-bar {
  flex-shrink: 0;
  padding: 0 8px 8px;
}

.tag-view__tasks {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
}

.tag-view__done {
  margin: 8px 12px;
}

.tag-view__done-header {
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
  font-size: 18px;
  font-weight: 500;
  color: var(--jt-text-primary);
  margin: 0 0 4px;
}

.tag-view__empty-hint {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  margin: 0;
}
</style>
