<script setup lang="ts">
// 侧边栏 —— 四区块导航（智能视图 / 清单 / 标签 / 习惯）
import { computed, onMounted, reactive, ref } from "vue";
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
} from "@arco-design/web-vue/es/icon";
// IconEdit 移到 SidebarListNode 中使用
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { useTaskStore } from "@/stores/task";
import SidebarListNode from "./SidebarListNode.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
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

/** 自定义过滤：输入值是完整路径的前缀或片段时命中 */
function folderFilterOption(inputValue: string, option: any) {
  if (!inputValue) return true;
  const v = String(option.value ?? "").toLowerCase();
  const i = inputValue.toLowerCase();
  return v.includes(i) || i.includes(v);
}

/** 选中自动补全项时回填到输入框 */
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
      </div>
      <router-link
        v-show="!sectionCollapsed.habits"
        to="/habits"
        class="sidebar__item"
        :class="{ 'sidebar__item--active': activeRouteName === 'habits' }"
      >
        <icon-trophy :size="16" class="sidebar__item-icon" />
        <span class="sidebar__item-title">习惯打卡</span>
      </router-link>
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

  <!-- 新建清单弹窗 -->
  <a-modal
    v-model:visible="showCreateDialog"
    :width="400"
    title="新建清单"
  >
    <div class="create-list-dialog__field">
      <label class="create-list-dialog__label">清单名称</label>
      <a-input
        v-model="newListName"
        placeholder="清单名称"
        @keydown.enter="confirmNewList"
      />
    </div>
    <div class="create-list-dialog__field">
      <label class="create-list-dialog__label">目录（可选，支持 A/B 多级）</label>
      <a-auto-complete
        v-model="newListFolder"
        :data="folderSuggestions"
        :filter-option="folderFilterOption"
        placeholder="如：工作/项目A"
        allow-clear
        @select="onFolderSelect"
      >
        <template #option="{ data }">
          <span class="create-list-dialog__folder-suggestion">
            <icon-folder :size="13" />
            <span>{{ data.raw?.name ?? data.value }}</span>
          </span>
        </template>
      </a-auto-complete>
    </div>
    <div class="create-list-dialog__colors">
      <span class="create-list-dialog__label">颜色</span>
      <div class="create-list-dialog__color-row">
        <button
          v-for="c in LIST_COLORS"
          :key="c"
          class="create-list-dialog__color"
          :class="{ 'create-list-dialog__color--active': selectedColor === c }"
          :style="{ backgroundColor: c }"
          @click="selectedColor = c"
        />
      </div>
    </div>
    <template #footer>
      <a-button type="text" @click="showCreateDialog = false">取消</a-button>
      <a-button type="primary" @click="confirmNewList">创建</a-button>
    </template>
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

/* 标签拖拽悬停时显示蓝色描边（视觉提示落点） */
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
