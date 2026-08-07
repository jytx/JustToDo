<script setup lang="ts">
// 任务列表项 —— 支持树形递归（子任务嵌套展开）
// 含：展开箭头、复选框、标题、优先级色点、截止日期、hover 操作菜单
import { ref, computed, watch, reactive, nextTick, onMounted, onBeforeUnmount } from "vue";
import type { Task, Priority } from "@/types";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "@/types";
import { formatDueDate } from "@/utils/date";
import { useTaskStore } from "@/stores/task";
import { useGroupStore } from "@/stores/group";
import { useTagStore } from "@/stores/tag";
import { useListStore } from "@/stores/list";
import * as db from "@/api/db";
import TaskCheckbox from "./TaskCheckbox.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import ContextMenu from "./ContextMenu.vue";
import PriorityDot from "./PriorityDot.vue";
import ListCascadeMenu from "./menu/ListCascadeMenu.vue";
import AttachParentDialog from "./AttachParentDialog.vue";

const props = withDefaults(
  defineProps<{
    task: Task;
    /** 嵌套深度（根任务 = 0） */
    depth?: number;
    /** 是否显示清单色点（智能视图跨清单时用） */
    showListDot?: boolean;
    listColor?: string;
    /** 是否正在被拖拽（由父视图传入，用于源行半透明） */
    dragging?: boolean;
    /** 是否处于批量多选模式（决定是否显示左侧勾选框） */
    batchMode?: boolean;
    /** 当前任务是否被批量选中（决定勾选框填充与行高亮） */
    batchSelected?: boolean;
    /**
     * 强制允许拖拽（分组视图用）。
     * 分组拖拽（跨组改 group_id）与视图排序方式无关，
     * 分组视图下必须无视 currentSort 的 manual 条件，始终可拖。
     */
    forceDraggable?: boolean;
  }>(),
  {
    depth: 0,
    showListDot: false,
    dragging: false,
    batchMode: false,
    batchSelected: false,
    forceDraggable: false,
  },
);

const emit = defineEmits<{
  /** 行点击：带出 MouseEvent，让视图层判断 Shift/Cmd 修饰键走多选还是单选 */
  select: [e: MouseEvent];
  reorder: [draggedId: string, targetId: string, position: "before" | "after"];
  /** 拖拽开始：通知父视图记录 draggingId（FLIP 实时让位用） */
  dragstart: [taskId: string];
  /** 拖拽结束：通知父视图持久化最终顺序 */
  dragend: [];
}>();

// ─── 拖拽排序（仅根任务 depth=0 且未完成 且 当前为手动排序模式时启用） ──────────────
const taskStore = useTaskStore();
const groupStore = useGroupStore();
const tagStore = useTagStore();
const listStore = useListStore();

/** 当前清单的分组列表（用于「移动到分组」） */
const currentGroups = computed(() => groupStore.currentGroups);

/** 「移动至」可选清单树：仅未归档项，按当前任务 kind 隔离两棵树
 *  （笔记只列笔记本；任务只列清单）。含目录与子目录，目录在子菜单里递归展开。 */
const movableListTree = computed(() =>
  props.task.kind === "note" ? listStore.noteListTree : listStore.listTree,
);

/** 移动任务到指定分组 */
async function onMoveToGroup(groupId: string): Promise<void> {
  await taskStore.updateTask(props.task.id, { groupId });
  ctxMenu.visible = false;
  menuOpen.value = false;
  cascadeSubmenu.display = false;
}

/** 移动任务到指定清单（updateTask 传 listId，后端同步 group_id 回默认分组）。
 *  移动后任务不再属于当前视图，调 store.reload() 重新拉取当前视图任务，
 *  让原视图立即移除该任务（否则任务在原视图残留，需刷新页面才消失）。 */
async function onMoveToList(listId: string): Promise<void> {
  if (listId === props.task.listId) {
    // 已在目标清单：仅关闭菜单，避免无意义更新
    ctxMenu.visible = false;
    menuOpen.value = false;
    cascadeSubmenu.display = false;
    return;
  }
  await taskStore.updateTask(props.task.id, { listId });
  ctxMenu.visible = false;
  menuOpen.value = false;
  cascadeSubmenu.display = false;
  // 重新加载当前视图：从数据库拉最新任务列表，移动的任务从原视图消失
  await taskStore.reload();
}

// ─── 级联子菜单（优先级 / 标签 / 移动至 / 移动到分组，参照 BatchContextMenu 的 Teleport + fixed 方案）───
/** 级联子菜单类型：priority=优先级 / tag=标签 / list=移动至清单 / group=移动到分组 */
type CascadeKind = "priority" | "tag" | "list" | "group";

/** 级联子菜单状态：类型 + 定位 */
const cascadeSubmenu = reactive<{
  kind: CascadeKind | null;
  display: boolean;
  top: string | undefined;
  left: string | undefined;
}>({ kind: null, display: false, top: undefined, left: undefined });

let cascadeCloseTimer: number | null = null;
const CASCADE_CLOSE_DELAY = 200;

/** 显示级联子菜单：定位在触发项右侧（超出视口则翻转到左侧） */
async function showCascadeSubmenu(kind: CascadeKind, triggerEl: HTMLElement): Promise<void> {
  if (cascadeCloseTimer !== null) {
    clearTimeout(cascadeCloseTimer);
    cascadeCloseTimer = null;
  }
  // 标签列表兜底加载（侧边栏通常已加载，此处防收起/加载失败场景）
  if (kind === "tag" && tagStore.tags.length === 0) {
    await tagStore.loadTags();
  }
  cascadeSubmenu.kind = kind;
  cascadeSubmenu.display = true;
  await nextTick();
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const tr = triggerEl.getBoundingClientRect();
  const subEl = document.querySelector(".task-item-submenu") as HTMLElement | null;
  const subW = subEl ? subEl.offsetWidth : 180;
  const viewportW = document.documentElement.clientWidth;
  const margin = 4;
  let left = tr.right + margin;
  if (left + subW > viewportW - margin) {
    left = tr.left - subW - margin;
  }
  cascadeSubmenu.left = left + "px";
  cascadeSubmenu.top = tr.top + "px";
}

function scheduleCloseCascadeSubmenu(): void {
  if (cascadeCloseTimer !== null) clearTimeout(cascadeCloseTimer);
  cascadeCloseTimer = window.setTimeout(() => {
    cascadeSubmenu.display = false;
    cascadeCloseTimer = null;
  }, CASCADE_CLOSE_DELAY);
}

function cancelCloseCascadeSubmenu(): void {
  if (cascadeCloseTimer !== null) {
    clearTimeout(cascadeCloseTimer);
    cascadeCloseTimer = null;
  }
}

// ─── 菜单设置优先级 / 标签 ─────────────────────────────
/** 从菜单设置优先级（点击后关闭全部菜单） */
async function onMenuSetPriority(p: Priority): Promise<void> {
  ctxMenu.visible = false;
  menuOpen.value = false;
  cascadeSubmenu.display = false;
  await taskStore.updateTask(props.task.id, { priority: p });
}

/** 菜单里切换标签关联（已关联 → 移除，未关联 → 添加）。
 *  保持子菜单打开，方便连续调整多个标签。 */
async function onMenuToggleTag(tagId: string): Promise<void> {
  const has = taskTags.value.some((t) => t.id === tagId);
  if (has) {
    await db.removeTaskTag(props.task.id, tagId);
  } else {
    await db.addTaskTag(props.task.id, tagId);
  }
  // 刷新 store 缓存（taskTagMap 是列表项 + 详情面板的唯一数据源）
  await taskStore.refreshTaskTags(props.task.id);
}

/** 菜单里新建标签并关联到当前任务（与详情面板创建标签同范式） */
async function onMenuCreateTag(name: string): Promise<void> {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  let tag = tagStore.getByName(trimmed);
  if (!tag) {
    tag = await tagStore.createTag(trimmed);
  }
  if (tag) {
    await db.addTaskTag(props.task.id, tag.id);
    await taskStore.refreshTaskTags(props.task.id);
  }
}

/** 笔记（kind='note'）：无完成/日期/重复概念，UI 隐藏这些区块。
 *  笔记仍可拖拽排序（复用任务的拖拽逻辑，仅去掉 done 限制）。 */
const isNote = computed(() => props.task.kind === "note");

// ─── 标题截断检测（仅标题被省略号截断时显示 tooltip） ───
/** 标题 span 引用 */
const titleEl = ref<HTMLElement | null>(null);
/** 标题是否被截断（scrollWidth > clientWidth） */
const titleTruncated = ref<boolean>(false);
let titleResizeObserver: ResizeObserver | null = null;

/** 检测标题是否溢出（容器变窄/标题变长时重新检测） */
function checkTitleTruncated(): void {
  const el = titleEl.value;
  if (!el) return;
  titleTruncated.value = el.scrollWidth > el.clientWidth;
}

onMounted(() => {
  checkTitleTruncated();
  // 监听标题自身尺寸变化（如侧边栏收起/详情面板宽度变化导致容器变宽变窄）
  const el = titleEl.value;
  if (el && typeof ResizeObserver !== "undefined") {
    titleResizeObserver = new ResizeObserver(() => checkTitleTruncated());
    titleResizeObserver.observe(el);
  }
});
onBeforeUnmount(() => {
  titleResizeObserver?.disconnect();
  titleResizeObserver = null;
});

const canDrag = computed(
  () =>
    props.depth === 0 &&
    (isNote.value || !props.task.done) &&
    (props.forceDraggable || taskStore.currentSort.field === "manual"),
);
const dragOver = ref<"before" | "after" | null>(null);

function onDragStart(e: DragEvent) {
  if (!canDrag.value) {
    e.preventDefault();
    return;
  }
  e.dataTransfer!.setData("text/plain", props.task.id);
  e.dataTransfer!.effectAllowed = "move";
  e.dataTransfer!.dropEffect = "move";
  // 通知父视图记录 draggingId（FLIP 实时让位用）
  emit("dragstart", props.task.id);
  // 不设置自定义 setDragImage，让浏览器默认用整个任务项的半透明截图作为拖拽视觉，
  // 体现"整行被移动"的效果（而不是只有文字的小卡片）。
}

function onDragEnd() {
  dragOver.value = null;
  // 通知父视图持久化最终顺序（WKWebView 的 drop 不可靠，以 dragend 为准）
  emit("dragend");
}

function onDragOver(e: DragEvent) {
  // 始终 preventDefault + 设 dropEffect="move"，保证整个列表区域都显示
  // "可移动"光标，避免鼠标在可拖/不可拖行之间移动时光标闪烁成禁止/加号。
  // 是否真正执行 reorder 由 onDrop 里的业务判断决定。
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  // 不可拖拽的行不参与落点高亮（仅作过路），但仍 preventDefault 避免光标闪烁
  if (!canDrag.value) return;
  dragOver.value = computeDropPosition(e);
}

/** dragenter：拖拽进入元素时立即锁定 dropEffect="move"，
 *  消除"刚拖起来那一瞬间"光标闪成默认 +/copy 的现象（react-dnd issue #414）。
 *  dragenter 到首个 dragover 之间存在光标未定窗口，必须在此显式声明。 */
function onDragEnter(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
}

/** 计算拖拽放置位置：与 SidebarListNode 保持一致 —— 上 1/3 为 before，下 2/3 为 after */
function computeDropPosition(e: DragEvent): "before" | "after" {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  return y < rect.height / 3 ? "before" : "after";
}

function onDragLeave(e: DragEvent) {
  const related = e.relatedTarget as HTMLElement | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  dragOver.value = null;
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  const draggedId = e.dataTransfer!.getData("text/plain");
  if (!draggedId || draggedId === props.task.id || !canDrag.value) {
    dragOver.value = null;
    return;
  }

  const position = computeDropPosition(e);

  emit("reorder", draggedId, props.task.id, position);
  dragOver.value = null;
}

/** 是否被选中（详情面板打开时） */
const isSelected = computed(() => taskStore.selectedTaskId === props.task.id);

/** 是否被键盘导航聚焦（仅视觉高亮，不打开详情面板） */
const isFocused = computed(() => taskStore.focusedTaskId === props.task.id);

/** 任务项根元素 ref（用于 scrollIntoView） */
const itemRef = ref<HTMLElement>();

// 焦点变化时滚动到可视区域
watch(isFocused, (focused) => {
  if (focused) {
    // 用 nearest 模式：仅当不可见时才滚动，避免抢滚动条
    itemRef.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});

const dueInfo = computed(() => formatDueDate(props.task.dueStartAt, props.task.dueEndAt));

/** 优先级对应的颜色（高=红 中=橙 低=蓝）*/
const priorityColor = computed<string>(() => {
  const token = PRIORITY_COLORS[props.task.priority];
  if (token === "error") return "var(--jt-error)";
  if (token === "warning") return "var(--jt-warning)";
  if (token === "info") return "#3B82F6";
  return "var(--jt-text-tertiary)";
});

// ─── 子任务展开 / 懒加载 ───────────────────────────────
const expanded = ref(false);
const childSubtasks = computed(() =>
  taskStore.getCachedSubtasks(props.task.id),
);

// ─── 任务标签（从 store 缓存读取，用于任务项显示） ───────────────────────────────
const taskTags = computed(() => taskStore.taskTagMap[props.task.id] ?? []);

/** 是否有子任务（需要先加载才知道）——先假设可能有，首次展开时加载 */
const hasSubtasksLoaded = computed(() => props.task.id in taskStore.subtaskCache);
const childCount = computed(() => childSubtasks.value.length);

/** 子任务完成数 */
const childDoneCount = computed(() =>
  childSubtasks.value.filter((t) => t.done).length,
);

/** 子任务进度百分比（0–100，用于底边进度条的填充宽度）。
 *  无子任务时为 0，渲染层用 hasSubtasks 控制是否显示底边。 */
const childProgress = computed(() => {
  if (childCount.value <= 0) return 0;
  return Math.round((childDoneCount.value / childCount.value) * 100);
});

/** 是否显示底边进度条（有子任务才显示） */
const hasSubtaskProgress = computed(
  () => hasSubtasksLoaded.value && childCount.value > 0,
);

async function toggleExpand() {
  // 展开时若缓存没有该任务的子任务 key（子任务层级的孙任务未被 preload 预加载），
  // 先懒加载到缓存，否则展开后列表为空
  if (!expanded.value && !hasSubtasksLoaded.value) {
    await taskStore.loadSubtasksToCache(props.task.id);
  }
  expanded.value = !expanded.value;
}

/** 直接 toggle 当前任务 */
async function doToggle() {
  await taskStore.toggleTask(props.task.id, !props.task.done);
}

/** 行点击：把 MouseEvent 透传给视图层，由视图层按修饰键决定走多选还是单选。
 *  TaskListItem 自身不做修饰键判断，保持单一职责（只负责展示 + 透传）。 */
function onRowClick(e: MouseEvent): void {
  emit("select", e);
}

// ─── 标题编辑（单击标题进入） ──────────────────────────────
/** 是否处于标题编辑态（单击标题进入） */
const editingTitle = ref(false);
/** 标题输入框引用（进入编辑态后自动聚焦） */
const titleInputRef = ref<HTMLInputElement | null>(null);
/** 编辑中的标题值（独立 ref，编辑期间不回写 props.task.title，失焦保存时才持久化） */
const editingTitleValue = ref("");
/** 鼠标点击位置对应的字符偏移（编辑态光标落点） */
const titleClickOffset = ref(0);

/** 把鼠标点击坐标映射为标题文字的字符偏移。
 *  caretRangeFromPoint 返回点击处所在的文本 Range，startOffset 即字符位置；
 *  点击在省略号/空白区域时取末尾。 */
function offsetFromClickPoint(e: MouseEvent): number {
  const title = titleEl.value;
  const len = props.task.title.length;
  if (!title) return len;
  const range = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
    return Math.min(range.startOffset, len);
  }
  return len;
}

/** 单击标题进入编辑：同时确保详情面板打开（点击标题与点击行其他区域一致，
 *  都显示详情）。selectTask 对相同 id 是 toggle，需先判断再调用，避免
 *  已选中时被关闭。光标定位到鼠标点击的字符位置（点哪编辑哪）。
 *  focus 用 rAF 双重保障：v-if 切换渲染 input 后，nextTick 时 DOM 可能未完全
 *  稳定（浏览器焦点栈未更新），直接 focus 偶发失效。 */
function onTitleClick(e: MouseEvent): void {
  // 确保详情面板打开（相同 id 不重复 toggle）
  if (taskStore.selectedTaskId !== props.task.id) {
    taskStore.selectTask(props.task.id);
  }
  editingTitleValue.value = props.task.title;
  // 先记录点击偏移（此时 span 还在 DOM 上，caretRangeFromPoint 才能命中）
  titleClickOffset.value = offsetFromClickPoint(e);
  editingTitle.value = true;
  nextTick(() => {
    requestAnimationFrame(() => {
      const input = titleInputRef.value;
      if (input) {
        input.focus();
        const pos = Math.min(titleClickOffset.value, input.value.length);
        input.setSelectionRange(pos, pos);
      }
    });
  });
}

/** 保存标题：空标题保留原值（不创建无标题任务），有变化才调 store 持久化 */
async function saveTitle(): Promise<void> {
  if (!editingTitle.value) return;
  const trimmed = editingTitleValue.value.trim();
  editingTitle.value = false;
  // 空标题：不保存（回退到原标题）
  if (!trimmed || trimmed === props.task.title) return;
  await taskStore.updateTask(props.task.id, { title: trimmed });
}

/** 取消编辑：ESC 恢复原值（不持久化） */
function cancelEditTitle(): void {
  editingTitle.value = false;
  editingTitleValue.value = props.task.title;
}

/** 创建副本：复制当前任务的标题/优先级/日期/备注/重复/提醒到同清单新任务。
 *  与详情面板右下角「创建副本」同范式（createTask 基础字段 + update 补全）。
 *  复制后选中副本，便于用户继续编辑。 */
async function onMenuDuplicate(): Promise<void> {
  ctxMenu.visible = false;
  menuOpen.value = false;
  cascadeSubmenu.display = false;
  const t = props.task;
  const newTask = await taskStore.createTask({
    title: `${t.title}（副本）`,
    listId: t.listId,
    priority: t.priority,
    dueStartAt: t.dueStartAt,
    dueEndAt: t.dueEndAt,
    kind: t.kind,
    groupId: t.groupId ?? undefined,
  });
  if (newTask) {
    await taskStore.updateTask(newTask.id, {
      note: t.note ?? "",
      recurrenceFreq: t.recurrenceFreq,
      recurrenceInterval: t.recurrenceInterval,
      remindOffsetMinutes: t.remindOffsetMinutes,
    });
    taskStore.selectTask(newTask.id);
  }
}

/** 子任务行点击：与 onRowClick 同逻辑，但子任务不走事件冒泡（冒泡到视图层时
 *  会丢失 subId），直接在组件内按修饰键调用 store 批量方法。
 *  Shift 范围选基于 openTasks（根任务序列，不含子任务），子任务 Shift 会退化为单选。 */
function onSubSelect(subId: string, e: MouseEvent): void {
  if (e.shiftKey) {
    taskStore.rangeBatchSelect(subId);
  } else if (e.metaKey || e.ctrlKey) {
    taskStore.toggleBatchSelect(subId);
  } else if (taskStore.batchMode) {
    taskStore.toggleBatchSelect(subId);
  } else {
    taskStore.selectTask(subId);
  }
}

// 当子任务缓存更新后，如果展开状态下子任务为空，自动收起
watch(childCount, (n) => {
  if (n === 0 && expanded.value && hasSubtasksLoaded.value) {
    expanded.value = false;
  }
});

// 跨实例自动展开：store 发出"新建子任务后展开父任务"信号（如右键「新建同级」在
// 子任务上创建同父任务时，父任务是另一个实例，无法直接操作其 expanded）。
// 本实例若匹配到信号，自动展开并清除信号。
watch(
  () => taskStore.autoExpandParentId,
  (pid) => {
    if (pid && pid === props.task.id) {
      expanded.value = true;
      // 清除信号（一次性），避免下次任务切换时误展开
      taskStore.autoExpandParentId = null;
    }
  },
);

// ─── 任务行右侧更多菜单 ──────────────────────────────
const menuOpen = ref(false);

function onDelete() {
  menuOpen.value = false;
  taskStore.requestDelete(props.task.id);
}

// ─── 关联主任务弹窗 ──────────────────────────────────
/** 弹窗可见性 */
const attachParentVisible = ref(false);

/** 打开关联主任务弹窗（右键菜单与更多菜单共用） */
function onMenuAttachParent(): void {
  ctxMenu.visible = false;
  menuOpen.value = false;
  attachParentVisible.value = true;
}

/** 弹窗选中主任务后：先关弹窗，再调 store 持久化
 *  （后端同步 parent_id + 跨清单的 list_id/group_id，reload 后任务从根列表消失） */
async function onAttachParentSelect(parentId: string): Promise<void> {
  attachParentVisible.value = false;
  await taskStore.attachToParent(props.task.id, parentId);
}

// ─── 右键菜单 ──────────────────────────────────────
/** 右键菜单状态：可见性 + 鼠标坐标 */
const ctxMenu = reactive<{ visible: boolean; x: number; y: number }>({
  visible: false,
  x: 0,
  y: 0,
});

/** 右键菜单：多选模式下让事件冒泡给视图层（弹批量菜单），非多选时弹单任务菜单。
 *  - 多选模式 + 本任务在选中集合内 → 不 stop，冒泡到视图层弹 BatchContextMenu
 *  - 其他情况（非多选，或多选但右键的是未选中任务）→ 弹内部单任务菜单 */
function onContextMenu(e: MouseEvent): void {
  if (props.batchMode && props.batchSelected) {
    // 多选且本任务已选中：让事件冒泡到视图层（模板仅 .prevent，未 .stop）
    return;
  }
  // 非多选分支：阻止冒泡，弹内部单任务菜单
  e.stopPropagation();
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.visible = true;
}

/** 新建同级任务：与当前任务同一父级、同一清单。
 *  - 当前是顶层任务（parentId=null）→ 新建顶层任务
 *  - 当前是子任务（parentId 非空）→ 新建同父子任务
 *  走「空标题 + 选中打开详情面板」范式，让用户直接输入标题。 */
async function addSiblingTaskAndSelect(): Promise<void> {
  const created = await taskStore.createTask({
    title: "",
    listId: props.task.listId,
    parentId: props.task.parentId,
    kind: props.task.kind,
    // 继承同组：新建同级与当前任务属同一分组（任务自带 groupId）
    groupId: props.task.groupId ?? undefined,
  });
  taskStore.selectTask(created.id);
}

/** 右键菜单「新建任务（同级）」：关闭的是右键菜单（ctxMenu） */
async function onCtxAddSiblingTask(): Promise<void> {
  ctxMenu.visible = false;
  await addSiblingTaskAndSelect();
}

/** 新建子任务：在当前任务下创建下级任务，创建后自动展开显示。
 *  复用 TaskDetailPanel.addSubtask 的范式：createSubtask(空标题) → 刷新子任务 → 选中。
 *  展开由 createSubtask 发出的 autoExpandParentId 信号驱动（watch 统一处理）。 */
async function addSubtaskAndExpand(): Promise<void> {
  await taskStore.createSubtask(props.task, "");
  await taskStore.loadSubtasks(props.task.id);
  const sub = taskStore.subtasks[taskStore.subtasks.length - 1];
  if (sub) taskStore.selectTask(sub.id);
}

/** 右键菜单「新建子任务」 */
async function onCtxAddSubtask(): Promise<void> {
  ctxMenu.visible = false;
  await addSubtaskAndExpand();
}

/** 更多菜单「新建任务（同级）」：关闭的是右侧更多菜单（menuOpen） */
async function onMenuAddSiblingTask(): Promise<void> {
  menuOpen.value = false;
  await addSiblingTaskAndSelect();
}

/** 更多菜单「新建子任务」：关闭的是右侧更多菜单（menuOpen） */
async function onMenuAddSubtask(): Promise<void> {
  menuOpen.value = false;
  await addSubtaskAndExpand();
}

/** 删除任务（走现有的删除确认弹窗） */
function onCtxDelete(): void {
  ctxMenu.visible = false;
  taskStore.requestDelete(props.task.id);
}

/** 进入多选模式：直接选中当前任务并开启多选，用户可继续勾选其他任务 */
function onCtxEnterBatchMode(): void {
  ctxMenu.visible = false;
  taskStore.toggleBatchSelect(props.task.id);
}
</script>

<template>
  <div class="task-tree-node" :data-task-id="task.id">
    <!-- 当前任务行 -->
    <div
      ref="itemRef"
      class="task-item"
      :class="{
        'task-item--done': task.done,
        'task-item--selected': isSelected,
        'task-item--focused': isFocused,
        'task-item--drag-over': dragOver === 'before' || dragOver === 'after',
        'task-item--dragging': dragging,
        'task-item--has-subtasks': hasSubtaskProgress,
        'task-item--subtasks-done': hasSubtaskProgress && childProgress >= 100,
      }"
      :style="{
        paddingLeft: depth * 20 + 'px',
        '--jt-subtask-progress': childProgress + '%',
      }"
      :draggable="canDrag ? 'true' : 'false'"
      @click="onRowClick"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @contextmenu.prevent="onContextMenu($event)"
    >
      <!-- 展开箭头（无子任务时不显示） -->
      <span
        v-if="hasSubtasksLoaded && childCount > 0"
        class="task-item__expand"
        @click.stop="toggleExpand"
      >
        <icon-right v-if="!expanded" :size="14" />
        <icon-down v-else :size="14" />
      </span>
      <!-- 无子任务时占位，保持缩进对齐 -->
      <span v-else class="task-item__expand-placeholder" />

      <!-- 复选框（笔记无完成概念，且多选模式下隐藏——由批量勾选框取代） -->
      <TaskCheckbox v-if="!isNote && !batchMode" :done="task.done" @toggle="doToggle" />

      <!-- 笔记图标徽章（区分于任务；标签/搜索视图中任务和笔记全局共用。
           多选模式下同样隐藏，由批量勾选框取代） -->
      <icon-file v-else-if="!batchMode" :size="14" class="task-item__note-icon" />

      <!-- 批量多选勾选框（仅 batchMode 下显示，圆形区别于方形完成框）。
           放在展开箭头之后、复选框原位置，与平时复选框横向对齐，避免贴边。 -->
      <span
        v-if="batchMode"
        class="task-item__batch-check"
        :class="{ 'task-item__batch-check--on': batchSelected }"
        @click.stop="emit('select', $event)"
      >
        <icon-check v-if="batchSelected" :size="11" style="color: #fff" />
      </span>

      <!-- 清单色点（智能视图） -->
      <span
        v-if="showListDot"
        class="task-item__list-dot"
        :style="{ backgroundColor: listColor || '#6B7280' }"
      />

      <div class="task-item__body">
        <!-- 标题：双击进入编辑（span ↔ input 切换）。
             非编辑态：单行省略号 + 仅截断时显示 Arco 黑底白字 tooltip（向下） -->
        <a-tooltip
          v-if="!editingTitle"
          :content="task.title"
          position="bottom"
          :mouse-enter-delay="0.3"
          :disabled="!titleTruncated"
        >
          <span
            ref="titleEl"
            class="task-item__title"
            @click.stop="onTitleClick($event)"
          >{{ task.title || "（无标题）" }}</span>
        </a-tooltip>
        <!-- 编辑态：input 失焦/回车保存，ESC 取消。
             @click.stop 阻止冒泡到行的选中逻辑——selectTask 对相同 id 是
             toggle（会关闭详情面板），编辑中点击 input 调整光标会误触。 -->
        <input
          v-else
          ref="titleInputRef"
          v-model="editingTitleValue"
          class="task-item__title-input"
          type="text"
          @click.stop
          @keydown.enter.prevent="saveTitle"
          @keydown.esc.prevent="cancelEditTitle"
          @blur="saveTitle"
        />
        <!-- 标签 chips（独立一行，显示在标题下方） -->
        <div v-if="taskTags.length" class="task-item__tags">
          <span
            v-for="tag in taskTags"
            :key="tag.id"
            class="task-item__tag"
          >{{ tag.name }}</span>
        </div>
        <div v-if="task.recurrenceFreq || dueInfo" class="task-item__meta">
          <span v-if="task.recurrenceFreq" class="task-item__recurrence" title="重复任务">
            <icon-refresh :size="12" />
          </span>
          <span
            v-if="dueInfo"
            class="task-item__due"
            :class="{
              'task-item__due--overdue': dueInfo.overdue,
              'task-item__due--today': dueInfo.isToday,
            }"
          >
            <icon-exclamation-circle :size="12" />
            {{ dueInfo.text }}
          </span>
        </div>
      </div>

      <!-- 优先级火焰图标（常驻显示，无优先级时不渲染）-->
      <icon-fire
        v-if="task.priority > 0"
        :size="14"
        class="task-item__priority"
        :style="{ color: priorityColor }"
      />

      <div class="task-item__actions">
        <MenuPopover v-model:visible="menuOpen">
          <template #trigger>
            <button
              class="task-item__menu-btn"
              @click.stop="menuOpen = !menuOpen"
            >
              <icon-more :size="16" />
            </button>
          </template>
          <MenuPopoverItem
            @mouseenter="(e: MouseEvent) => showCascadeSubmenu('priority', e.currentTarget as HTMLElement)"
            @mouseleave="scheduleCloseCascadeSubmenu"
          >
            <icon-fire :size="15" />
            <span>优先级</span>
            <icon-right :size="12" style="margin-left: auto" />
          </MenuPopoverItem>
          <MenuPopoverItem
            @mouseenter="(e: MouseEvent) => showCascadeSubmenu('tag', e.currentTarget as HTMLElement)"
            @mouseleave="scheduleCloseCascadeSubmenu"
          >
            <icon-tag :size="15" />
            <span>标签</span>
            <icon-right :size="12" style="margin-left: auto" />
          </MenuPopoverItem>
          <!-- 移动至：hover 弹清单列表（按当前任务 kind 隔离） -->
          <MenuPopoverItem
            @mouseenter="(e: MouseEvent) => showCascadeSubmenu('list', e.currentTarget as HTMLElement)"
            @mouseleave="scheduleCloseCascadeSubmenu"
          >
            <icon-export :size="15" />
            <span>移动至</span>
            <icon-right :size="12" style="margin-left: auto" />
          </MenuPopoverItem>
          <MenuPopoverItem @click="onMenuAttachParent">
            <icon-link :size="15" />
            <span>关联主任务</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="onMenuAddSiblingTask">
            <icon-plus :size="15" />
            <span>{{ isNote ? "新建笔记" : "新建任务" }}</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="onMenuAddSubtask">
            <icon-plus :size="15" />
            <span>{{ isNote ? "新建子笔记" : "新建子任务" }}</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="onMenuDuplicate">
            <icon-copy :size="15" />
            <span>创建副本</span>
          </MenuPopoverItem>
          <MenuPopoverItem danger @click="onDelete">
            <icon-delete :size="15" />
            <span>{{ isNote ? "删除笔记" : "删除任务" }}</span>
          </MenuPopoverItem>
        </MenuPopover>
      </div>

      <!-- 子任务进度条（贴底，仅当有子任务时渲染；详见 .task-item__subtask-bar） -->
      <div v-if="hasSubtaskProgress" class="task-item__subtask-bar">
        <div class="task-item__subtask-bar-fill" />
      </div>
    </div>

    <!-- 递归渲染子任务（继承批量多选 props，让子任务也能被多选） -->
    <div v-if="expanded && childSubtasks.length" class="task-tree-node__children">
      <TaskListItem
        v-for="sub in childSubtasks"
        :key="sub.id"
        :task="sub"
        :depth="depth + 1"
        :batch-mode="batchMode"
        :batch-selected="taskStore.isBatchSelected(sub.id)"
        @select="(e: MouseEvent) => onSubSelect(sub.id, e)"
      />
    </div>

    <!-- 右键菜单：多选 / 优先级 / 标签 / 移动到分组 / 新建同级 / 新建子项 / 删除 -->
    <ContextMenu v-model:visible="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y">
      <MenuPopoverItem @click="onCtxEnterBatchMode">
        <icon-check-circle :size="15" />
        <span>多选</span>
      </MenuPopoverItem>
      <!-- 优先级 / 标签 / 移动到分组：hover 弹右侧级联子菜单 -->
      <MenuPopoverItem
        @mouseenter="(e: MouseEvent) => showCascadeSubmenu('priority', e.currentTarget as HTMLElement)"
        @mouseleave="scheduleCloseCascadeSubmenu"
      >
        <icon-fire :size="15" />
        <span>优先级</span>
        <icon-right :size="12" style="margin-left: auto" />
      </MenuPopoverItem>
      <MenuPopoverItem
        @mouseenter="(e: MouseEvent) => showCascadeSubmenu('tag', e.currentTarget as HTMLElement)"
        @mouseleave="scheduleCloseCascadeSubmenu"
      >
        <icon-tag :size="15" />
        <span>标签</span>
        <icon-right :size="12" style="margin-left: auto" />
      </MenuPopoverItem>
      <!-- 移动至：hover 弹清单列表（按当前任务 kind 隔离） -->
      <MenuPopoverItem
        @mouseenter="(e: MouseEvent) => showCascadeSubmenu('list', e.currentTarget as HTMLElement)"
        @mouseleave="scheduleCloseCascadeSubmenu"
      >
        <icon-export :size="15" />
        <span>移动至</span>
        <icon-right :size="12" style="margin-left: auto" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="onMenuAttachParent">
        <icon-link :size="15" />
        <span>关联主任务</span>
      </MenuPopoverItem>
      <!-- 移动到分组：hover 弹右侧级联子菜单（仅当清单有多个分组时显示） -->
      <MenuPopoverItem
        v-if="!isNote && currentGroups.length > 1"
        @mouseenter="(e: MouseEvent) => showCascadeSubmenu('group', e.currentTarget as HTMLElement)"
        @mouseleave="scheduleCloseCascadeSubmenu"
      >
        <icon-folder :size="15" />
        <span>移动到分组</span>
        <icon-right :size="12" style="margin-left: auto" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="onCtxAddSiblingTask">
        <icon-plus :size="15" />
        <span>{{ isNote ? "新建笔记" : "新建任务" }}</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="onCtxAddSubtask">
        <icon-branch :size="15" />
        <span>{{ isNote ? "新建子笔记" : "新建子任务" }}</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="onMenuDuplicate">
        <icon-copy :size="15" />
        <span>创建副本</span>
      </MenuPopoverItem>
      <MenuPopoverItem danger @click="onCtxDelete">
        <icon-delete :size="15" />
        <span>{{ isNote ? "删除笔记" : "删除任务" }}</span>
      </MenuPopoverItem>
    </ContextMenu>

    <!-- 移动到分组级联子菜单：Teleport 到 body，position:fixed -->
    <Teleport to="body">
      <div
        v-if="cascadeSubmenu.display"
        class="task-item-submenu context-menu"
        :style="{ position: 'fixed', top: cascadeSubmenu.top, left: cascadeSubmenu.left, zIndex: '10010' }"
        @mouseenter="cancelCloseCascadeSubmenu"
        @mouseleave="scheduleCloseCascadeSubmenu"
      >
        <!-- 优先级：无 / 低 / 中 / 高（当前级别高亮） -->
        <template v-if="cascadeSubmenu.kind === 'priority'">
          <MenuPopoverItem
            v-for="(label, p) in PRIORITY_LABELS"
            :key="p"
            :active="props.task.priority === Number(p)"
            @click="onMenuSetPriority(Number(p) as Priority)"
          >
            <PriorityDot :priority="(Number(p) as Priority)" :size="10" />
            <span>{{ label }}</span>
          </MenuPopoverItem>
        </template>
        <!-- 标签：点击切换关联（已关联高亮 + 勾选），底部可新建标签 -->
        <template v-else-if="cascadeSubmenu.kind === 'tag'">
          <MenuPopoverItem
            v-for="opt in tagStore.tags"
            :key="opt.id"
            :active="taskTags.some((t) => t.id === opt.id)"
            @click="onMenuToggleTag(opt.id)"
          >
            <icon-tag :size="12" />
            <span>{{ opt.name }}</span>
          </MenuPopoverItem>
          <a-input
            placeholder="+ 新建标签"
            size="mini"
            allow-clear
            style="margin-top: 4px"
            @keydown.enter="(e: any) => { onMenuCreateTag((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ''; }"
          />
        </template>
        <!-- 移动至清单：递归渲染目录树，目录 hover 出右侧子级菜单 -->
        <template v-else-if="cascadeSubmenu.kind === 'list'">
          <ListCascadeMenu
            :nodes="movableListTree"
            :current-list-id="props.task.listId"
            :on-select="onMoveToList"
          />
        </template>
        <!-- 移动到分组：当前分组高亮 -->
        <template v-else-if="cascadeSubmenu.kind === 'group'">
          <MenuPopoverItem
            v-for="group in currentGroups"
            :key="group.id"
            :active="group.id === props.task.groupId"
            @click="onMoveToGroup(group.id)"
          >
            <span>{{ group.name }}</span>
          </MenuPopoverItem>
        </template>
      </div>
    </Teleport>

    <!-- 关联主任务弹窗（右键/更多菜单触发） -->
    <AttachParentDialog
      v-model:visible="attachParentVisible"
      :task-id="props.task.id"
      :current-parent-id="props.task.parentId"
      @select="onAttachParentSelect"
    />
  </div>
</template>

<style scoped>
.task-tree-node {
  display: flex;
  flex-direction: column;
}

.task-item {
  position: relative; /* 子任务进度条（绝对定位贴底）的定位基准 */
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  /* 裁切贴底的子任务进度条，使其两端自动贴合本行的 8px 圆角，
   * 呈现"行底边的彩色加粗版"效果，弧度与任务行一致。
   * 菜单浮层（MenuPopover）已 teleport 到 body，不受此裁切影响。 */
  overflow: hidden;
}

/* 子任务进度条 —— 用任务行底边作为进度可视化（替代独立的文字计数）
 * 设计：
 *  - 无子任务：不渲染，行底完全透明（保持原样）
 *  - 有子任务：底边一条浅色「轨道」（满宽，铺满行底）
 *  - 部分完成：轨道上叠一条按 doneCount/totalCount 比例的深色「填充」
 *  - 全部完成：填充满宽（100%），整体变深
 * 横向铺满 + 贴底，由父级 .task-item 的 overflow:hidden + 8px 圆角
 * 自动裁切两端，弧度与任务行一致。
 * 宽度比例通过 CSS 变量 --jt-subtask-progress 注入（如 "33%"）。 */
.task-item__subtask-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background-color: color-mix(in srgb, var(--jt-text-tertiary) 22%, transparent);
  overflow: hidden;
  pointer-events: none; /* 不拦截行点击 */
}

/* 填充条：宽度 = 已完成子任务占比，主色；全完成时整体变绿 */
.task-item__subtask-bar-fill {
  height: 100%;
  width: var(--jt-subtask-progress, 0%);
  background-color: var(--jt-primary);
  transition: width 0.25s ease, background-color 0.25s ease;
}

/* 全部子任务完成：填充变绿，强化完成语义 */
.task-item--subtasks-done .task-item__subtask-bar-fill {
  background-color: var(--jt-success);
}

.task-item:hover {
  background-color: var(--jt-surface-hover);
}

/* 选中状态 —— 与侧边栏清单 .list-node--active 完全对齐：
 *  - 底色用 --jt-accent-soft；hover 时叠 15% primary 加深
 *  - 加 !important 压过 .task-item:hover，否则选中行悬停时
 *    会被 --jt-surface-hover 浅灰覆盖，表现为"看不出选中"。 */
.task-item--selected {
  background-color: var(--jt-accent-soft) !important;
}

.task-item--selected:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 15%, var(--jt-accent-soft)) !important;
}

/* 批量勾选框：圆形（区别于方形完成框），16×16，未选空心灰圈，选中主色填充+白勾 */
.task-item__batch-check {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--jt-text-tertiary);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-right: 2px;
}

.task-item__batch-check:hover {
  border-color: var(--jt-primary);
}

.task-item__batch-check--on {
  background-color: var(--jt-primary);
  border-color: var(--jt-primary);
}

/* 键盘导航焦点状态（虚线边框，区别于选中的背景色） */
.task-item--focused {
  outline: 2px solid var(--jt-primary);
  outline-offset: -2px;
}

/* 拖拽排序视觉反馈 —— 与侧边栏清单节点（SidebarListNode）一致：
 * 整行 outline 高亮 + accent-soft 背景；不使用上下细线/半透明。 */
.task-item--drag-over {
  outline: 1.5px solid var(--jt-primary);
  outline-offset: -1.5px;
  background-color: var(--jt-accent-soft);
}

/* 可拖拽行：grab cursor（与清单行一致） */
.task-item[draggable="true"] {
  cursor: grab;
}
.task-item[draggable="true"]:active {
  cursor: grabbing;
}

/* 拖拽中的源行：半透明留在原位（与模板卡片 .tpl-card--dragging 一致） */
.task-item--dragging {
  opacity: 0.4;
}

/* 不可拖拽行（已完成任务 / 非手动排序）—— 在渲染层彻底阻止拖拽。
 * WKWebView (macOS) 中 draggable="false" 的元素其子文本节点仍默认可被
 * 原生拖拽，可能导致原生拖拽会话异常。-webkit-user-drag: none 是 WebKit
 * 专用属性，在渲染层阻止元素及其子元素启动拖拽，作为防御性保护。 */
.task-item[draggable="false"] {
  -webkit-user-drag: none;
}

.task-item__expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s;
}

.task-item__expand:hover {
  background-color: var(--jt-surface-hover);
}

/* 无子任务时的占位，保持缩进对齐 */
.task-item__expand-placeholder {
  display: block;
  width: 16px;
  height: 20px;
  flex-shrink: 0;
  margin-top: 1px;
}

.task-item__list-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* 笔记图标徽章（替代复选框位置，与复选框等宽对齐） */
.task-item__note-icon {
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
}

.task-item__body {
  flex: 1;
  min-width: 0;
}

.task-item__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
  line-height: 1.5;
  /* 单行显示，超出省略号（长标题不再撑高任务项） */
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.2s ease;
}

.task-item--done .task-item__title {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

/* 标题编辑输入框：与 .task-item__title 视觉一致（字号/字重/行高），
   避免编辑切换时跳动；width:100% 撑满 body（body 非 flex 容器，flex:1 无效），
   从优先级图标右侧延伸到更多按钮前；无边框无聚焦框 */
.task-item__title-input {
  display: block;
  width: 100%;
  font-size: 14px;
  font-weight: 500;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  line-height: 1.5;
  padding: 0;
  margin: 0;
  border: none;
  outline: none;
  background: transparent;
}

/* 标签 chips 行（标题下方独立一行） */
.task-item__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

/* 单个标签 chip —— 轻量视觉，不抢标题焦点 */
.task-item__tag {
  font-size: 11px;
  line-height: 1.4;
  padding: 0 6px;
  border-radius: 4px;
  background-color: var(--jt-accent-soft);
  color: var(--jt-text-secondary);
  white-space: nowrap;
}

/* 已完成任务的标签弱化（与标题删除线一致的处理） */
.task-item--done .task-item__tag {
  opacity: 0.5;
}

.task-item__meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--jt-text-secondary);
}

.task-item__recurrence {
  display: inline-flex;
  align-items: center;
  color: var(--jt-primary);
  opacity: 0.7;
}

.task-item__due {
  display: flex;
  align-items: center;
  gap: 2px;
}

.task-item__due--overdue {
  color: var(--jt-error);
}

.task-item__due--today {
  font-weight: 600;
}

/* 优先级火焰图标（常驻显示，无优先级时 v-if 不渲染）*/
.task-item__priority {
  flex-shrink: 0;
  margin-right: 4px;
}

.task-item__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.task-item:hover .task-item__actions {
  opacity: 1;
}

.task-item__menu-btn {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.task-item__menu-btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
/* 右键菜单的分组区分隔线和标签 */
.task-item__ctx-divider {
  height: 1px;
  background: var(--jt-border);
  margin: 4px 0;
}

/* 级联子菜单（优先级/标签/移动到分组）：Teleport 到 body，与一级菜单
 * （ContextMenu 的 .context-menu）外观保持一致。一级菜单样式是
 * ContextMenu.vue 的 scoped 样式，在本组件里复用类名匹配不到（scoped
 * 属性不同），必须显式补全，否则背景透明、无圆角阴影（与
 * BatchContextMenu 的 .batch-submenu 同理）。 */
.task-item-submenu {
  width: max-content;
  min-width: 120px;
  max-width: 220px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.16),
    0 4px 12px rgba(0, 0, 0, 0.08);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 子菜单项前置色点（移动至清单前显示清单色，与侧边栏/分组色点一致） */
.task-item-submenu__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}

</style>
