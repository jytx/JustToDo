<script setup lang="ts">
// 清单视图 —— 任务列表区主视图
// 含：列表头（标题/日期/计数）、按分组展示未完成任务、完成区折叠、添加栏、空状态
import { computed, watch, onMounted, ref } from "vue";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { useGroupStore } from "@/stores/group";
import type { Group } from "@/types";
import { formatPageDate } from "@/utils/date";
import { shouldReserveNativeMenu } from "@/utils/contextMenu";
import { useTaskPanelContextMenu } from "@/composables/useTaskPanelContextMenu";
import { useGroupDrag } from "@/composables/useGroupDrag";
import { useGroupReorder } from "@/composables/useGroupReorder";
import { useBatchSelect } from "@/composables/useBatchSelect";
import TaskListItem from "@/components/TaskListItem.vue";
import AddTaskBar from "@/components/AddTaskBar.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import MenuPopover from "@/components/MenuPopover.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import BatchContextMenu from "@/components/BatchContextMenu.vue";

const props = defineProps<{ id: string }>();

const listStore = useListStore();
const taskStore = useTaskStore();
const groupStore = useGroupStore();

// 面板右键菜单：新建任务归属当前清单
const { ctxMenu, onContextMenu, onCreateTask } = useTaskPanelContextMenu(
  () => props.id,
  "task",
  // 就近分组判定：右键落点在某个分组容器内 → 新建任务进该组；否则 null（默认组）
  (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return null;
    for (const [gid, el] of groupContainerEls) {
      if (el.contains(target)) return gid;
    }
    return null;
  },
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

/** 分组折叠区右键：无论落在分组名称(header)还是组内，都就近进该组新建。
 *  header 不在 group-container 内（el.contains 命中不了），故在此显式设 groupId。
 *  复用面板右键菜单的显示与 onCreateTask，零新增菜单组件。
 *  注意：任务行右键时 TaskListItem.onContextMenu 内部已 stopPropagation，
 *  不会冒泡到这里；多选模式下让事件继续冒泡给 onRootContextMenu 走批量菜单。 */
function onGroupContextMenu(e: MouseEvent, groupId: string): void {
  // 多选模式：放行给根容器的批量菜单分流
  if (taskStore.batchMode && taskStore.batchSelectedIdsArr.length > 0) return;
  // 放行输入框/可编辑区的系统菜单（与 onContextMenu 一致）
  if (shouldReserveNativeMenu(e.target)) return;
  e.preventDefault();
  // 阻止冒泡到根容器 onRootContextMenu，否则后者会用 resolveGroupId 覆盖 groupId
  e.stopPropagation();
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.groupId = groupId;
  ctxMenu.visible = true;
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
  onTaskDragStart: groupDragStart,
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

// 分组拖拽排序（拖手柄调整分组先后顺序；与任务跨组拖拽隔离）
const {
  localGroupIds,
  draggingId: reorderingGroupId,
  dragOver: reorderDragOver,
  syncFromStore: syncReorder,
  onHandleDragStart,
  onHeaderDragOver,
  onHeaderDragLeave,
  onHeaderDrop,
  onHandleDragEnd,
} = useGroupReorder(() => groupStore.currentGroups.map((g) => g.id));

/** 渲染用的分组列表：拖拽排序时用本地顺序，否则用 store 顺序 */
const renderGroups = computed(() => {
  const map = new Map(groupStore.currentGroups.map((g) => [g.id, g]));
  return localGroupIds.value.map((id) => map.get(id)).filter((g): g is Group => !!g);
});

/** 列级 dragover 适配 */
function onDragOver(e: DragEvent): void {
  onGroupDragOver(e, groupContainerEls);
}

/** dragstart 适配：从任务的 groupId 取所在分组 */
function onDragStart(taskId: string): void {
  const task = taskStore.openTasks.find((t) => t.id === taskId);
  const groupId = task?.groupId ?? `${props.id}-default`;
  groupDragStart(taskId, groupId);
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

// store 数据变化时同步 localGroups（任务拖拽）
watch(
  () => [taskStore.openTasks, groupIds.value] as const,
  () => syncFromStore(),
  { immediate: true, deep: true },
);

// 分组顺序变化时同步 localGroupIds（分组拖拽排序）
watch(
  () => groupIds.value,
  () => syncReorder(),
  { immediate: true },
);

/** 新建分组对话框（支持指定插入位置的 sort_order；null 表示追加末尾） */
const newGroupVisible = ref(false);
const newGroupName = ref("");
/** 新建分组的目标 sort_order（由「上方/下方新建」菜单项设置；普通新建为 null） */
const newGroupSortOrder = ref<number | null>(null);

/** 重命名分组对话框 */
const renameGroupVisible = ref(false);
const renameGroupId = ref("");
const renameGroupName = ref("");

/** 删除分组确认对话框 */
const deleteGroupVisible = ref(false);
const deleteGroupId = ref("");
const deletingGroup = ref(false);
function deleteGroupName(): string {
  return groupStore.getById(deleteGroupId.value)?.name ?? "";
}

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

/** 确认新建分组（newGroupSortOrder 由调用方预设：null=追加末尾，数字=指定位置） */
async function confirmNewGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  const group = await groupStore.createGroup(props.id, name, newGroupSortOrder.value ?? undefined);
  if (group) {
    activeGroupKeys.value = [...activeGroupKeys.value, group.id];
  }
  newGroupName.value = "";
  newGroupSortOrder.value = null;
  newGroupVisible.value = false;
}

/** 打开「新建分组」对话框（普通：追加末尾） */
function openNewGroup(): void {
  newGroupSortOrder.value = null;
  newGroupName.value = "";
  newGroupVisible.value = true;
}

/** 「上方/下方新建分组」：算目标 sort_order 中值后打开对话框
 *  中值法：取相邻两组 sort_order 的平均；边界用 /2 或 +1000 兜底 */
function openNewGroupAdjacent(refGroupId: string, position: "before" | "after"): void {
  const ordered = groupStore.currentGroups;
  const idx = ordered.findIndex((g) => g.id === refGroupId);
  if (idx === -1) {
    openNewGroup();
    return;
  }
  let sortOrder: number;
  if (position === "before") {
    const prevSort = idx > 0 ? ordered[idx - 1].sortOrder : 0;
    sortOrder = Math.floor((prevSort + ordered[idx].sortOrder) / 2);
  } else {
    const nextSort = idx < ordered.length - 1 ? ordered[idx + 1].sortOrder : ordered[idx].sortOrder + 2000;
    sortOrder = Math.floor((ordered[idx].sortOrder + nextSort) / 2);
  }
  newGroupSortOrder.value = sortOrder;
  newGroupName.value = "";
  newGroupVisible.value = true;
  groupMenuVisible.value = null;
}

/** 在指定分组新建任务（空标题 + 选中打开详情面板，复用就近新建范式） */
async function createTaskInGroup(groupId: string): Promise<void> {
  groupMenuVisible.value = null;
  const created = await taskStore.createTask({
    title: "",
    listId: props.id,
    parentId: null,
    groupId,
  });
  taskStore.selectTask(created.id);
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

/** 打开删除分组确认对话框 */
function requestDeleteGroup(groupId: string): void {
  deleteGroupId.value = groupId;
  deleteGroupVisible.value = true;
  groupMenuVisible.value = null;
}

/** 确认删除分组：后端会把组内任务回填到默认分组，删除后刷新任务列表让回填立即显示 */
async function confirmDeleteGroup(): Promise<void> {
  deletingGroup.value = true;
  try {
    await groupStore.deleteGroup(deleteGroupId.value);
    // 后端 group_delete 已把组内任务 group_id 改为默认组，需重新加载任务让 UI 同步
    await taskStore.loadTasks(props.id);
    deleteGroupVisible.value = false;
  } finally {
    deletingGroup.value = false;
  }
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
    <!-- dragover/drop 统一绑在列表外层：真实拖拽时鼠标可能落在空组的
     「暂无任务」占位、组间空隙、已完成区等任何位置，只有外层容器
     能保证事件一定到达（组容器 div 是占位的兄弟元素，冒泡不到）；
     落点判定由 computeTarget 的"最近组兜底"完成。 -->
    <div
      v-if="taskStore.currentTasks.length > 0"
      class="list-view__content"
      @dragover="onDragOver"
      @drop.capture="onGroupDrop"
    >
      <a-collapse
        v-model:active-key="activeGroupKeys"
        :bordered="false"
        class="list-view__collapse"
      >
        <!-- 每个分组一个折叠区 -->
        <a-collapse-item
          v-for="group in renderGroups"
          :key="group.id"
          class="list-view__collapse-header"
          :class="{
            'list-view__collapse-header--drag-over-before':
              reorderDragOver.id === group.id && reorderDragOver.pos === 'before',
            'list-view__collapse-header--drag-over-after':
              reorderDragOver.id === group.id && reorderDragOver.pos === 'after',
            'list-view__collapse-header--dragging': reorderingGroupId === group.id,
          }"
          @contextmenu="onGroupContextMenu($event, group.id)"
        >
          <!-- 自定义 header：拖拽手柄 + 分组名 + 任务数 + 拖拽落点事件 -->
          <template #header>
            <div
              class="list-view__group-header"
              @dragover="onHeaderDragOver($event, group.id)"
              @dragleave="onHeaderDragLeave($event, group.id)"
              @drop="onHeaderDrop($event, group.id)"
            >
              <!-- 拖拽手柄（hover 显示） -->
              <span
                v-if="!currentList?.archived"
                class="list-view__group-handle"
                draggable="true"
                :title="'拖动排序'"
                @dragstart="onHandleDragStart($event, group.id)"
                @dragend="onHandleDragEnd"
              >
                <icon-drag-dot-vertical :size="14" />
              </span>
              <span class="list-view__group-name">{{ group.name }}</span>
              <span class="list-view__group-count">{{ tasksByGroup.get(group.id)?.length ?? 0 }}</span>
            </div>
          </template>
          <!-- 分组标题右侧：新建任务图标 + 更多菜单（flex 同行排列） -->
          <template #extra>
            <div v-if="!currentList?.archived" class="list-view__group-actions">
              <!-- 新建任务图标（在该分组新建任务） -->
              <button
                class="list-view__group-add-task-btn"
                title="在此分组新建任务"
                @click.stop="createTaskInGroup(group.id)"
              >
                <icon-plus :size="14" />
              </button>
              <MenuPopover
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
              <MenuPopoverItem @click="createTaskInGroup(group.id)">
                <icon-plus :size="15" />
                <span>新建任务</span>
              </MenuPopoverItem>
              <MenuPopoverItem @click="openNewGroupAdjacent(group.id, 'before')">
                <icon-arrow-up :size="15" />
                <span>在上方新建分组</span>
              </MenuPopoverItem>
              <MenuPopoverItem @click="openNewGroupAdjacent(group.id, 'after')">
                <icon-arrow-down :size="15" />
                <span>在下方新建分组</span>
              </MenuPopoverItem>
              <MenuPopoverItem @click="openRename(group.id)">
                <icon-edit :size="15" />
                <span>重命名分组</span>
              </MenuPopoverItem>
              <MenuPopoverItem
                v-if="group.id !== `${props.id}-default`"
                danger
                @click="requestDeleteGroup(group.id)"
              >
                <icon-delete :size="15" />
                <span>删除分组</span>
              </MenuPopoverItem>
            </MenuPopover>
            </div>
          </template>

          <!-- 分组内任务列表（拖拽容器；dragover/drop 由外层统一处理） -->
          <div
            :ref="(el) => setGroupContainerRef(group.id, el as HTMLElement)"
            class="list-view__group-container"
          >
            <TaskListItem
              v-for="task in (tasksByGroup.get(group.id) ?? [])"
              :key="task.id"
              :task="task"
              :dragging="draggingId === task.id"
              :batch-mode="taskStore.batchMode"
              :batch-selected="taskStore.isBatchSelected(task.id)"
              force-draggable
              @select="(e) => onTaskRowSelect(task.id, e)"
              @dragstart="onDragStart(task.id)"
              @dragend="onTaskDragEnd"
            />
            <!-- 空分组占位（在容器内部：保证空组容器有高度，拖拽可命中） -->
            <div
              v-if="(tasksByGroup.get(group.id)?.length ?? 0) === 0"
              class="list-view__group-empty"
            >
              暂无任务
            </div>
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

    <!-- 删除分组确认对话框（组内任务会自动移到默认分组） -->
    <ConfirmDialog
      :visible="deleteGroupVisible"
      :loading="deletingGroup"
      @update:visible="(v: boolean) => { deleteGroupVisible = v; }"
      @confirm="confirmDeleteGroup"
    >
      <template #title>删除分组「<strong>{{ deleteGroupName() }}</strong>」？</template>
      该分组内的任务会自动移动到「默认分组」，不会被删除。
    </ConfirmDialog>
  </div>
</template>

<style scoped>
/* 分组区 */
/* 标题行：标题 + 新建分组按钮两端对齐 */
/* 新建分组按钮：与 AddTaskBar 同排，放其右侧，纯图标样式（对齐 AddTaskBar 属性按钮） */
.list-view__group-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  color: var(--jt-text-tertiary);
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}
.list-view__group-add-btn:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
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

/* 分组标题右侧操作区：新建任务图标 + 更多菜单按钮同行排列 */
.list-view__group-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 新建任务图标按钮：与更多按钮同款样式（hover header 时显示） */
.list-view__group-add-task-btn {
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
.list-view__collapse-header:hover .list-view__group-add-task-btn {
  opacity: 1;
}
.list-view__group-add-task-btn:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
.list-view__collapse-header:hover .list-view__group-more-btn {
  opacity: 1;
}
.list-view__group-more-btn:hover {
  background: var(--jt-surface-hover);
}

/* 分组 header：拖拽手柄 + 名称 + 计数横向排列 */
.list-view__group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0; /* 名称超长省略 */
}

/* 拖拽手柄：默认隐藏，hover header 时显示；grab 光标 */
.list-view__group-handle {
  display: flex;
  align-items: center;
  color: var(--jt-text-tertiary);
  cursor: grab;
  opacity: 0;
  transition: opacity 0.12s;
  flex-shrink: 0;
  padding: 2px 0;
}
.list-view__collapse-header:hover .list-view__group-handle {
  opacity: 1;
}
.list-view__group-handle:active {
  cursor: grabbing;
}
.list-view__group-handle[draggable="false"] {
  -webkit-user-drag: none;
}

.list-view__group-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-view__group-count {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}

/* 分组拖拽落点高亮：参照 SidebarListNode，before/after 用上下边线感 */
.list-view__collapse-header--drag-over-before {
  box-shadow: inset 0 2px 0 var(--jt-primary);
}
.list-view__collapse-header--drag-over-after {
  box-shadow: inset 0 -2px 0 var(--jt-primary);
}

/* 正在被拖动的分组：半透明（与任务拖拽源行一致） */
.list-view__collapse-header--dragging {
  opacity: 0.4;
}

.list-view__group-empty {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  padding: 8px 0;
  text-align: center;
}

/* 组拖拽容器：空组时也有最小高度（占位文案在容器内部），
 * 保证真实拖拽时鼠标落点能命中容器 rect（computeTarget 的组判定）。 */
.list-view__group-container {
  min-height: 48px;
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
  display: flex;
  align-items: center;
  gap: 4px;
}
/* AddTaskBar 占满剩余宽度，新建分组按钮靠右 */
.list-view__add-bar > :first-child {
  flex: 1;
  min-width: 0;
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
