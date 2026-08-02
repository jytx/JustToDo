<script setup lang="ts">
// 清单视图 —— 任务列表区主视图
// 含：列表头（标题/日期/计数）、按分组展示未完成任务、完成区折叠、添加栏、空状态
import { computed, watch, onMounted, ref } from "vue";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { useGroupStore } from "@/stores/group";
import { formatPageDate } from "@/utils/date";
import { useTaskPanelContextMenu } from "@/composables/useTaskPanelContextMenu";
import { useGroupDrag } from "@/composables/useGroupDrag";
import { useBatchSelect } from "@/composables/useBatchSelect";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import MenuPopover from "@/components/MenuPopover.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";

const props = defineProps<{ id: string }>();

const listStore = useListStore();
const taskStore = useTaskStore();
const groupStore = useGroupStore();

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

// 分组拖拽（跨组改 group_id + 组内排序）
const groupIds = computed(() => groupStore.currentGroups.map((g) => g.id));
const {
  localGroups,
  draggingId,
  syncFromStore,
  onTaskDragStart,
  onGroupDragOver,
  onGroupDrop,
  onTaskDragEnd,
} = useGroupDrag(() => taskStore.openTasks, () => groupIds.value);

/** 分组容器 DOM 引用（groupId → HTMLElement） */
const groupContainerEls = new Map<string, HTMLElement>();
function setGroupContainerRef(groupId: string, el: HTMLElement | null): void {
  if (el) groupContainerEls.set(groupId, el);
  else groupContainerEls.delete(groupId);
}

/** 列级 dragover 适配 */
function onDragOver(e: DragEvent): void {
  onGroupDragOver(e, groupContainerEls);
}

// ─── 分组 ───
/** 展开的分组 key 列表（a-collapse 的 v-model） */
const activeGroupKeys = ref<string[]>([]);

/** 按分组划分的未完成任务（基于 localGroups + store 数据） */
const tasksByGroup = computed(() => {
  const taskMap = new Map(taskStore.openTasks.map((t) => [t.id, t]));
  const result = new Map<string, typeof taskStore.openTasks>();
  for (const gid of groupIds.value) {
    const ids = localGroups[gid] ?? [];
    result.set(gid, ids.map((id) => taskMap.get(id)).filter((t): t is NonNullable<typeof t> => !!t));
  }
  return result;
});

// store 数据变化时同步 localGroups
watch(
  () => [taskStore.openTasks, groupIds.value] as const,
  () => syncFromStore(),
  { immediate: true, deep: true },
);

/** 新建分组对话框 */
const newGroupVisible = ref(false);
const newGroupName = ref("");

/** 重命名分组对话框 */
const renameGroupVisible = ref(false);
const renameGroupId = ref("");
const renameGroupName = ref("");

/** 分组更多菜单（每组标题右侧的 ⋯） */
const groupMenuVisible = ref<string | null>(null);

// 切换清单时重新加载任务 + 分组
watch(
  () => props.id,
  async (newId) => {
    await Promise.all([
      taskStore.loadTasks(newId),
      groupStore.loadGroups(newId),
    ]);
    // 默认展开所有分组
    activeGroupKeys.value = groupStore.currentGroups.map((g) => g.id);
  },
);

onMounted(async () => {
  await listStore.loadLists();
  await Promise.all([
    taskStore.loadTasks(props.id),
    groupStore.loadGroups(props.id),
  ]);
  // 默认展开所有分组
  activeGroupKeys.value = groupStore.currentGroups.map((g) => g.id);
});

/** 确认新建分组 */
async function confirmNewGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  const group = await groupStore.createGroup(props.id, name);
  if (group) {
    activeGroupKeys.value = [...activeGroupKeys.value, group.id];
  }
  newGroupName.value = "";
  newGroupVisible.value = false;
}

/** 打开重命名对话框 */
function openRename(groupId: string): void {
  const group = groupStore.getById(groupId);
  if (!group) return;
  renameGroupId.value = groupId;
  renameGroupName.value = group.name;
  renameGroupVisible.value = true;
  groupMenuVisible.value = null;
}

/** 确认重命名 */
async function confirmRename(): Promise<void> {
  const name = renameGroupName.value.trim();
  if (!name) return;
  await groupStore.renameGroup(renameGroupId.value, name);
  renameGroupVisible.value = false;
}

/** 删除分组（组内任务回填默认分组） */
async function onDeleteGroup(groupId: string): Promise<void> {
  await groupStore.deleteGroup(groupId);
  groupMenuVisible.value = null;
}

/** 添加任务：创建后如果有 AI 生成的详情(note)，写入 note 字段 */
async function onAdd(payload: { title: string; priority: import("@/types").Priority; dueStartAt: string | null; dueEndAt: string | null; tagIds: string[]; note?: string }) {
  const task = await taskStore.createTask({
    title: payload.title,
    listId: props.id,
    priority: payload.priority,
    dueStartAt: payload.dueStartAt,
    dueEndAt: payload.dueEndAt,
    tagIds: payload.tagIds,
  });
  if (payload.note) {
    await taskStore.updateTask(task.id, { note: payload.note });
  }
}
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
        @add="onAdd"
      />
    </div>

    <div class="mb-2" />

    <!-- 按分组展示未完成任务 + 底部已完成区 -->
    <div v-if="taskStore.currentTasks.length > 0" class="list-view__content">
      <!-- 新建分组按钮 -->
      <div v-if="!currentList?.archived" class="list-view__group-add">
        <button class="list-view__group-add-btn" @click="newGroupVisible = true">
          + 新建分组
        </button>
      </div>

      <a-collapse
        v-model:active-key="activeGroupKeys"
        :bordered="false"
        class="list-view__collapse"
      >
        <!-- 每个分组一个折叠区 -->
        <a-collapse-item
          v-for="group in groupStore.currentGroups"
          :key="group.id"
          :header="`${group.name} · ${tasksByGroup.get(group.id)?.length ?? 0}`"
          class="list-view__collapse-header"
        >
          <!-- 分组标题右侧：更多菜单 -->
          <template #extra>
            <MenuPopover
              v-if="!currentList?.archived"
              :visible="groupMenuVisible === group.id"
              placement="bottom-right"
              @update:visible="(v: boolean) => { groupMenuVisible = v ? group.id : null; }"
            >
              <template #trigger>
                <button
                  class="list-view__group-more-btn"
                  @click.stop.prevent="groupMenuVisible = groupMenuVisible === group.id ? null : group.id"
                >
                  <icon-more :size="14" />
                </button>
              </template>
              <MenuPopoverItem @click="openRename(group.id); ">
                <icon-edit :size="15" />
                <span>重命名分组</span>
              </MenuPopoverItem>
              <MenuPopoverItem
                v-if="group.id !== `${props.id}-default`"
                danger
                @click="onDeleteGroup(group.id)"
              >
                <icon-delete :size="15" />
                <span>删除分组</span>
              </MenuPopoverItem>
            </MenuPopover>
          </template>

          <!-- 分组内任务列表（拖拽容器） -->
          <div
            :ref="(el) => setGroupContainerRef(group.id, el as HTMLElement)"
            @dragover="onDragOver"
            @drop="onGroupDrop"
          >
            <TaskListItem
              v-for="task in (tasksByGroup.get(group.id) ?? [])"
              :key="task.id"
              :task="task"
              :dragging="draggingId === task.id"
              :batch-mode="taskStore.batchMode"
              :batch-selected="taskStore.isBatchSelected(task.id)"
              @select="(e) => onTaskRowSelect(task.id, e)"
              @dragstart="onTaskDragStart(task.id, group.id)"
              @dragend="onTaskDragEnd"
            />
          </div>
          <!-- 空分组占位 -->
          <div
            v-if="(tasksByGroup.get(group.id)?.length ?? 0) === 0"
            class="list-view__group-empty"
          >
            暂无任务
          </div>
        </a-collapse-item>

        <!-- 已完成区（底部） -->
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

    <!-- 新建分组对话框 -->
    <a-modal
      :visible="newGroupVisible"
      :width="360"
      :footer="false"
      :mask-closable="true"
      @update:visible="(v: boolean) => { newGroupVisible = v; }"
    >
      <template #title>新建分组</template>
      <div class="list-view__dialog">
        <a-input
          v-model="newGroupName"
          placeholder="分组名称"
          allow-clear
          @keydown.enter="confirmNewGroup"
        />
        <div class="list-view__dialog-actions">
          <a-button size="small" @click="newGroupVisible = false">取消</a-button>
          <a-button type="primary" size="small" @click="confirmNewGroup">创建</a-button>
        </div>
      </div>
    </a-modal>

    <!-- 重命名分组对话框 -->
    <a-modal
      :visible="renameGroupVisible"
      :width="360"
      :footer="false"
      :mask-closable="true"
      @update:visible="(v: boolean) => { renameGroupVisible = v; }"
    >
      <template #title>重命名分组</template>
      <div class="list-view__dialog">
        <a-input
          v-model="renameGroupName"
          placeholder="分组名称"
          allow-clear
          @keydown.enter="confirmRename"
        />
        <div class="list-view__dialog-actions">
          <a-button size="small" @click="renameGroupVisible = false">取消</a-button>
          <a-button type="primary" size="small" @click="confirmRename">保存</a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
/* 分组区 */
.list-view__group-add {
  padding: 0 4px 8px;
}
.list-view__group-add-btn {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}
.list-view__group-add-btn:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-secondary);
}
.list-view__group-more-btn {
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s;
}
.list-view__collapse-header:hover .list-view__group-more-btn {
  opacity: 1;
}
.list-view__group-more-btn:hover {
  background: var(--jt-surface-hover);
}
.list-view__group-empty {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  padding: 8px 0;
  text-align: center;
}

/* 对话框 */
.list-view__dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}
.list-view__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

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
