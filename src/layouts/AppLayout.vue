<script setup lang="ts">
// 三栏布局骨架：侧边栏 + 任务列表区 + 任务详情面板
// 集成全局搜索、快速添加、快捷键、键盘导航
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settings";
import { useTaskStore } from "@/stores/task";
import { useHabitStore } from "@/stores/habit";
import { useRoute } from "vue-router";
import { SORT_FIELDS, SORT_FIELD_LABELS, type SortField } from "@/types";
import AppRail from "@/components/AppRail.vue";
import TheSidebar from "@/components/TheSidebar.vue";
import TaskDetailPanel from "@/components/TaskDetailPanel.vue";
import SearchPalette from "@/components/SearchPalette.vue";
import QuickAddDialog from "@/components/QuickAddDialog.vue";
import MenuPopover from "@/components/MenuPopover.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import { useSearchStore } from "@/stores/search";
import { useListStore } from "@/stores/list";
import { useShortcuts } from "@/composables/useShortcuts";
import { useQuickAdd } from "@/composables/useQuickAdd";

const { isDark } = useTheme();
const settingsStore = useSettingsStore();
const searchStore = useSearchStore();
const listStore = useListStore();
const taskStore = useTaskStore();
const habitStore = useHabitStore();
const route = useRoute();
const quickAdd = useQuickAdd();

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

/** 是否显示搜索 + 新建任务按钮（习惯/设置/日历视图不显示） */
const showGlobalActions = computed(() => {
  const name = route.name as string;
  return name !== "habits" && name !== "settings" && name !== "week" && name !== "month" && name !== "year";
});

/** TheSidebar 只在 AppRail 选中"任务"族路由时显示
 * （日历/习惯/设置 都让 TheSidebar 隐藏，让主区域占满宽度） */
const showTaskSidebar = computed(() => {
  const name = route.name as string;
  return (
    name === "today" ||
    name === "upcoming" ||
    name === "all" ||
    name === "list" ||
    name === "tag"
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

/** 排序菜单开关 */
const sortMenuOpen = ref(false);

/** 排序变更（选择后关闭菜单） */
async function onSortChange(field: SortField) {
  await taskStore.setSort(field);
  sortMenuOpen.value = false;
}

/** 删除确认对话框标题 */
const deleteConfirmTitle = computed(() => {
  if (!taskStore.pendingDeleteId) return "";
  const t = taskStore.currentTasks.find((task) => task.id === taskStore.pendingDeleteId);
  return t?.title ?? "";
});

/** 删除确认对话框显示状态（双向绑定到 store.pendingDeleteId） */
const deleteModalVisible = computed({
  get: () => !!taskStore.pendingDeleteId,
  set: (v: boolean) => {
    if (!v) taskStore.cancelDelete();
  },
});

// ─── 键盘导航 ────────────────────────────────────────────
function onNavigationKeydown(e: KeyboardEvent) {
  // 0. 上下文守卫：搜索/快速添加/删除确认对话框打开时不处理
  if (searchStore.open || quickAdd.visible.value || taskStore.pendingDeleteId) return;

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
    taskStore.requestDelete(focusedId);
  }
}

onMounted(() => {
  window.addEventListener("keydown", onNavigationKeydown);
  // 应用启动时预加载习惯列表（避免进入 /habits 时空骨架）
  // HabitView 自身 mount 时会再 load 一次（重复但幂等，后端 getHabits 成本低）
  habitStore.loadHabits().catch((e) => {
    console.error("[AppLayout] 预加载 habits 失败:", e);
  });
});
onUnmounted(() => window.removeEventListener("keydown", onNavigationKeydown));

// 全局快捷键
useShortcuts({
  onSearch: () => {
    listStore.loadLists(); // 确保清单数据已加载（搜索结果要显示清单名）
    searchStore.show();
  },
  onQuickAdd: () => {
    listStore.loadLists();
    quickAdd.open();
  },
  onNewTask: () => {
    listStore.loadLists();
    quickAdd.open();
  },
  onToggleTheme: () => {
    settingsStore.cycleTheme();
  },
  onZoomIn: () => settingsStore.zoomIn(),
  onZoomOut: () => settingsStore.zoomOut(),
  onZoomReset: () => settingsStore.zoomReset(),
});
</script>

<template>
  <div class="app-layout">
    <!-- 最左侧：应用切换栏（任务 / 习惯 / 设置） -->
    <AppRail />

    <!-- 侧边栏（左）—— 仅在 AppRail 选中"任务"时显示 -->
    <TheSidebar v-if="showTaskSidebar" v-model:collapsed="sidebarCollapsed" />

    <!-- 主区域（中） -->
    <main class="app-layout__main" :style="mainStyle">
      <div class="app-layout__topbar" :style="topbarStyle">
        <a-button
          v-if="showGlobalActions"
          type="text"
          size="small"
          @click="searchStore.show()"
        >
          <template #icon><icon-search :size="18" /></template>
        </a-button>
        <a-button
          v-if="showGlobalActions"
          type="text"
          size="small"
          @click="quickAdd.open()"
        >
          <template #icon><icon-plus :size="20" /></template>
        </a-button>
        <div style="flex: 1"></div>
        <a-button
          v-if="showGlobalActions"
          type="text"
          size="small"
          @click="settingsStore.cycleTheme()"
        >
          <template #icon>
            <icon-sun-fill v-if="isDark" :size="18" />
            <icon-moon-fill v-else :size="18" />
          </template>
        </a-button>
        <!-- 排序按钮（仅清单/标签/全部视图显示） -->
        <MenuPopover v-if="showSortButton" v-model:visible="sortMenuOpen">
          <template #trigger>
            <a-button
              type="text"
              size="small"
              :title="`排序: ${SORT_FIELD_LABELS[taskStore.currentSort.field]}`"
              @click="sortMenuOpen = !sortMenuOpen"
            >
              <template #icon><icon-sort :size="18" /></template>
            </a-button>
          </template>
          <MenuPopoverItem
            v-for="f in SORT_FIELDS"
            :key="f.value"
            :active="f.value === taskStore.currentSort.field"
            @click="onSortChange(f.value)"
          >
            <span>{{ f.label }}</span>
          </MenuPopoverItem>
        </MenuPopover>
      </div>

      <router-view />
    </main>

    <!-- 任务详情面板（右） -->
    <TaskDetailPanel v-model:panel-width="panelWidth" />

    <!-- 全局搜索面板 -->
    <SearchPalette />

    <!-- 快速添加对话框 -->
    <QuickAddDialog
      :model-value="quickAdd.visible.value"
      :default-list-id="quickAdd.defaultListId.value ?? undefined"
      @update:model-value="quickAdd.close()"
    />

    <!-- 删除任务确认对话框（键盘 Backspace 或任务项菜单触发，极简卡片风） -->
    <a-modal
      v-model:visible="deleteModalVisible"
      :width="400"
      :footer="false"
      :mask-closable="false"
      :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
      modal-class="confirm-dialog-modal"
    >
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">
          <span class="confirm-dialog__icon"><icon-exclamation-circle :size="16" /></span>
          <span>删除任务「<strong>{{ deleteConfirmTitle }}</strong>」？</span>
        </div>
        <p class="confirm-dialog__desc">此操作无法撤销。</p>
        <div class="confirm-dialog__footer">
          <a-button @click="taskStore.cancelDelete()">取消</a-button>
          <a-button status="danger" type="primary" @click="taskStore.confirmDelete()">删除</a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

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
