<script setup lang="ts">
// 三栏布局骨架：侧边栏 + 任务列表区 + 任务详情面板
// 集成全局搜索、快速添加、快捷键、键盘导航
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useTheme } from "@/composables/useTheme";
import { setupAgentDataSync } from "@/composables/useAgentDataSync";
import { useSettingsStore } from "@/stores/settings";
import { useTaskStore } from "@/stores/task";
import { useHabitStore } from "@/stores/habit";
import { useTemplateStore } from "@/stores/template";
import { useListScheduleStore } from "@/stores/listSchedule";
import { SETTINGS_KEYS } from "@/stores/settings";
import * as db from "@/api/db";
import { useRoute, useRouter } from "vue-router";
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
import { useListStore, type ListTreeNode } from "@/stores/list";
import { flattenActiveTree } from "@/composables/useListBatchSelect";
import { useGroupStore } from "@/stores/group";
import { useKanbanStore } from "@/stores/kanban";
import { setViewPref } from "@/composables/useViewPrefs";
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
const router = useRouter();
const quickAdd = useQuickAdd();

const sidebarCollapsed = ref(false);
/** 侧边栏宽度（仅展开态生效；收起态固定 48px） */
const sidebarWidth = ref(240);
const panelWidth = ref(480);
/** 详情面板全屏态（点击全屏图标切换，横向铺满视口盖住侧边栏+任务列表） */
const panelFullscreen = ref(false);

/** 详情面板宽度持久化：拖拽调整后防抖保存，下次打开保持 */
let panelWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
watch(panelWidth, (w) => {
  // 防抖 400ms：拖拽过程频繁变化，避免每次都写 SQLite
  if (panelWidthSaveTimer) clearTimeout(panelWidthSaveTimer);
  panelWidthSaveTimer = setTimeout(() => {
    db.setSetting(SETTINGS_KEYS.detailPanelWidth, String(w)).catch((e) =>
      console.error("[AppLayout] 保存详情面板宽度失败:", e),
    );
  }, 400);
});

/** 详情面板全屏态持久化：切换后立即保存 */
watch(panelFullscreen, (fs) => {
  db.setSetting(SETTINGS_KEYS.detailPanelFullscreen, fs ? "1" : "0").catch((e) =>
    console.error("[AppLayout] 保存详情面板全屏态失败:", e),
  );
});

/** 任务被清空（关闭面板 / 切视图）时自动退出全屏，
 *  避免全屏态下面板渲染 empty 占位铺满整个屏幕 */
watch(
  () => taskStore.selectedTaskId,
  (id) => {
    if (id === null) panelFullscreen.value = false;
  },
);

/**
 * 路由导航进行中强制隐藏详情面板。
 * 背景：切到日历/设置/习惯等非列表视图时，路由更新（含懒加载组件）有延迟，
 * 期间 TaskDetailPanel 仍按旧路由渲染 empty 占位，切换完成后才消失，
 * 形成「empty 闪一下」的视觉残留。在 router.beforeEach 提前隐藏面板，
 * 路由切换完成（afterEach）后恢复——此时新路由下 isFloatingView 已生效，
 * 非列表视图本就不渲染面板。
 */
const panelForceHidden = ref(false);
router.beforeEach((to) => {
  const name = to.name as string | undefined;
  const isTaskFamily =
    !!name &&
    (name === "today" ||
      name === "upcoming" ||
      name === "all" ||
      name === "list" ||
      name === "notebook" ||
      name === "tag");
  const view = to.query.view as string | undefined;
  const isListTarget = isTaskFamily && view !== "kanban" && view !== "timeline";
  // 目标不是列表视图：立即隐藏面板（列表内部切换保持）
  if (!isListTarget) panelForceHidden.value = true;
});
router.afterEach(() => {
  panelForceHidden.value = false;
});

/** 打开 AI 助手弹窗（顶栏/快捷键入口，默认每日小结）。 */
function openSummary(): void {
  taskStore.aiSelectedTool = "daily";
  taskStore.aiAgentOnly = false;
  taskStore.aiAssistantVisible = true;
}

/** 侧边栏清单/目录 AI 总结入口：设默认工具为「总结当前清单」+ 设置 scope */
function onAiSummary(scope: import("@/api/ai").SummaryScope): void {
  taskStore.aiSelectedTool = scope.type === "tasks" ? "tasks" : "list";
  taskStore.aiAgentOnly = false;
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
    name === "tag"
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

/** 清单视图切换类型（列表 / 看板 / 时间线）——读 query ?view= */
type ListView = "list" | "kanban" | "timeline";
/** 当前视图形态（看板/时间线被多处复用判断：是否悬浮详情面板等） */
const currentListView = computed<ListView>(() => {
  if (route.query.view === "kanban") return "kanban";
  if (route.query.view === "timeline") return "timeline";
  return "list";
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

/** 详情面板打开时，主区域右侧留出面板宽度的空间（悬浮视图除外，不缩进）。
 *  悬浮视图 = 日历(周/月/年) + 看板 + 时间线：这些视图内容宽幅/水平滚动，
 *  被挤压会变形，故详情面板改为右侧悬浮 drawer 盖在上面 */
const isFloatingPanelView = computed(() =>
  isCalendarView.value || currentListView.value === "kanban" || currentListView.value === "timeline",
);

/**
 * 从非悬浮视图（列表）切到悬浮视图（看板/时间线/日历）时清空选中任务。
 *
 * 任务族内部切换（today→list→tag 等）保留选中态，方便跨视图操作；
 * 但切到悬浮视图时，详情面板会变成盖在内容上的悬浮抽屉（901px 宽），
 * 若沿用列表里的选中态会大面积遮挡看板/时间线，体验突兀，故关闭。
 * 用户在看板里点任务仍可主动打开悬浮面板查看详情。
 */
watch(isFloatingPanelView, (floating) => {
  if (floating && taskStore.selectedTaskId) {
    taskStore.selectTask(null);
  }
});
/**
 * 主区域让位样式：直接在 computed 内显式读 route.name / route.query.view 强制
 * 响应式追踪，避免 HMR 后中间 computed 链（isFloatingPanelView）失效导致
 * paddingRight 残留。floating 视图显式返回 0px 让位宽度。
 */
const mainStyle = computed(() => {
  const name = route.name as string | undefined;
  const view = route.query.view as string | undefined;
  // 白名单：只有列表视图（任务族 + 非 kanban/timeline）才让出详情面板宽度；
  // 其余视图（日历/看板/时间线/设置/习惯）都是全屏，paddingRight=0
  const isTaskFamily =
    !!name &&
    (name === "today" ||
      name === "upcoming" ||
      name === "all" ||
      name === "list" ||
      name === "notebook" ||
      name === "tag");
  const isListStyle = isTaskFamily && view !== "kanban" && view !== "timeline";
  // 全屏态面板盖住全部内容，主区域无需让位
  if (!isListStyle || panelFullscreen.value) return { paddingRight: "0px" };
  return { paddingRight: panelWidth.value + "px" };
});

/** 详情面板最大宽度：设置项（默认 720）+ 侧边栏收起时释放的空间。
 *  侧边栏展开占用 sidebarWidth，收起后只剩 48px，释放的部分加到面板上限。 */
const detailPanelMaxWidth = computed(() => {
  const SIDEBAR_COLLAPSED_W = 48;
  const released = sidebarCollapsed.value
    ? Math.max(0, sidebarWidth.value - SIDEBAR_COLLAPSED_W)
    : 0;
  return settingsStore.detailPanelMaxWidth + released;
});

/** 侧边栏展开/收起会导致 maxWidth 变化：当前宽度超过新上限时钳制回去，
 *  避免面板过宽把任务列表区压扁（如收起时拖到 872，展开后上限 720 应回退） */
watch(detailPanelMaxWidth, (max) => {
  if (panelWidth.value > max) panelWidth.value = max;
});

/**
 * 应用启动时默认打开详情面板：等当前视图任务首次加载完成后，
 * 若用户未主动选中任何任务，则选中第一个任务让面板默认展开。
 *
 * 仅在「任务族 + 非悬浮视图」触发 —— 即列表视图（today/upcoming/all/
 * list/notebook/tag 且 ?view 不是 kanban/timeline）。看板/时间线/日历/
 * 习惯/设置 都是悬浮或非任务视图，默认不应自动弹出面板。
 * 排除 root 中间态：启动 redirect 经过 root 时 isFloatingPanelView 可能
 * 误判为 false，会导致日历启动闪现（选中后又被清空）。
 * 「成功选中」后才停止监听，等用户切到列表视图仍能默认展开。
 */
const stopInitialSelect = watch(
  () => [taskStore.openTasks, route.name, route.query.view] as const,
  () => {
    if (route.name === "root") return;
    const tasks = taskStore.openTasks;
    if (
      tasks.length > 0 &&
      taskStore.selectedTaskId === null &&
      showTaskSidebar.value &&
      !isFloatingPanelView.value
    ) {
      taskStore.selectTask(tasks[0].id);
      stopInitialSelect();
    }
  },
);

/**
 * topbar 让位 —— 与 mainStyle 同逻辑：只有列表视图让位，其余视图 right: 24px
 * （显式设置避免 Vue 不清除 inline 残留；保持 24px 右边距视觉一致）
 */
const topbarStyle = computed(() => {
  const name = route.name as string | undefined;
  const view = route.query.view as string | undefined;
  const isTaskFamily =
    !!name &&
    (name === "today" ||
      name === "upcoming" ||
      name === "all" ||
      name === "list" ||
      name === "notebook" ||
      name === "tag");
  const isListStyle = isTaskFamily && view !== "kanban" && view !== "timeline";
  // 全屏态面板盖住 topbar，让位已无意义
  if (!isListStyle || panelFullscreen.value) return { right: "24px" };
  return { right: `${panelWidth.value + 24}px` };
});

/** 排序菜单开关 */
const sortMenuOpen = ref(false);

/** 排序变更（选择后关闭菜单） */
async function onSortChange(field: SortField) {
  await taskStore.setSort(field);
  sortMenuOpen.value = false;
}

/** 看板列维度切换（下拉菜单形式，仅看板视图显示） */
const KANBAN_MODES: { value: "priority" | "group"; label: string }[] = [
  { value: "priority", label: "按优先级" },
  { value: "group", label: "按分组" },
];
const KANBAN_MODE_LABELS: Record<"priority" | "group", string> = {
  priority: "优先级",
  group: "分组",
};
const kanbanModeMenuOpen = ref(false);

/** 看板维度变更（选择后关闭菜单） */
/** 看板维度变更（选择后关闭菜单 + 持久化到作用域偏好）。
 *  智能视图强制 priority（菜单不显示，理论上不会触发 group） */
function onKanbanModeChange(mode: "priority" | "group"): void {
  kanbanStore.setMode(mode);
  if (viewPrefScope.value) setViewPref(viewPrefScope.value, { kanbanMode: mode });
  kanbanModeMenuOpen.value = false;
}

/** 清单视图切换（列表 / 看板 / 时间线，通过 query ?view= 切换；清单 + 智能视图均可显示） */
const LIST_VIEW_LABELS: Record<ListView, string> = { list: "列表", kanban: "看板", timeline: "时间线" };
const listViewMenuOpen = ref(false);

/** 是否处于智能视图路由（today/upcoming/all）——视图切换菜单也在此显示 */
const isSmartRoute = computed(() =>
  route.name === "today" || route.name === "upcoming" || route.name === "all",
);
/** 是否显示视图切换菜单（清单/智能视图/标签/笔记本 均支持列表/看板/时间线切换） */
const showViewSwitch = computed(() =>
  route.name === "list" ||
  route.name === "tag" ||
  route.name === "notebook" ||
  isSmartRoute.value,
);

/** 当前作用域（清单用 "list:{id}"，智能视图用 "smart:{viewId}"）——偏好持久化用 */
const viewPrefScope = computed(() => {
  if (route.name === "list") return "list:" + (route.params.id as string);
  if (isSmartRoute.value) return "smart:" + String(route.name);
  return "";
});

/** 切换视图：用 router.replace 改 query + 持久化到作用域偏好 */
function onListViewChange(view: ListView): void {
  router.replace({ query: { ...route.query, view } });
  if (viewPrefScope.value) setViewPref(viewPrefScope.value, { view });
  listViewMenuOpen.value = false;
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
  if (searchStore.open || quickAdd.visible.value || taskStore.pendingDeleteId || taskStore.pendingBatchDeleteIds || listStore.pendingBatchDelete) return;

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
    // 多选模式激活：Esc 优先退出多选（任务侧 + 侧边栏清单/笔记本侧都算）
    if (taskStore.batchMode || listStore.batchMode) {
      e.preventDefault();
      if (taskStore.batchMode) taskStore.exitBatchMode();
      if (listStore.batchMode) listStore.exitBatchMode();
      return;
    }
    if (taskStore.hasDetailOverlay) {
      e.preventDefault();
      return;
    }
    // 详情面板全屏态：Esc 先退全屏（逐层关闭），再按一次才关面板
    if (panelFullscreen.value) {
      e.preventDefault();
      panelFullscreen.value = false;
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
  //     侧边栏多选态激活时：Cmd+A 作用域跟随多选区域 → 全选当前 subheader 清单/笔记本树
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "a" || e.key === "A")) {
    if (listStore.batchMode) {
      e.preventDefault();
      const tree = route.name === "notebook" ? listStore.noteListTree : listStore.listTree;
      listStore.selectAllBatch(flattenActiveTree(tree));
      return;
    }
    if (showTaskSidebar.value) {
      e.preventDefault();
      taskStore.selectAllBatch();
    }
    return;
  }

  // 2.75 清单/笔记本视图：Ctrl/Cmd+↑/↓ 在侧边栏清单/笔记本间切换
  //    与 ↑/↓（任务导航）彻底分离：组合键是显式意图，任何清单状态都可切换
  //    （不受任务列表有无任务限制）；切换会由 loadTasks 自动关闭详情面板
  if (
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    (route.name === "list" || route.name === "notebook") &&
    (e.key === "ArrowDown" || e.key === "ArrowUp")
  ) {
    e.preventDefault();
    navigateSiblingList(e.key === "ArrowDown" ? "down" : "up");
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

/** 深度优先前序遍历的叶节点序列（与侧边栏树渲染顺序一致；纯函数） */
function flattenLeafNodes(nodes: ListTreeNode[]): ListTreeNode[] {
  const leaves: ListTreeNode[] = [];
  for (const n of nodes) {
    if (n.isFolder) leaves.push(...flattenLeafNodes(n.children));
    else leaves.push(n);
  }
  return leaves;
}

/** 选中清单/笔记本时按 ↑/↓：在对应树的叶节点间切换并跳转。
 *  - 按当前路由取树（/list → 清单树，/notebook → 笔记本树）
 *  - 停在首尾边界，不循环；当前 id 不在序列（理论不会）时从 0/末尾开始
 *  - 跳转前展开目标清单的父目录链，保证侧边栏激活项可见 */
function navigateSiblingList(direction: "up" | "down"): void {
  const isNote = route.name === "notebook";
  const tree = isNote ? listStore.noteListTree : listStore.listTree;
  const leaves = flattenLeafNodes(tree);
  if (leaves.length === 0) return;
  const curId = route.params.id as string;
  const idx = leaves.findIndex((n) => n.id === curId);
  const nextIdx =
    idx < 0
      ? direction === "down"
        ? 0
        : leaves.length - 1
      : direction === "down"
        ? Math.min(idx + 1, leaves.length - 1)
        : Math.max(idx - 1, 0);
  if (nextIdx === idx) return; // 已到边界
  const next = leaves[nextIdx];
  listStore.expandPath(next.id);
  router.push(`${isNote ? "/notebook" : "/list"}/${next.id}`);
}

let unlistenAgentSync: (() => void) | null = null;
onMounted(() => {
  window.addEventListener("keydown", onNavigationKeydown);
  // AI Agent 写库后的跨端数据同步（写工具触发 ai:data-changed）
  setupAgentDataSync().then((fn) => {
    unlistenAgentSync = fn;
  });
  // 加载缓存的详情面板宽度（拖拽调整后持久化，下次打开保持）
  db.getSetting(SETTINGS_KEYS.detailPanelWidth)
    .then((raw) => {
      if (raw) {
        const w = Number(raw);
        // 合法范围校验（与 TaskDetailPanel 的 480~720 一致）
        if (Number.isFinite(w) && w >= 480 && w <= 720) panelWidth.value = w;
      }
    })
    .catch((e) => console.error("[AppLayout] 读取详情面板宽度失败:", e));
  // 读取详情面板全屏态持久化值
  db.getSetting(SETTINGS_KEYS.detailPanelFullscreen)
    .then((raw) => {
      if (raw === "1") panelFullscreen.value = true;
    })
    .catch((e) => console.error("[AppLayout] 读取详情面板全屏态失败:", e));
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
onUnmounted(() => {
  window.removeEventListener("keydown", onNavigationKeydown);
  unlistenAgentSync?.();
});

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
        <!-- 视图切换（列表 / 看板 / 时间线；清单 + 智能视图均可显示） -->
        <MenuPopover
          v-if="showViewSwitch"
          v-model:visible="listViewMenuOpen"
        >
          <template #trigger>
            <a-button
              type="text"
              size="small"
              :title="`视图: ${LIST_VIEW_LABELS[currentListView]}`"
              @click="listViewMenuOpen = !listViewMenuOpen"
            >
              <template #icon>
                <icon-apps v-if="currentListView === 'kanban'" :size="18" />
                <icon-calendar v-else-if="currentListView === 'timeline'" :size="18" />
                <icon-list v-else :size="18" />
              </template>
            </a-button>
          </template>
          <MenuPopoverItem
            :active="currentListView === 'list'"
            @click="onListViewChange('list')"
          >
            <icon-list :size="15" />
            <span>列表视图</span>
          </MenuPopoverItem>
          <MenuPopoverItem
            :active="currentListView === 'kanban'"
            @click="onListViewChange('kanban')"
          >
            <icon-apps :size="15" />
            <span>看板视图</span>
          </MenuPopoverItem>
          <MenuPopoverItem
            :active="currentListView === 'timeline'"
            @click="onListViewChange('timeline')"
          >
            <icon-calendar :size="15" />
            <span>时间线</span>
          </MenuPopoverItem>
        </MenuPopover>
        <!-- 新建分组按钮（仅列表视图显示；看板视图不显示分组管理入口） -->
        <a-button
          v-if="route.name === 'list' && currentListView === 'list'"
          type="text"
          size="small"
          title="新建分组"
          @click="openNewGroup"
        >
          <template #icon><icon-folder :size="18" /></template>
        </a-button>
        <!-- 看板列维度切换（仅看板视图显示：优先级 / 分组，下拉菜单形式） -->
        <MenuPopover
          v-if="route.name === 'list' && currentListView === 'kanban'"
          v-model:visible="kanbanModeMenuOpen"
        >
          <template #trigger>
            <a-button
              type="text"
              size="small"
              :title="`看板分组: ${KANBAN_MODE_LABELS[kanbanStore.mode]}`"
              @click="kanbanModeMenuOpen = !kanbanModeMenuOpen"
            >
              <template #icon><icon-list :size="18" /></template>
            </a-button>
          </template>
          <MenuPopoverItem
            v-for="m in KANBAN_MODES"
            :key="m.value"
            :active="m.value === kanbanStore.mode"
            @click="onKanbanModeChange(m.value)"
          >
            <span>{{ m.label }}</span>
          </MenuPopoverItem>
        </MenuPopover>
      </div>

      <router-view />
    </main>

    <!-- AI 总结全局 loading 遮罩（预检/生成期间显示） -->
    <div v-if="taskStore.aiLoading" class="ai-loading-overlay">
      <a-spin :size="32" />
      <span class="ai-loading-overlay__text">AI 正在分析...</span>
    </div>

    <!-- 任务详情面板（右）—— 悬浮视图判断在面板内部自洽，不依赖外部传入 -->
    <TaskDetailPanel
      v-model:panel-width="panelWidth"
      v-model:fullscreen="panelFullscreen"
      :max-width="detailPanelMaxWidth"
      :force-hidden="panelForceHidden"
    />

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
      <template #default>
        任务将<strong>移入回收站</strong>，可随时在「设置 → 回收站」中恢复。
      </template>
    </ConfirmDialog>

    <!-- 批量删除确认对话框（多选批量菜单触发，显示数量） -->
    <ConfirmDialog
      v-model:visible="batchDeleteModalVisible"
      :mask-closable="false"
      @cancel="taskStore.cancelBatchDelete()"
      @confirm="taskStore.confirmBatchDelete()"
    >
      <template #title>删除选中的 <strong>{{ batchDeleteCount }}</strong> 个任务？</template>
      <template #default>
        任务将<strong>移入回收站</strong>，可随时在「设置 → 回收站」中恢复。
      </template>
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
  /* 不加 padding-right transition：侧边栏卸载时 main 尺寸瞬时变化，
     避免与 FullCalendar 的 ResizeObserver 竞争导致日历右侧空白 */
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
