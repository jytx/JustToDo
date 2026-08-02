<script setup lang="ts">
// 三栏布局骨架：侧边栏 + 任务列表区 + 任务详情面板
// 集成全局搜索、快速添加、快捷键、键盘导航
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settings";
import { useTaskStore } from "@/stores/task";
import { useHabitStore } from "@/stores/habit";
import { useTemplateStore } from "@/stores/template";
import { useListScheduleStore } from "@/stores/listSchedule";
import { useRoute } from "vue-router";
import { SORT_FIELDS, SORT_FIELD_LABELS, type SortField } from "@/types";
import AppRail from "@/components/AppRail.vue";
import TheSidebar from "@/components/TheSidebar.vue";
import TaskDetailPanel from "@/components/TaskDetailPanel.vue";
import SearchPalette from "@/components/SearchPalette.vue";
import QuickAddDialog from "@/components/QuickAddDialog.vue";
import AiAssistantModal from "@/components/AiAssistantModal.vue";
import MenuPopover from "@/components/MenuPopover.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { useSearchStore } from "@/stores/search";
import { useListStore } from "@/stores/list";
import { useGroupStore } from "@/stores/group";
import { useKanbanStore } from "@/stores/kanban";
import { useShortcuts } from "@/composables/useShortcuts";
import { useQuickAdd } from "@/composables/useQuickAdd";

const { isDark } = useTheme();
const settingsStore = useSettingsStore();
const searchStore = useSearchStore();
const listStore = useListStore();
const groupStore = useGroupStore();
const kanbanStore = useKanbanStore();
const taskStore = useTaskStore();
const habitStore = useHabitStore();
const templateStore = useTemplateStore();
const listScheduleStore = useListScheduleStore();
const route = useRoute();
const quickAdd = useQuickAdd();

const sidebarCollapsed = ref(false);
/** 侧边栏宽度（仅展开态生效；收起态固定 48px） */
const sidebarWidth = ref(240);
const panelWidth = ref(480);

/** 打开 AI 助手弹窗（顶栏/快捷键入口，默认每日小结）。 */
function openSummary(): void {
  taskStore.aiSelectedTool = "daily";
  taskStore.aiAssistantVisible = true;
}

/** 侧边栏清单/目录 AI 总结入口：设默认工具为「总结当前清单」+ 设置 scope */
function onAiSummary(scope: import("@/api/ai").SummaryScope): void {
  taskStore.aiSelectedTool = scope.type === "tasks" ? "tasks" : "list";
  taskStore.pendingSummaryScope = scope;
  taskStore.aiAssistantVisible = true;
}

/** 是否显示排序按钮（清单/笔记本/标签/全部视图） */
const showSortButton = computed(() => {
  return (
    route.name === "list" ||
    route.name === "notebook" ||
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
 * （日历/习惯/设置 都让 TheSidebar 隐藏，让主区域占满宽度）
 * notebook（笔记本视图）属于任务族，侧边栏需常驻 */
const showTaskSidebar = computed(() => {
  const name = route.name as string;
  return (
    name === "today" ||
    name === "upcoming" ||
    name === "all" ||
    name === "list" ||
    name === "notebook" ||
    name === "tag" ||
    name === "kanban"
  );
});

/** 是否日历视图（周/月/年）。
 * 日历视图下，TaskDetailPanel 改为右侧悬浮 drawer（盖在日历之上），
 * 所以不需要把主区域 / topbar 向右缩进让位。
 * 任务类视图（today/upcoming/all/list/tag）保持原行为：让位让出 360px。 */
const isCalendarView = computed<boolean>(() => {
  const name = route.name as string;
  return name === "week" || name === "month" || name === "year";
});

/**
 * 路由切换时关闭任务详情面板
 *
 * 仅当切到非任务族视图（日历/习惯/设置）时关闭；
 * 任务族内部切换（today → list → tag 等）保留选中态，方便用户跨视图操作。
 */
watch(showTaskSidebar, (isTaskView) => {
  if (!isTaskView && taskStore.selectedTaskId) {
    taskStore.selectTask(null);
  }
});

/** 详情面板打开时，主区域右侧留出面板宽度的空间（日历视图除外，悬浮不缩进） */
const mainStyle = computed(() => {
  if (!taskStore.detailOpen || isCalendarView.value) return { paddingRight: "0px" };
  return { paddingRight: panelWidth.value + "px" };
});

/** 详情面板打开时，topbar 整体向右推一个面板宽度（日历视图除外，悬浮不缩进） */
const topbarStyle = computed(() => {
  if (!taskStore.detailOpen || isCalendarView.value) return {};
  return { right: `${panelWidth.value + 24}px` };
});

/** 排序菜单开关 */
const sortMenuOpen = ref(false);

/** 排序变更（选择后关闭菜单） */
async function onSortChange(field: SortField) {
  await taskStore.setSort(field);
  sortMenuOpen.value = false;
}

/** 新建分组对话框（顶栏入口，仅清单视图显示） */
const newGroupVisible = ref(false);
const newGroupName = ref("");

/** 打开新建分组对话框 */
function openNewGroup(): void {
  newGroupName.value = "";
  newGroupVisible.value = true;
}

/** 确认新建分组：用当前清单 id 创建，追加到末尾 */
async function confirmNewGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  const listId = route.params.id as string;
  if (!listId) return;
  await groupStore.createGroup(listId, name);
  newGroupName.value = "";
  newGroupVisible.value = false;
}

/** 删除确认对话框标题
 *  必须用 findTaskById 在全部数据副本（currentTasks / subtasks / subtaskCache /
 *  selectedTask）里查，否则删除子任务时 currentTasks 取不到，标题会显示为空。 */
const deleteConfirmTitle = computed(() => {
  if (!taskStore.pendingDeleteId) return "";
  return taskStore.findTaskById(taskStore.pendingDeleteId)?.title ?? "";
});

/** 删除确认对话框显示状态（双向绑定到 store.pendingDeleteId） */
const deleteModalVisible = computed({
  get: () => !!taskStore.pendingDeleteId,
  set: (v: boolean) => {
    if (!v) taskStore.cancelDelete();
  },
});

/** 批量删除确认对话框显示状态（双向绑定到 store.pendingBatchDeleteIds） */
const batchDeleteModalVisible = computed({
  get: () => !!taskStore.pendingBatchDeleteIds,
  set: (v: boolean) => {
    if (!v) taskStore.cancelBatchDelete();
  },
});

/** 批量删除待确认数量（标题显示用） */
const batchDeleteCount = computed(() => taskStore.pendingBatchDeleteIds?.length ?? 0);

// ─── 键盘导航 ────────────────────────────────────────────
function onNavigationKeydown(e: KeyboardEvent) {
  // 0. 上下文守卫：搜索/快速添加/删除确认对话框（含批量）打开时不处理
  if (searchStore.open || quickAdd.visible.value || taskStore.pendingDeleteId || taskStore.pendingBatchDeleteIds) return;

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

  // 2. ESC：退出多选 / 关闭详情面板
  //    多选模式激活时优先退出多选（不关详情面板），语义上「逐层关闭」。
  //    若详情面板内有任意浮层（chip 浮窗 / 菜单 / 确认弹窗）打开，
  //    先让浮层自己关（逐层关闭语义），本轮不关详情面板。
  //    （右键菜单、附件预览不在详情面板内，由各自捕获监听器 stopImmediatePropagation 拦截）
  if (e.key === "Escape") {
    // 多选模式激活：Esc 优先退出多选
    if (taskStore.batchMode) {
      e.preventDefault();
      taskStore.exitBatchMode();
      return;
    }
    if (taskStore.hasDetailOverlay) {
      e.preventDefault();
      return;
    }
    if (taskStore.detailOpen) {
      e.preventDefault();
      taskStore.selectTask(null);
    }
    return;
  }

  // 2.5 Cmd/Ctrl+A：全选当前视图未完成任务（仅任务族视图）
  //     !shiftKey 避开已占用的 Cmd+Shift+A（快速添加）
  //     放在输入框守卫之后，输入框内 Cmd+A 走浏览器原生全选文本
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "a" || e.key === "A")) {
    if (showTaskSidebar.value) {
      e.preventDefault();
      taskStore.selectAllBatch();
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
  // 预加载模板列表（设置页模板 section 直接读 store）
  templateStore.loadTemplates().catch((e) => {
    console.error("[AppLayout] 预加载 templates 失败:", e);
  });
  // 预加载清单生成计划列表（设置页「清单生成计划」section 直接读 store）
  listScheduleStore.loadSchedules().catch((e) => {
    console.error("[AppLayout] 预加载 list schedules 失败:", e);
  });
  // 预加载清单列表（模板 section 的「默认清单」下拉、搜索结果等都依赖；
  // 之前是各 ListView/SmartView onMounted 时 lazy 加载，用户直达设置页时会空）
  listStore.loadLists().catch((e) => {
    console.error("[AppLayout] 预加载 lists 失败:", e);
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
  onDailySummary: () => {
    openSummary();
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
    <TheSidebar
      v-if="showTaskSidebar"
      v-model:collapsed="sidebarCollapsed"
      v-model:width="sidebarWidth"
      @ai-summary="onAiSummary"
    />

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
        <!-- AI 每日小结（仅 AI 启用时显示） -->
        <a-button
          v-if="showGlobalActions && settingsStore.aiEnabled"
          type="text"
          size="small"
          title="AI 小结 (Cmd+Shift+D)"
          @click="openSummary()"
        >
          <template #icon><icon-robot :size="18" /></template>
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
        <!-- 新建分组按钮（仅清单视图显示，紧随排序按钮） -->
        <a-button
          v-if="route.name === 'list'"
          type="text"
          size="small"
          title="新建分组"
          @click="openNewGroup"
        >
          <template #icon><icon-folder :size="18" /></template>
        </a-button>
        <!-- 看板列维度切换器（仅看板视图显示：优先级 / 分组） -->
        <a-radio-group
          v-if="route.name === 'kanban'"
          :model-value="kanbanStore.mode"
          type="button"
          size="small"
          @change="(v: string | number | boolean) => kanbanStore.setMode(v as 'priority' | 'group')"
        >
          <a-radio value="priority">优先级</a-radio>
          <a-radio value="group">分组</a-radio>
        </a-radio-group>
      </div>

      <router-view />
    </main>

    <!-- AI 总结全局 loading 遮罩（预检/生成期间显示） -->
    <div v-if="taskStore.aiLoading" class="ai-loading-overlay">
      <a-spin :size="32" />
      <span class="ai-loading-overlay__text">AI 正在分析...</span>
    </div>

    <!-- 任务详情面板（右） -->
    <TaskDetailPanel v-model:panel-width="panelWidth" />

    <!-- 全局搜索面板 -->
    <SearchPalette />

    <!-- 快速添加对话框 -->
    <QuickAddDialog
      :model-value="quickAdd.visible.value"
      :default-list-id="quickAdd.defaultListId.value ?? undefined"
      :default-start="quickAdd.defaultStart.value"
      :default-end="quickAdd.defaultEnd.value"
      @update:model-value="quickAdd.close()"
    />

    <!-- AI 助手弹窗（统一入口） -->
    <AiAssistantModal v-model:visible="taskStore.aiAssistantVisible" />

    <!-- 删除任务确认对话框（键盘 Backspace 或任务项菜单触发，统一极简卡片风） -->
    <ConfirmDialog
      v-model:visible="deleteModalVisible"
      :mask-closable="false"
      @cancel="taskStore.cancelDelete()"
      @confirm="taskStore.confirmDelete()"
    >
      <template #title>删除任务「<strong>{{ deleteConfirmTitle }}</strong>」？</template>
    </ConfirmDialog>

    <!-- 批量删除确认对话框（多选批量菜单触发，显示数量） -->
    <ConfirmDialog
      v-model:visible="batchDeleteModalVisible"
      :mask-closable="false"
      @cancel="taskStore.cancelBatchDelete()"
      @confirm="taskStore.confirmBatchDelete()"
    >
      <template #title>删除选中的 <strong>{{ batchDeleteCount }}</strong> 个任务？</template>
    </ConfirmDialog>

    <!-- 新建分组对话框（顶栏排序按钮后的入口） -->
    <a-modal
      :visible="newGroupVisible"
      :width="360"
      :footer="false"
      :mask-closable="true"
      @update:visible="(v: boolean) => { newGroupVisible = v; }"
    >
      <template #title>新建分组</template>
      <div class="app-layout__dialog">
        <a-input
          v-model="newGroupName"
          placeholder="分组名称"
          allow-clear
          @keydown.enter="confirmNewGroup"
        />
        <div class="app-layout__dialog-actions">
          <a-button size="small" @click="newGroupVisible = false">取消</a-button>
          <a-button type="primary" size="small" @click="confirmNewGroup">创建</a-button>
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

/* AI 总结全局 loading 遮罩：半透明覆盖全屏，居中 spin + 文案 */
.ai-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background-color: rgba(0, 0, 0, 0.25);
  z-index: 9999;
}

.ai-loading-overlay__text {
  font-size: 13px;
  color: var(--jt-text-secondary);
}

/* 新建分组对话框（与 ListView 的分组对话框样式一致） */
.app-layout__dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}
.app-layout__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
