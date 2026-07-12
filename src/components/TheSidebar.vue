<script setup lang="ts">
// 侧边栏 —— 四区块导航（智能视图 / 清单 / 标签 / 习惯）
import { computed, onMounted, ref, nextTick } from "vue";
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
  IconEdit,
  IconMore,
  IconMenuFold,
  IconMenuUnfold,
  IconRight,
  IconDown,
} from "@arco-design/web-vue/es/icon";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { useTaskStore } from "@/stores/task";
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

async function startEditList(list: { id: string; name: string; color: string }) {
  if (list.id === "inbox") return; // 收件箱不可改
  editingList.value = { id: list.id, name: list.name, color: list.color };
  editListName.value = list.name;
  editListColor.value = list.color;
  await nextTick();
  const input = document.querySelector<HTMLInputElement>('.sidebar__edit-inline .sidebar__edit-input');
  input?.focus();
}

async function saveListEdit() {
  if (!editingList.value) return;
  const name = editListName.value.trim();
  if (!name) {
    editingList.value = null;
    return;
  }
  await db.renameList(editingList.value.id, name, editListColor.value);
  await listStore.loadLists();
  editingList.value = null;
}

function cancelListEdit() {
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
  confirmDelete.value = {
    type: "tag",
    id: tag.id,
    name: tag.name,
    taskCount: 0, // 不查了，删除标签不会删除任务
  };
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

/** 新建清单输入框 */
const showNewListInput = ref(false);
const newListName = ref("");
const newListInputRef = ref<HTMLInputElement | null>(null);

/** 8 种预定义颜色 */
const LIST_COLORS = [
  '#EF4444', '#F59E0B', '#EAB308', '#10B981',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280',
];
const selectedColor = ref('#10B981');

async function startNewList() {
  showNewListInput.value = true;
  await nextTick();
  newListInputRef.value?.focus();
}

async function confirmNewList() {
  const name = newListName.value.trim();
  if (!name) {
    showNewListInput.value = false;
    return;
  }
  await listStore.createList(name, selectedColor.value);
  newListName.value = '';
  selectedColor.value = '#10B981';
  showNewListInput.value = false;
}

function cancelNewList() {
  showNewListInput.value = false;
  newListName.value = '';
}

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
      <span v-if="!collapsed" class="sidebar__brand">JustToDo</span>
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
        <a-button size="mini" type="text" @click.stop="startNewList">
          <template #icon><icon-plus :size="16" /></template>
        </a-button>
      </div>

      <!-- 新建清单输入框 -->
      <div v-if="showNewListInput" v-show="!sectionCollapsed.lists" class="sidebar__new-list">
        <input
          ref="newListInputRef"
          v-model="newListName"
          @keydown.enter="confirmNewList"
          @keydown.escape="cancelNewList"
          placeholder="清单名称..."
          class="sidebar__new-list-input"
        />
        <div class="sidebar__new-list-colors">
          <button
            v-for="c in LIST_COLORS"
            :key="c"
            class="sidebar__new-list-color"
            :class="{ 'sidebar__new-list-color--active': selectedColor === c }"
            :style="{ backgroundColor: c }"
            @click="selectedColor = c"
          />
        </div>
        <div class="sidebar__new-list-actions">
          <a-button size="mini" type="text" @click="cancelNewList">取消</a-button>
          <a-button size="mini" type="primary" @click="confirmNewList">创建</a-button>
        </div>
      </div>
      <template v-for="list in listStore.sortedLists" :key="list.id">
        <!-- 编辑模式：当前行直接变成编辑表单 -->
        <div v-if="editingList?.id === list.id" v-show="!sectionCollapsed.lists" class="sidebar__edit-inline">
          <span
            class="sidebar__list-dot"
            :style="{ backgroundColor: editListColor }"
          />
          <input
            v-model="editListName"
            @keydown.enter="saveListEdit"
            @keydown.escape="cancelListEdit"
            placeholder="清单名称"
            class="sidebar__edit-input"
          />
          <div class="sidebar__edit-colors">
            <button
              v-for="c in LIST_COLORS"
              :key="c"
              class="sidebar__edit-color"
              :class="{ 'sidebar__edit-color--active': editListColor === c }"
              :style="{ backgroundColor: c }"
              @click="editListColor = c"
            />
          </div>
          <div class="sidebar__edit-actions">
            <a-button size="mini" type="text" @click="cancelListEdit">取消</a-button>
            <a-button size="mini" type="primary" @click="saveListEdit">保存</a-button>
          </div>
        </div>
        <!-- 正常模式 -->
        <router-link
          v-else
          v-show="!sectionCollapsed.lists"
          :to="`/list/${list.id}`"
          class="sidebar__item"
          :class="{ 'sidebar__item--active': activeListId === list.id }"
        >
          <span
            class="sidebar__list-dot"
            :style="{ backgroundColor: list.color }"
          />
          <span class="sidebar__item-title">{{ list.name }}</span>
          <span v-if="taskStore.listCounts[list.id]" class="sidebar__count">{{ taskStore.listCounts[list.id] }}</span>
          <!-- 操作菜单（收件箱不可改） -->
          <a-dropdown
            v-if="list.id !== 'inbox'"
            trigger="click"
            position="br"
            :popup-offset="4"
          >
            <button
              class="sidebar__item-menu-btn"
              @click.stop.prevent
              :title="`编辑 ${list.name}`"
            >
              <icon-more :size="16" />
            </button>
            <template #content>
              <a-menu class="sidebar-ctx-menu" @menu-item-click="(key: string) => key === 'edit' ? startEditList(list) : key === 'delete' ? askDeleteList(list) : undefined">
                <a-menu-item key="edit">
                  <icon-edit :size="15" />
                  <span style="margin-left: 8px">编辑清单</span>
                </a-menu-item>
                <a-menu-item key="delete" class="sidebar-ctx-menu--danger">
                  <icon-delete :size="15" />
                  <span style="margin-left: 8px">删除清单</span>
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </router-link>
      </template>

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
        :class="{ 'sidebar__item--active': activeRouteName === 'tag' && activeListId === tag.id }"
      >
        <icon-tag :size="16" class="sidebar__item-icon" />
        <span class="sidebar__item-title">{{ tag.name }}</span>
        <a-dropdown
          trigger="click"
          position="br"
          :popup-offset="4"
        >
          <button
            class="sidebar__item-menu-btn"
            @click.stop.prevent
            :title="`编辑 ${tag.name}`"
          >
            <icon-more :size="16" />
          </button>
          <template #content>
            <a-menu class="sidebar-ctx-menu" @menu-item-click="() => askDeleteTag(tag)">
              <a-menu-item key="delete" class="sidebar-ctx-menu--danger">
                <icon-delete :size="15" />
                <span style="margin-left: 8px">删除标签</span>
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
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
  justify-content: space-between;
  padding: 16px 12px 8px;
  gap: 4px;
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
  right: 4px;
  background: transparent;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
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

<!-- 侧边栏上下文菜单（非 scoped，弹层渲染到 body） -->
<style>
.sidebar-ctx-menu {
  min-width: 130px;
}

.sidebar-ctx-menu--danger {
  color: var(--jt-error) !important;
}

.sidebar-ctx-menu--danger .arco-icon {
  color: var(--jt-error);
}
</style>
