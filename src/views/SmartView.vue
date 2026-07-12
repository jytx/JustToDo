<script setup lang="ts">
// 智能视图 —— 今天 / 未来 7 天 / 全部
// 跨清单聚合视图，任务项额外显示清单归属色点
import { computed, watch, onMounted } from "vue";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { formatPageDate } from "@/utils/date";
import type { SmartViewId } from "@/api/db";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";

const props = defineProps<{ view: SmartViewId }>();

const listStore = useListStore();
const taskStore = useTaskStore();

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

/** 智能视图下新建任务的默认清单（收件箱或第一个清单） */
const defaultListId = computed(() => {
  const inbox = listStore.lists.find((l) => l.id === "inbox");
  return inbox?.id ?? listStore.sortedLists[0]?.id ?? "inbox";
});

async function onAddTask(payload: { title: string; priority: import("@/types").Priority; dueStartAt: string | null; dueEndAt: string | null }) {
  await taskStore.createTask({
    title: payload.title,
    listId: defaultListId.value,
    priority: payload.priority,
    dueStartAt: payload.dueStartAt,
    dueEndAt: payload.dueEndAt,
  });
}

watch(
  () => props.view,
  async (newView) => {
    await taskStore.loadSmartView(newView);
  },
);

onMounted(async () => {
  await listStore.loadLists();
  await taskStore.loadSmartView(props.view);
});
</script>

<template>
  <div class="smart-view">
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

    <a-divider class="mb-2" />

    <!-- 数据库错误提示（用于诊断） -->
    <div v-if="dbError" class="smart-view__error">
      ⚠️ 数据库错误：{{ dbError }}
    </div>

    <!-- 未完成任务 -->
    <div class="smart-view__tasks">
      <TaskListItem
        v-for="task in taskStore.openTasks"
        :key="task.id"
        :task="task"
        show-list-dot
        :list-color="listColorMap[task.listId] || '#6B7280'"
        @toggle="taskStore.toggleTask(task.id, !task.done)"
        @select="taskStore.selectTask(task.id)"
        @delete="taskStore.deleteTask(task.id)"
      />
    </div>

    <!-- 完成区（折叠）—— 所有智能视图都显示 -->
    <a-collapse
      v-if="taskStore.doneTasks.length"
      :bordered="false"
      class="smart-view__done"
    >
      <a-collapse-item
        key="done"
        :header="`已完成 · ${taskStore.doneTasks.length}`"
        class="smart-view__done-header"
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
      class="smart-view__empty"
    >
      <span class="smart-view__empty-icon">✨</span>
      <p class="smart-view__empty-title">{{ VIEW_EMPTY[view] }}</p>
      <p class="smart-view__empty-hint">在上方添加新任务</p>
    </div>
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
  font-size: 24px;
  font-weight: 600;
  color: var(--jt-text-primary);
  margin: 0;
}

.smart-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
}

.smart-view__tasks {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
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

.smart-view__done {
  margin: 8px 12px;
}

.smart-view__done-header {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-secondary);
  min-height: 40px;
}

.smart-view__empty {
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
  font-size: 18px;
  font-weight: 500;
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
