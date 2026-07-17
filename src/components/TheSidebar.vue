<script setup lang="ts">
// 侧边栏 —— 四区块导航（智能视图 / 清单 / 标签 / 习惯）
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  IconStar,
  IconClockCircle,
  IconCheckCircle,
  IconTag,
  IconPlus,
  IconSettings,
  IconTrophy,
  IconDelete,
  IconMore,
  IconMenuFold,
  IconMenuUnfold,
  IconRight,
  IconDown,
  IconFolder,
  IconClose,
} from "@arco-design/web-vue/es/icon";
// IconEdit 移到 SidebarListNode 中使用
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { useHabitStore } from "@/stores/habit";
import { useTaskStore } from "@/stores/task";
import SidebarListNode from "./SidebarListNode.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import TeleportPopper from "./TeleportPopper.vue";
import * as db from "@/api/db";

const props = defineProps<{
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  "update:collapsed": [value: boolean];
}>();

function toggleCollapsed() {
  emit("update:collapsed", !props.collapsed);
}

const route = useRoute();
const router = useRouter();
const listStore = useListStore();
const tagStore = useTagStore();
const habitStore = useHabitStore();
const taskStore = useTaskStore();

/** 各区块展开/收起状态 */
const sectionCollapsed = ref<Record<string, boolean>>({
  smart: false,
  lists: false,
  tags: false,
  habits: false,
});

function toggleSection(key: string) {
  sectionCollapsed.value[key] = !sectionCollapsed.value[key];
}

/** 编辑清单状态 */
const editingList = ref<{ id: string; name: string; color: string } | null>(null);
const editListName = ref("");
const editListColor = ref("#10B981");

/** 删除确认对话框 */
const confirmDelete = ref<{
  type: "list" | "tag";
  id: string;
  name: string;
  taskCount: number;
} | null>(null);

/** 编辑清单/目录弹窗 */
const showEditDialog = ref(false);

function startEditList(list: { id: string; name: string; color: string }) {
  if (list.id === "inbox") return;
  editingList.value = { id: list.id, name: list.name, color: list.color };
  editListName.value = list.name;
  editListColor.value = list.color;
  showEditDialog.value = true;
}

async function saveListEdit() {
  if (!editingList.value) return;
  const name = editListName.value.trim();
  if (!name) {
    showEditDialog.value = false;
    return;
  }
  await db.renameList(editingList.value.id, name, editListColor.value);
  await listStore.loadLists();
  showEditDialog.value = false;
  editingList.value = null;
}

async function askDeleteList(list: { id: string; name: string }) {
  if (list.id === "inbox") return; // 收件箱不可删
  // 统计任务数
  const allTasks = await db.getTasksByList(list.id);
  confirmDelete.value = {
    type: "list",
    id: list.id,
    name: list.name,
    taskCount: allTasks.length,
  };
}

async function askDeleteTag(tag: { id: string; name: string }) {
  tagMenuOpen[tag.id] = false;
  confirmDelete.value = {
    type: "tag",
    id: tag.id,
    name: tag.name,
    taskCount: 0, // 不查了，删除标签不会删除任务
  };
}

/** 每个标签对应一个菜单开关（key 为 tag.id） */
const tagMenuOpen = reactive<Record<string, boolean>>({});

/* === 标签拖拽排序（HTML5 drag，同列表内重排） === */
const tagDragOverId = ref<string | null>(null);

function onTagDragStart(e: DragEvent, tagId: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData("text/plain", tagId);
  e.dataTransfer.effectAllowed = "move";
}
function onTagDragOver(e: DragEvent, tagId: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.dropEffect = "move";
  tagDragOverId.value = tagId;
}
function onTagDragLeave(_e: DragEvent) {
  // 不在这里清空 —— 避免拖到子元素闪烁；dragend/drop 时统一清
}
function onTagDragEnd() {
  tagDragOverId.value = null;
}
async function onTagDrop(e: DragEvent, targetId: string) {
  e.preventDefault();
  tagDragOverId.value = null;
  const draggedId = e.dataTransfer?.getData("text/plain");
  if (!draggedId || draggedId === targetId) return;
  const ids = tagStore.tags.map((t) => t.id);
  const fromIdx = ids.indexOf(draggedId);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, draggedId);
  await tagStore.reorderTags(ids);
}

/* === 习惯拖拽排序（HTML5 drag，同列表内重排） === */
const habitDragOverId = ref<string | null>(null);

function onHabitDragStart(e: DragEvent, habitId: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData("text/plain", habitId);
  e.dataTransfer.effectAllowed = "move";
}
function onHabitDragOver(e: DragEvent, habitId: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.dropEffect = "move";
  habitDragOverId.value = habitId;
}
function onHabitDragLeave(_e: DragEvent) {
  /* 不立即清 —— dragend/drop 时统一清，避免子元素闪烁 */
}
function onHabitDragEnd() {
  habitDragOverId.value = null;
}
async function onHabitDrop(e: DragEvent, targetId: string) {
  e.preventDefault();
  habitDragOverId.value = null;
  const draggedId = e.dataTransfer?.getData("text/plain");
  if (!draggedId || draggedId === targetId) return;
  const ids = habitStore.habits.map((h) => h.habit.id);
  const fromIdx = ids.indexOf(draggedId);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, draggedId);
  await habitStore.reorderHabits(ids);
}

async function confirmDeleteAction() {
  if (!confirmDelete.value) return;
  const { type, id, name } = confirmDelete.value;
  if (type === "list") {
    // 如果当前选中的是这个清单，跳到"全部"视图
    if (route.params.id === id) {
      router.push("/all");
    }
    await db.deleteList(id);
    await listStore.loadLists();
    if (route.params.id === id) {
      // 删除后任务也会级联删除，刷新 currentTasks
      taskStore.selectedTaskId = null;
    }
  } else {
    // 如果当前在标签视图，跳走
    if (route.name === "tag" && route.params.id === id) {
      router.push("/all");
    }
    await db.deleteTag(id);
    await tagStore.loadTags();
  }
  confirmDelete.value = null;
  console.log(`已删除 ${type}: ${name}`);
}

function cancelDelete() {
  confirmDelete.value = null;
}

/** 新建清单弹窗 */
const showCreateDialog = ref(false);
const newListName = ref("");
const newListNameInputRef = ref<HTMLInputElement | null>(null);
/** 目录路径字符串，支持 "A/B" 多级（可输入已有目录路径名以提示筛选） */
const newListFolder = ref("");
const selectedColor = ref('#10B981');

/** 8 种预定义颜色 */
const LIST_COLORS = [
  '#EF4444', '#F59E0B', '#EAB308', '#10B981',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280',
];

function startNewList() {
  newListName.value = "";
  newListFolder.value = "";
  selectedColor.value = '#10B981';
  showCreateDialog.value = true;
  // 等 modal 渲染完后自动 focus
  nextTick(() => {
    newListNameInputRef.value?.focus();
  });
}

/** 新建标签弹窗状态 */
const showCreateTagDialog = ref(false);
const newTagName = ref("");
const newTagNameInputRef = ref<HTMLInputElement | null>(null);

function startNewTag() {
  newTagName.value = "";
  showCreateTagDialog.value = true;
  nextTick(() => {
    newTagNameInputRef.value?.focus();
  });
}

async function confirmNewTag() {
  const name = newTagName.value.trim();
  if (!name) {
    showCreateTagDialog.value = false;
    return;
  }
  await tagStore.createTag(name);
  showCreateTagDialog.value = false;
}

/** 新建习惯弹窗状态 */
const showCreateHabitDialog = ref(false);
const newHabitName = ref("");
const newHabitNameInputRef = ref<HTMLInputElement | null>(null);
const newHabitColor = ref("#059669");

function startNewHabit() {
  newHabitName.value = "";
  newHabitColor.value = "#059669";
  showCreateHabitDialog.value = true;
  nextTick(() => {
    newHabitNameInputRef.value?.focus();
  });
}

async function confirmNewHabit() {
  const name = newHabitName.value.trim();
  if (!name) {
    showCreateHabitDialog.value = false;
    return;
  }
  await habitStore.createHabit({ name, color: newHabitColor.value });
  showCreateHabitDialog.value = false;
}

/** 颜色选择器 hover 状态（list / habit 各自独立） */
const colorPickerOpen = reactive<{ list: boolean; habit: boolean }>({
  list: false,
  habit: false,
});

/** 颜色 trigger 元素缓存（用 data-color-trigger 标识，click 时通过 querySelector 找） */
const colorTriggerEls = reactive<{ list: HTMLElement | null; habit: HTMLElement | null }>({
  list: null,
  habit: null,
});

/** 点击颜色 trigger —— 切换 popper + 缓存 trigger 元素 */
function onClickColorTrigger(which: "list" | "habit", e: MouseEvent) {
  // e.currentTarget 是当前 button（与原生 target 一致但不受子元素干扰）
  const el = e.currentTarget as HTMLElement;
  colorTriggerEls[which] = el;
  colorPickerOpen[which] = !colorPickerOpen[which];
}

/** 目录 trigger 元素 + 弹层状态 */
const folderTriggerEl = ref<HTMLElement | null>(null);
const newListFolderPopupVisible = ref(false);

function onClickFolderTrigger(e: MouseEvent) {
  folderTriggerEl.value = e.currentTarget as HTMLElement;
  newListFolderPopupVisible.value = !newListFolderPopupVisible.value;
}

/** 输入提示：把已有的目录拼成完整路径，作为自动补全的数据源 */
const folderSuggestions = computed(() => {
  const folders = listStore.sortedLists.filter((l) => l.isFolder);
  // 按"根→叶"路径分组，输出完整路径字符串
  const buildPath = (id: string): string => {
    const ids: string[] = [];
    let cur: string | null | undefined = id;
    while (cur) {
      ids.unshift(cur);
      const node: any = listStore.getById(cur);
      cur = node?.parentId ?? null;
    }
    return ids
      .map((nid) => listStore.getById(nid)?.name)
      .filter(Boolean)
      .join("/");
  };
  return folders.map((f) => {
    const path = buildPath(f.id);
    return {
      value: path,
      label: path, // Arco 默认按 label 字段展示，这里保持一致
      name: path,
    };
  });
});

/** 选中目录项时回填到输入框（v-model 双向绑定的体现） */
function onFolderSelect(value: string) {
  newListFolder.value = value;
}

/** 处理清单拖拽移动 */
async function onListMove(draggedId: string, target: any, position: "before" | "after" | "inside") {
  try {
    if (position === "inside") {
      // 放入目录：target 是目录节点
      await listStore.moveNode(draggedId, target.id, 999);
    } else {
      // before/after：和 target 同级
      const targetParentId = target.parentId;
      // 找到 target 在同级中的索引
      const siblings = listStore.sortedLists.filter((l) => l.parentId === targetParentId);
      const targetIndex = siblings.findIndex((l) => l.id === target.id);
      const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
      // 如果拖动的节点也在同一父级且在目标前面，索引需要 -1（因为移除后位置变化）
      const draggedInSameParent = siblings.some((l) => l.id === draggedId);
      const adjustedIndex = draggedInSameParent && siblings.findIndex((l) => l.id === draggedId) < targetIndex
        ? insertIndex - 1
        : insertIndex;
      await listStore.moveNode(draggedId, targetParentId, adjustedIndex);
    }
  } catch (e) {
    console.error("[Sidebar] 移动清单失败:", e);
  }
}

async function confirmNewList() {
  const name = newListName.value.trim();
  if (!name) {
    showCreateDialog.value = false;
    return;
  }

  // 处理目录路径（支持 "A/B" 创建多级目录）
  let parentId: string | null = null;
  const folderPath = newListFolder.value.trim();
  if (folderPath) {
    parentId = await listStore.ensureFolderPath(folderPath, selectedColor.value);
  }

  await listStore.createList({ name, color: selectedColor.value, parentId });
  showCreateDialog.value = false;
}

/** 目录展开状态（目前由 SidebarListNode 内部管理，保留备用） */

const activeListId = computed(() => route.params.id as string);
const activeRouteName = computed(() => route.name as string);

const smartViews = [
  { id: "today", route: "today", icon: IconStar, label: "今天" },
  { id: "upcoming", route: "upcoming", icon: IconClockCircle, label: "未来 7 天" },
  { id: "all", route: "all", icon: IconCheckCircle, label: "全部" },
];

onMounted(async () => {
  await listStore.loadLists();
  await tagStore.loadTags();
  await taskStore.refreshCounts();
});
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar--collapsed': collapsed }">
    <div class="sidebar__header">
      <a-button
        class="sidebar__collapse-btn"
        type="text"
        size="mini"
        shape="circle"
        :title="collapsed ? '展开侧边栏' : '收起侧边栏'"
        @click="toggleCollapsed"
      >
        <icon-menu-unfold v-if="collapsed" :size="16" />
        <icon-menu-fold v-else :size="16" />
      </a-button>
    </div>

    <nav class="sidebar__nav">
      <!-- 智能视图 -->
      <div class="sidebar__subheader sidebar__subheader--toggle">
        <div class="sidebar__subheader-left" @click="toggleSection('smart')">
          <icon-down v-if="!sectionCollapsed.smart" :size="12" class="sidebar__toggle-icon" />
          <icon-right v-else :size="12" class="sidebar__toggle-icon" />
          <span>智能视图</span>
        </div>
      </div>
      <router-link
        v-for="v in smartViews"
        v-show="!sectionCollapsed.smart"
        :key="v.id"
        :to="`/${v.route}`"
        class="sidebar__item"
        :class="{ 'sidebar__item--active': activeRouteName === v.route }"
      >
        <component :is="v.icon" :size="16" class="sidebar__item-icon" />
        <span class="sidebar__item-title">{{ v.label }}</span>
        <span v-if="taskStore.smartCounts[v.id]" class="sidebar__count">{{ taskStore.smartCounts[v.id] }}</span>
      </router-link>

      <!-- 清单 -->
      <div class="sidebar__subheader sidebar__subheader--toggle">
        <div class="sidebar__subheader-left" @click="toggleSection('lists')">
          <icon-down v-if="!sectionCollapsed.lists" :size="12" class="sidebar__toggle-icon" />
          <icon-right v-else :size="12" class="sidebar__toggle-icon" />
          <span>清单</span>
        </div>
        <a-button size="mini" type="text" title="新建清单" @click.stop="startNewList">
          <template #icon><icon-plus :size="16" /></template>
        </a-button>
      </div>

      <!-- 树形清单渲染 -->
      <div v-show="!sectionCollapsed.lists" class="sidebar__list-tree">
        <SidebarListNode
          v-for="node in listStore.listTree"
          :key="node.id"
          :node="node"
          :depth="0"
          @edit="(n: any) => startEditList(n)"
          @delete="(n: any) => askDeleteList(n)"
          @move="onListMove"
        />
      </div>

      <!-- 标签 -->
      <div class="sidebar__subheader sidebar__subheader--toggle">
        <div class="sidebar__subheader-left" @click="toggleSection('tags')">
          <icon-down v-if="!sectionCollapsed.tags" :size="12" class="sidebar__toggle-icon" />
          <icon-right v-else :size="12" class="sidebar__toggle-icon" />
          <span>标签</span>
        </div>
        <a-button size="mini" type="text" title="新建标签" @click.stop="startNewTag">
          <template #icon><icon-plus :size="16" /></template>
        </a-button>
      </div>
      <router-link
        v-for="tag in tagStore.tags"
        v-show="!sectionCollapsed.tags"
        :key="tag.id"
        :to="`/tag/${tag.id}`"
        class="sidebar__item"
        :class="{
          'sidebar__item--active': activeRouteName === 'tag' && activeListId === tag.id,
          'sidebar__item--drag-over': tagDragOverId === tag.id,
        }"
        :data-tag-id="tag.id"
        :draggable="!sectionCollapsed.tags"
        @dragstart="onTagDragStart($event, tag.id)"
        @dragover.prevent="onTagDragOver($event, tag.id)"
        @dragleave="onTagDragLeave"
        @drop="onTagDrop($event, tag.id)"
        @dragend="onTagDragEnd"
      >
        <icon-tag :size="16" class="sidebar__item-icon" />
        <span class="sidebar__item-title">{{ tag.name }}</span>
        <span v-if="taskStore.tagCounts[tag.id]" class="sidebar__count">{{ taskStore.tagCounts[tag.id] }}</span>
        <MenuPopover
          v-model:visible="tagMenuOpen[tag.id]"
        >
          <template #trigger>
            <button
              class="sidebar__item-menu-btn"
              @click.stop.prevent="tagMenuOpen[tag.id] = !tagMenuOpen[tag.id]"
              :title="`编辑 ${tag.name}`"
            >
              <icon-more :size="16" />
            </button>
          </template>
          <MenuPopoverItem danger @click="askDeleteTag(tag)">
            <icon-delete :size="15" />
            <span>删除标签</span>
          </MenuPopoverItem>
        </MenuPopover>
      </router-link>

      <div
        v-if="tagStore.tags.length === 0"
        class="sidebar__item sidebar__item--disabled"
      >
        <icon-tag :size="16" class="sidebar__item-icon" />
        <span class="sidebar__item-title">暂无标签</span>
      </div>

      <!-- 习惯 -->
      <div class="sidebar__subheader sidebar__subheader--toggle">
        <div class="sidebar__subheader-left" @click="toggleSection('habits')">
          <icon-down v-if="!sectionCollapsed.habits" :size="12" class="sidebar__toggle-icon" />
          <icon-right v-else :size="12" class="sidebar__toggle-icon" />
          <span>习惯</span>
        </div>
        <a-button size="mini" type="text" title="新建习惯" @click.stop="startNewHabit">
          <template #icon><icon-plus :size="16" /></template>
        </a-button>
      </div>
      <router-link
        v-for="h in habitStore.habits"
        v-show="!sectionCollapsed.habits"
        :key="h.habit.id"
        :to="`/habits#${h.habit.id}`"
        class="sidebar__item"
        :class="{
          // 只有当前 hash 等于这个 habit.id 时才高亮，避免所有 habit 同时显示 active
          'sidebar__item--active':
            activeRouteName === 'habits' && route.hash === '#' + h.habit.id,
          'sidebar__item--drag-over': habitDragOverId === h.habit.id,
        }"
        :data-habit-id="h.habit.id"
        :draggable="!sectionCollapsed.habits"
        @dragstart="onHabitDragStart($event, h.habit.id)"
        @dragover.prevent="onHabitDragOver($event, h.habit.id)"
        @dragleave="onHabitDragLeave"
        @drop="onHabitDrop($event, h.habit.id)"
        @dragend="onHabitDragEnd"
      >
        <icon-trophy :size="16" class="sidebar__item-icon" :style="{ color: h.habit.color }" />
        <span class="sidebar__item-title">{{ h.habit.name }}</span>
        <span v-if="h.streak" class="sidebar__count">🔥{{ h.streak }}</span>
      </router-link>
      <router-link
        v-show="!sectionCollapsed.habits && habitStore.habits.length > 0"
        to="/habits"
        class="sidebar__item sidebar__item--minor"
      >
        <icon-more :size="14" class="sidebar__item-icon" />
        <span class="sidebar__item-title">查看全部习惯</span>
      </router-link>
      <div
        v-if="habitStore.habits.length === 0"
        v-show="!sectionCollapsed.habits"
        class="sidebar__item sidebar__item--disabled"
      >
        <icon-trophy :size="16" class="sidebar__item-icon" />
        <span class="sidebar__item-title">暂无习惯</span>
      </div>
    </nav>

    <div class="sidebar__append">
      <router-link to="/settings" class="sidebar__item">
        <icon-settings :size="16" class="sidebar__item-icon" />
        <span class="sidebar__item-title">设置</span>
      </router-link>
    </div>
  </aside>

  <!-- 删除确认对话框 -->
  <a-modal
    :visible="!!confirmDelete"
    :width="400"
    @cancel="cancelDelete"
    @ok="confirmDeleteAction"
  >
    <template #title>确认删除</template>
    <div v-if="confirmDelete">
      <p>
        确定要删除
        <strong>{{ confirmDelete.type === "list" ? "清单" : "标签" }}「{{ confirmDelete.name }}」</strong>
        吗？
      </p>
      <p v-if="confirmDelete.type === 'list' && confirmDelete.taskCount > 0" class="sidebar__warn-text">
        ⚠️ 清单下的 {{ confirmDelete.taskCount }} 个任务将移动到「收件箱」。
      </p>
      <p v-else-if="confirmDelete.type === 'list'" class="sidebar__warn-text">
        ⚠️ 清单为空，将直接删除。
      </p>
      <p v-else-if="confirmDelete.type === 'tag'" class="sidebar__warn-text">
        ⚠️ 标签将被删除（任务不受影响）。
      </p>
    </div>
    <template #footer>
      <a-button @click="cancelDelete">取消</a-button>
      <a-button status="danger" type="primary" @click="confirmDeleteAction">删除</a-button>
    </template>
  </a-modal>

  <!-- 新建清单弹窗（QuickAdd 风格：裸 input + 属性 trigger + 回车提交） -->
  <a-modal
    v-model:visible="showCreateDialog"
    :width="440"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="sidebar-create-modal"
  >
    <div class="sidebar-create">
      <!-- 主输入行 -->
      <div class="sidebar-create__input-row">
        <input
          ref="newListNameInputRef"
          v-model="newListName"
          class="sidebar-create__input"
          placeholder="清单名称"
          @keydown.enter="confirmNewList"
          @keydown.escape.stop="showCreateDialog = false"
        />
        <button
          class="sidebar-create__close"
          title="关闭"
          @click="showCreateDialog = false"
        >
          <icon-close :size="14" />
        </button>
      </div>
      <div class="sidebar-create__divider" />
      <!-- 属性行：目录 + 颜色 trigger（hover/focus 展示色板） -->
      <div class="sidebar-create__attrs">
        <!-- 目录 trigger：点击切换 TeleportPopper，popup 浮到 body 避开 modal overflow 裁剪 -->
        <button
          data-folder-trigger
          type="button"
          class="sidebar-create__trigger"
          :class="{ 'sidebar-create__trigger--active': newListFolderPopupVisible }"
          @click="onClickFolderTrigger($event)"
        >
          <icon-folder :size="14" />
          <span>{{ newListFolder || "目录" }}</span>
        </button>

        <!-- 颜色 trigger：TeleportPopper 下拉弹框（popup 浮在 modal 外，避开 stacking context） -->
        <button
          data-color-trigger="list"
          type="button"
          class="sidebar-create__trigger"
          @click="onClickColorTrigger('list', $event)"
        >
          <span
            class="sidebar-create__color-dot"
            :style="{ backgroundColor: selectedColor }"
          />
          <span>颜色</span>
        </button>

        <span class="sidebar-create__spacer" />

        <span class="sidebar-create__hint">回车保存</span>
      </div>
    </div>
  </a-modal>

  <!-- 编辑清单/目录弹窗 -->
  <a-modal
    v-model:visible="showEditDialog"
    :width="400"
    title="编辑"
  >
    <div class="create-list-dialog__field">
      <label class="create-list-dialog__label">名称</label>
      <a-input
        v-model="editListName"
        placeholder="名称"
        @keydown.enter="saveListEdit"
      />
    </div>
    <div class="create-list-dialog__colors">
      <span class="create-list-dialog__label">颜色</span>
      <div class="create-list-dialog__color-row">
        <button
          v-for="c in LIST_COLORS"
          :key="c"
          class="create-list-dialog__color"
          :class="{ 'create-list-dialog__color--active': editListColor === c }"
          :style="{ backgroundColor: c }"
          @click="editListColor = c"
        />
      </div>
    </div>
    <template #footer>
      <a-button type="text" @click="showEditDialog = false">取消</a-button>
      <a-button type="primary" @click="saveListEdit">保存</a-button>
    </template>
  </a-modal>

  <!-- 新建标签弹窗（QuickAdd 风格） -->
  <a-modal
    v-model:visible="showCreateTagDialog"
    :width="440"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="sidebar-create-modal"
  >
    <div class="sidebar-create">
      <div class="sidebar-create__input-row">
        <input
          ref="newTagNameInputRef"
          v-model="newTagName"
          class="sidebar-create__input"
          placeholder="标签名称"
          @keydown.enter="confirmNewTag"
          @keydown.escape.stop="showCreateTagDialog = false"
        />
        <button
          class="sidebar-create__close"
          title="关闭"
          @click="showCreateTagDialog = false"
        >
          <icon-close :size="14" />
        </button>
      </div>
      <div class="sidebar-create__attrs">
        <span class="sidebar-create__spacer" />
        <span class="sidebar-create__hint">回车保存</span>
      </div>
    </div>
  </a-modal>

  <!-- 新建习惯弹窗（QuickAdd 风格） -->
  <a-modal
    v-model:visible="showCreateHabitDialog"
    :width="440"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="sidebar-create-modal"
  >
    <div class="sidebar-create">
      <div class="sidebar-create__input-row">
        <input
          ref="newHabitNameInputRef"
          v-model="newHabitName"
          class="sidebar-create__input"
          placeholder="习惯名称"
          @keydown.enter="confirmNewHabit"
          @keydown.escape.stop="showCreateHabitDialog = false"
        />
        <button
          class="sidebar-create__close"
          title="关闭"
          @click="showCreateHabitDialog = false"
        >
          <icon-close :size="14" />
        </button>
      </div>
      <div class="sidebar-create__divider" />
      <div class="sidebar-create__attrs">
        <!-- 颜色 trigger：TeleportPopper 下拉弹框 -->
        <button
          data-color-trigger="habit"
          type="button"
          class="sidebar-create__trigger"
          @click="onClickColorTrigger('habit', $event)"
        >
          <span
            class="sidebar-create__color-dot"
            :style="{ backgroundColor: newHabitColor }"
          />
          <span>颜色</span>
        </button>

        <span class="sidebar-create__spacer" />
        <span class="sidebar-create__hint">回车保存</span>
      </div>
    </div>
  </a-modal>

  <!-- 目录输入弹层（Teleport 到 body，避开 modal overflow 裁剪） -->
  <TeleportPopper
    v-model:visible="newListFolderPopupVisible"
    :anchor="folderTriggerEl"
    placement="bottom-left"
  >
    <div class="sidebar-create__folder-popup">
      <!-- 列表：已有目录，点击直接选中 -->
      <div v-if="folderSuggestions.length > 0" class="sidebar-create__folder-list">
        <button
          v-for="f in folderSuggestions"
          :key="f.value"
          type="button"
          class="sidebar-create__folder-item"
          :class="{ 'sidebar-create__folder-item--active': newListFolder === f.value }"
          @click="onFolderSelect(f.value); newListFolderPopupVisible = false"
        >
          <icon-folder :size="13" />
          <span>{{ f.value }}</span>
        </button>
      </div>
      <div v-else class="sidebar-create__folder-empty">
        暂无目录
      </div>
      <!-- 分隔线 + 新建输入框（始终在底部，输入即新建） -->
      <div class="sidebar-create__folder-divider" />
      <input
        v-model="newListFolder"
        class="sidebar-create__folder-input"
        placeholder="新建目录（如：工作/项目A）"
        @keydown.enter="newListFolderPopupVisible = false"
        @keydown.escape.stop="newListFolderPopupVisible = false"
      />
    </div>
  </TeleportPopper>

  <!-- 颜色 picker 弹层（Teleport 到 body，避开 modal stacking-context） -->
  <TeleportPopper
    v-model:visible="colorPickerOpen.list"
    :anchor="colorTriggerEls.list"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': selectedColor === c }"
        :style="{ backgroundColor: c }"
        @click="selectedColor = c; colorPickerOpen.list = false"
      />
    </div>
  </TeleportPopper>
  <TeleportPopper
    v-model:visible="colorPickerOpen.habit"
    :anchor="colorTriggerEls.habit"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': newHabitColor === c }"
        :style="{ backgroundColor: c }"
        @click="newHabitColor = c; colorPickerOpen.habit = false"
      />
    </div>
  </TeleportPopper>
</template>

<style scoped>
.sidebar {
  width: 240px;
  height: 100%;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--jt-surface-sunken);
  border-right: 1px solid var(--jt-border);
  transition: width 0.2s ease;
  overflow: hidden;
}

.sidebar--collapsed {
  width: 48px;
}

.sidebar--collapsed .sidebar__nav,
.sidebar--collapse-on-collapse {
  display: none;
}

.sidebar__header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  /* 顶部预留 32px（28 原生 Overlay + 4 间距），避免折叠按钮跟原生窗口按钮重叠 */
  padding: 32px 8px 4px;
  gap: 4px;
  /* header 整条作为可拖动区域，按钮本身 no-drag */
  -webkit-app-region: drag;
}

.sidebar__header > * {
  -webkit-app-region: no-drag;
}

.sidebar__collapse-btn {
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
}

.sidebar__collapse-btn:hover {
  color: var(--jt-text-primary);
}

.sidebar__brand {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.02em;
}

.sidebar__nav {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.sidebar__subheader {
  margin-top: 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  min-height: 28px;
}

.sidebar__subheader--toggle {
  cursor: pointer;
  user-select: none;
}

.sidebar__subheader--toggle:hover {
  color: var(--jt-text-secondary);
}

.sidebar__subheader-left {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.sidebar__toggle-icon {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.sidebar__item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  text-decoration: none;
  cursor: pointer;
  position: relative;
}

.sidebar__item:hover {
  background-color: var(--jt-surface-hover);
}

.sidebar__item--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

/* 标签 / 习惯拖拽悬停时显示蓝色描边（视觉提示落点） */
.sidebar__item--drag-over {
  outline: 1.5px solid var(--jt-primary);
  outline-offset: -1.5px;
  background-color: var(--jt-accent-soft);
}
.sidebar__item {
  cursor: default;
}
.sidebar__item[draggable="true"] {
  cursor: grab;
}
.sidebar__item[draggable="true"]:active {
  cursor: grabbing;
}

/* "查看全部习惯" 二级入口 —— 视觉降权（比主行小、灰度） */
.sidebar__item--minor {
  font-size: 12px;
  color: var(--jt-text-secondary);
}
.sidebar__item--minor .sidebar__item-icon {
  opacity: 0.7;
}

.sidebar__item--disabled {
  opacity: 0.4;
  cursor: default;
}

.sidebar__item-icon {
  flex-shrink: 0;
}

.sidebar__item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

.sidebar__count {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
  position: absolute;
  right: 8px;
  transition: right 0.15s;
}

/* hover 时菜单按钮出现，计数左移让位 */
.sidebar__item:hover .sidebar__count {
  right: 32px;
}

.sidebar__new-list {
  padding: 6px 10px 8px;
  margin-bottom: 4px;
}

.sidebar__new-list-input {
  width: 100%;
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  background-color: var(--jt-surface);
  color: inherit;
  font-family: var(--font-body);
  outline: none;
}

.sidebar__new-list-input:focus {
  border-color: var(--jt-primary);
}

.sidebar__new-list-colors {
  display: flex;
  gap: 4px;
  margin: 6px 0;
  flex-wrap: wrap;
}

.sidebar__new-list-color {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}

.sidebar__new-list-color--active {
  border-color: var(--jt-text-primary);
}

.sidebar__new-list-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}

.sidebar__item-menu-btn {
  position: absolute;
  top: 50%;
  right: 4px;
  background: transparent;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 5;
}

.sidebar__item:hover .sidebar__item-menu-btn {
  opacity: 1;
}

.sidebar__item-menu-btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.sidebar__edit-form {
  padding: 6px 10px 8px;
  margin-bottom: 4px;
}

.sidebar__edit-input {
  width: 100%;
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  background-color: var(--jt-surface);
  color: inherit;
  font-family: var(--font-body);
  outline: none;
}

.sidebar__edit-input:focus {
  border-color: var(--jt-primary);
}

.sidebar__edit-colors {
  display: flex;
  gap: 4px;
  margin: 6px 0;
}

.sidebar__edit-color {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}

.sidebar__edit-color--active {
  border-color: var(--jt-text-primary);
}

.sidebar__edit-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}

/* 行内编辑：直接替换当前清单行，不再在下方另起一块 */
.sidebar__edit-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 6px 8px;
  border-radius: 8px;
  background-color: var(--jt-accent-soft);
  flex-wrap: wrap;
}

.sidebar__edit-inline .sidebar__edit-input {
  flex: 1;
  min-width: 60px;
}

.sidebar__append {
  padding: 0 8px 12px;
}

.sidebar__warn-text {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 8px 0 0;
}

.sidebar__menu-danger {
  color: var(--jt-error);
}
</style>

<!-- 新建清单弹窗样式 -->
<style scoped>
.create-list-dialog__field {
  margin-bottom: 16px;
}

.create-list-dialog__label {
  display: block;
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin-bottom: 8px;
}

.create-list-dialog__colors {
  margin-top: 4px;
}

.create-list-dialog__color-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.create-list-dialog__color {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s;
}

.create-list-dialog__color--active {
  border-color: color-mix(in srgb, var(--jt-text-primary) 60%, transparent);
}

.sidebar__list-tree {
  display: flex;
  flex-direction: column;
}

/* 自动补全：目录路径候选 */
.create-list-dialog__folder-suggestion {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 1.2;
}

.create-list-dialog__folder-suggestion :deep(.arco-icon) {
  color: var(--jt-text-tertiary);
}
</style>

<!-- 侧栏快速创建弹窗样式（与 QuickAddDialog 同源视觉） -->
<style scoped>
.sidebar-create {
  overflow: hidden;
}

/* 顶部输入行：裸 input，无边框，右侧 × 关闭按钮 */
.sidebar-create__input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 12px;
}

.sidebar-create__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  line-height: 1.4;
  min-width: 0;
}

.sidebar-create__input::placeholder {
  color: var(--jt-text-tertiary);
}

.sidebar-create__close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.sidebar-create__close:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

/* 分割线 */
.sidebar-create__divider {
  height: 1px;
  background: var(--jt-border);
  margin: 0 16px;
}

/* 属性行：trigger + 右侧提示 */
.sidebar-create__attrs {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  padding: 10px 16px 12px;
}

.sidebar-create__spacer {
  flex: 1;
}

/* 通用 trigger —— 与 QuickAdd 一致：hover 才显背景 */
.sidebar-create__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--jt-text-secondary);
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.sidebar-create__trigger:hover,
.sidebar-create__trigger[aria-expanded="true"] {
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

/* 颜色 trigger 内的色点 */
.sidebar-create__color-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}

/* 颜色 trigger 容器：hover 整个区域浮出色板 */
.sidebar-create__color-host {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* 色板浮层：在 popper 内（fixed + z 9999）渲染，自身是有 shadow 的小卡片 */
.sidebar-create__color-picker {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 10px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
  white-space: nowrap;
  align-items: center;
}

.sidebar-create__color-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease;
  flex-shrink: 0;
}

.sidebar-create__color-swatch:hover {
  transform: scale(1.15);
}

.sidebar-create__color-swatch--active {
  border-color: var(--jt-text-primary);
  transform: scale(1.15);
}

/* 色板淡入淡出 */
.color-pop-enter-active,
.color-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.color-pop-enter-from,
.color-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 目录 trigger 容器：展开后下方 inline 展示 a-auto-complete 输入（已改为 TeleportPopper，
   这里只保留 host 位置设置，popup 在 TeleportPopper 内部渲染） */
.sidebar-create__folder-host {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* 目录输入弹层：TeleportPopper 内部卡片（不再 absolute，popper 已 fixed 定位） */
.sidebar-create__folder-popup {
  min-width: 240px;
  padding: 6px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
}

/* 已有目录列表 */
.sidebar-create__folder-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}

.sidebar-create__folder-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--jt-text-primary);
  font-family: var(--font-body);
  font-size: 13px;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.sidebar-create__folder-item :deep(.arco-icon) {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}

.sidebar-create__folder-item:hover {
  background-color: var(--jt-surface-hover);
}

.sidebar-create__folder-item--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

.sidebar-create__folder-item--active :deep(.arco-icon) {
  color: var(--jt-primary);
}

.sidebar-create__folder-empty {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  text-align: center;
}

/* 分隔线 + 新建输入 */
.sidebar-create__folder-divider {
  height: 1px;
  background: var(--jt-border);
  margin: 4px 2px;
}

.sidebar-create__folder-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--jt-text-primary);
  padding: 6px 8px;
  border-radius: 4px;
}

.sidebar-create__folder-input::placeholder {
  color: var(--jt-text-tertiary);
}

.sidebar-create__folder-input:focus {
  background-color: var(--jt-surface-hover);
}

/* 右侧提示文字 */
.sidebar-create__hint {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}
</style>

<!-- 弹窗全局：去掉 arco 默认标题栏 + 圆角 + 内边距 -->
<style>
.sidebar-create-modal .arco-modal-header {
  display: none;
}
.sidebar-create-modal .arco-modal-body {
  padding: 0;
}
.sidebar-create-modal .arco-modal {
  border-radius: 12px;
  overflow: hidden;
}
</style>
