<script setup lang="ts">
// 三栏布局骨架：侧边栏 + 任务列表区 + 任务详情面板
// 集成全局搜索、快速添加、快捷键、键盘导航
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useTheme } from "@/composables/useTheme";
import { useTaskStore } from "@/stores/task";
import { useRoute } from "vue-router";
import { SORT_FIELDS, SORT_FIELD_LABELS, type SortField } from "@/types";
import TheSidebar from "@/components/TheSidebar.vue";
import TaskDetailPanel from "@/components/TaskDetailPanel.vue";
import SearchPalette from "@/components/SearchPalette.vue";
import QuickAddDialog from "@/components/QuickAddDialog.vue";
import { useSearchStore } from "@/stores/search";
import { useListStore } from "@/stores/list";
import { useShortcuts } from "@/composables/useShortcuts";

const { isDark, toggleTheme } = useTheme();
const searchStore = useSearchStore();
const listStore = useListStore();
const taskStore = useTaskStore();
const route = useRoute();

const quickAddOpen = ref(false);
const sidebarCollapsed = ref(false);
const panelWidth = ref(360);

/** 是否显示排序按钮（清单/标签/全部视图） */
const showSortButton = computed(() => {
  return (
    route.name === "list" ||
    route.name === "tag" ||
    route.name === "all"
  );
});

/** 详情面板打开时，主区域右侧留出面板宽度的空间 */
const mainStyle = computed(() => {
  if (!taskStore.detailOpen) return { paddingRight: "0px" };
  return { paddingRight: panelWidth.value + "px" };
});

/** 详情面板打开时，topbar 整体向右推一个面板宽度（不重叠） */
const topbarStyle = computed(() => {
  if (!taskStore.detailOpen) return {};
  return { right: `${panelWidth.value + 24}px` };
});

/** 排序变更（a-doption + Arco dropdown 默认 hideOnSelect=true 自动关闭） */
async function onSortChange(field: SortField) {
  await taskStore.setSort(field);
}

// ─── 删除确认对话框 ──────────────────────────────────────
const deleteConfirmId = ref<string | null>(null);
const deleteConfirmTitle = computed(() => {
  if (!deleteConfirmId.value) return "";
  // 在所有当前任务（含已完成）里查找，避免已完成任务标题找不到
  const t = taskStore.currentTasks.find((task) => task.id === deleteConfirmId.value);
  return t?.title ?? "";
});

function requestDelete(taskId: string) {
  deleteConfirmId.value = taskId;
}

async function confirmDelete() {
  if (!deleteConfirmId.value) return;
  const deletedId = deleteConfirmId.value;
  // 先把焦点移到下一个任务（如果存在），避免删除后焦点丢失
  taskStore.moveFocus("down");
  await taskStore.deleteTask(deletedId);
  deleteConfirmId.value = null;
}

function cancelDelete() {
  deleteConfirmId.value = null;
}

// ─── 键盘导航 ────────────────────────────────────────────
function onNavigationKeydown(e: KeyboardEvent) {
  // 0. 上下文守卫：搜索/快速添加/删除确认对话框打开时不处理
  if (searchStore.open || quickAddOpen.value || deleteConfirmId.value) return;

  // 1. 输入框/文本域/contentEditable 聚焦时不处理（让位给输入）
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      (active as HTMLElement).isContentEditable)
  ) {
    // 特例：输入框聚焦时按 ESC，先 blur 而不是关闭详情面板
    if (e.key === "Escape") {
      (active as HTMLElement).blur();
      e.preventDefault();
    }
    return;
  }

  // 2. ESC：关闭详情面板
  if (e.key === "Escape") {
    if (taskStore.detailOpen) {
      e.preventDefault();
      taskStore.selectTask(null);
    }
    return;
  }

  // 3. 方向键导航（不需要焦点任务也能触发，首次按 ↓/↓ 会聚焦第一个/最后一个）
  if (e.key === "ArrowDown") {
    e.preventDefault();
    taskStore.moveFocus("down");
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    taskStore.moveFocus("up");
    return;
  }

  // 4. 仅在有焦点任务时处理后续操作
  const focusedId = taskStore.focusedTaskId;
  if (!focusedId) return;

  if (e.key === "Enter") {
    e.preventDefault();
    taskStore.selectTask(focusedId);
  } else if (e.key === " ") {
    e.preventDefault();
    const task = taskStore.openTasks.find((t) => t.id === focusedId);
    if (task) taskStore.toggleTask(focusedId, !task.done);
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    requestDelete(focusedId);
  }
}

onMounted(() => window.addEventListener("keydown", onNavigationKeydown));
onUnmounted(() => window.removeEventListener("keydown", onNavigationKeydown));

// 全局快捷键
useShortcuts({
  onSearch: () => {
    listStore.loadLists(); // 确保清单数据已加载（搜索结果要显示清单名）
    searchStore.show();
  },
  onQuickAdd: () => {
    listStore.loadLists();
    quickAddOpen.value = true;
  },
  onToggleTheme: toggleTheme,
});
</script>

<template>
  <div class="app-layout">
    <!-- 侧边栏（左） -->
    <TheSidebar v-model:collapsed="sidebarCollapsed" />

    <!-- 主区域（中） -->
    <main class="app-layout__main" :style="mainStyle">
      <div class="app-layout__topbar" :style="topbarStyle">
        <a-button
          type="text"
          size="small"
          @click="searchStore.show()"
        >
          <template #icon><icon-search :size="18" /></template>
        </a-button>
        <a-button
          type="text"
          size="small"
          @click="quickAddOpen = true"
        >
          <template #icon><icon-plus :size="20" /></template>
        </a-button>
        <div style="flex: 1"></div>
        <a-button
          type="text"
          size="small"
          @click="toggleTheme"
        >
          <template #icon>
            <icon-sun-fill v-if="isDark" :size="18" />
            <icon-moon-fill v-else :size="18" />
          </template>
        </a-button>
        <!-- 排序按钮（仅清单/标签/全部视图显示） -->
        <a-dropdown
          v-if="showSortButton"
          trigger="click"
          position="br"
          unmount-on-close
          @select="(key: any) => onSortChange(String(key) as SortField)"
        >
          <a-button
            type="text"
            size="small"
            :title="`排序: ${SORT_FIELD_LABELS[taskStore.currentSort.field]}`"
          >
            <template #icon><icon-sort :size="18" /></template>
          </a-button>
          <template #content>
            <a-doption
              v-for="f in SORT_FIELDS"
              :key="f.value"
              :value="f.value"
              class="sort-menu__item"
              :class="{ 'sort-menu__item--active': f.value === taskStore.currentSort.field }"
            >
              <icon-check
                v-if="f.value === taskStore.currentSort.field"
                :size="14"
              />
              <span
                v-else
                class="sort-menu__placeholder"
                aria-hidden="true"
              />
              <span>{{ f.label }}</span>
            </a-doption>
          </template>
        </a-dropdown>
      </div>

      <router-view />
    </main>

    <!-- 任务详情面板（右） -->
    <TaskDetailPanel v-model:panel-width="panelWidth" />

    <!-- 全局搜索面板 -->
    <SearchPalette />

    <!-- 快速添加对话框 -->
    <QuickAddDialog v-model="quickAddOpen" />

    <!-- 删除任务确认对话框（键盘 Backspace 触发） -->
    <a-modal
      :visible="!!deleteConfirmId"
      :width="400"
      @cancel="cancelDelete"
      @ok="confirmDelete"
    >
      <template #title>确认删除</template>
      <p>确定要删除任务「<strong>{{ deleteConfirmTitle }}</strong>」吗？</p>
      <template #footer>
        <a-button @click="cancelDelete">取消</a-button>
        <a-button status="danger" type="primary" @click="confirmDelete">删除</a-button>
      </template>
    </a-modal>
  </div>
</template>

<!-- 排序下拉菜单（非 scoped，因为 popup 渲染到 body） -->
<style>
/* 排序 dropdown popup 容器：去掉内层 padding */
.arco-dropdown-popup .arco-dropdown-group {
  padding: 0 !important;
  margin: 0 !important;
}

/* doption 项（li）去掉默认 padding/margin */
.sort-menu__item {
  padding: 0 !important;
  margin: 0 !important;
  min-width: 140px !important;
  min-height: 32px !important;
}

/* 选中项的底色 */
.sort-menu__item--active {
  background-color: var(--jt-accent-soft) !important;
  color: var(--jt-primary) !important;
}

/* doption 内部内容容器：grid 两列对齐 */
.sort-menu__item .arco-dropdown-option-content {
  display: grid !important;
  grid-template-columns: 18px 1fr !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 0 8px !important;
  width: 100% !important;
}

/* 占位元素 */
.sort-menu__placeholder {
  display: inline-block;
  width: 14px;
  height: 14px;
}
</style>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.app-layout__main {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  transition: padding-right 0.2s ease;
}

.app-layout__topbar {
  position: absolute;
  /* 和侧边栏的"智能视图/清单/标签/习惯"subheader 同一行，靠右 */
  top: 40px;
  right: 24px;
  height: 24px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
  transition: right 0.2s ease;
}

.app-layout__topbar > * {
  -webkit-app-region: no-drag;
}
</style>
