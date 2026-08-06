<script setup lang="ts">
// 任务详情面板 —— 滴答清单风格沉浸式
// 顶部 chips 行 + 大标题 + 无边框 Tiptap 描述/检查项 + 底部 footer
import { ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useRoute } from "vue-router";
import { Message } from "@arco-design/web-vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { useSettingsStore } from "@/stores/settings";
import type { ParsedSubtask } from "@/api/ai";
import { polishText } from "@/api/ai";
import {
  PRIORITY_LABELS,
  formatRecurrence,
  type Priority,
  type Task,
  type RecurrenceFreq,
} from "@/types";
// 日期工具不再直接使用 —— 详情面板的日期 chip 抽到 DueDateChip.vue 了
import TaskCheckbox from "./TaskCheckbox.vue";
import PriorityDot from "./PriorityDot.vue";
import RichTextEditor from "./RichTextEditor.vue";
import RichTextToolbar from "./RichTextToolbar.vue";
import PropertyChip from "./PropertyChip.vue";
import Popover from "./Popover.vue";
import DueDateChip from "./DueDateChip.vue";
import ReminderPopover from "./ReminderPopover.vue";
import RecurrencePopover from "./RecurrencePopover.vue";
import ListDragHandle from "./ListDragHandle.vue";
import AttachmentPopover from "./AttachmentPopover.vue";
import ChipPopover from "./ChipPopover.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import AiBreakdownPreview from "./AiBreakdownPreview.vue";
import AiPolishDialog from "./AiPolishDialog.vue";
import OutlinePanel from "./OutlinePanel.vue";
import { useAttachmentUpload } from "@/composables/useAttachmentUpload";
import * as db from "@/api/db";

const taskStore = useTaskStore();
const listStore = useListStore();
const tagStore = useTagStore();
const settingsStore = useSettingsStore();

// 附件上传（添加入口在 footer 的更多菜单里；taskId 随当前选中任务变化）
const { pickFiles: pickAttachmentFiles, uploading: attachmentUploading } =
  useAttachmentUpload(() => task.value?.id ?? "");

const props = defineProps<{
  panelWidth?: number;
  /** 拖拽宽度上限（默认 900；侧边栏收起时由 AppLayout 增大传入） */
  maxWidth?: number;
  /** 全屏态：面板横向铺满视口（盖住侧边栏+任务列表），隐藏拖拽手柄 */
  fullscreen?: boolean;
  /** 路由导航进行中强制隐藏（AppLayout 的 beforeEach 提前置 true，
   *  避免切非列表视图时 empty 占位闪现一帧） */
  forceHidden?: boolean;
}>();

const emit = defineEmits<{
  "update:panelWidth": [value: number];
  "update:fullscreen": [value: boolean];
}>();

/**
 * 悬浮 drawer 模式（日历/看板/时间线等全屏视图）：面板自己判断，不依赖外部 prop ——
 * 这些视图无选中任务时不渲染面板（不做 empty 占位，它们本身全屏）。
 * 与 AppLayout 的 isFloatingPanelView 保持一致，避免 prop 链失效时面板误渲染。
 */
const route = useRoute();
/**
 * 面板是否以「悬浮 drawer」模式工作（无选中任务时不渲染、不做 empty 占位）。
 *
 * empty 占位只属于列表视图（任务族 + 非悬浮）—— 即 today/upcoming/all/
 * list/notebook/tag 且 ?view 不是 kanban/timeline。其余视图（日历/看板/
 * 时间线/设置/习惯）一律视为悬浮，避免设置/习惯等全屏视图右侧冒出 empty 占位。
 * 路由未初始化时（reload 瞬间）也视为悬浮，避免面板先渲染一帧再消失闪现。
 */
const isFloatingView = computed<boolean>(() => {
  const name = route.name as string | undefined;
  const view = route.query.view as string | undefined;
  if (!name || name === "root") return true;
  // 非任务族视图（日历/设置/习惯）→ 悬浮
  const isTaskFamily =
    name === "today" ||
    name === "upcoming" ||
    name === "all" ||
    name === "list" ||
    name === "notebook" ||
    name === "tag";
  if (!isTaskFamily) return true;
  // 任务族内看板/时间线 → 悬浮
  return view === "kanban" || view === "timeline";
});

const task = computed(() => taskStore.selectedTask);
/** 当前选中条目是否为笔记（kind='note'）：隐藏日期/提醒/重复/复选框 */
const isNote = computed(() => task.value?.kind === "note");
/**
 * Transition 名称：进入悬浮视图/路由切换时跳过动画，避免面板滑出的多余动画。
 * 悬浮视图 name 设为空 → 无 transition → 直接卸载。
 * 注意：路由切换瞬间 route.name 更新有微任务延迟，isFloatingView 可能滞后一帧，
 * 导致 leave 动画短暂播放。此处判断同时考虑「无选中任务」—— 没任务的 leave
 * 一律跳过（empty 占位/残留态不需要动画）。
 */
const transitionName = computed(() =>
  isFloatingView.value || !task.value ? "" : "detail-drawer",
);
const titleDraft = ref("");
const noteDraft = ref("");

/**
 * empty 占位的背景装饰：散布在插画外空白区域的 ✦ 四角星（滴答清单风格）。
 * top/left/right/bottom 为相对面板的百分比定位，size 为星星边长像素。
 */
type StarDecoration = {
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  size: number;
};
const starDecorations: StarDecoration[] = [
  { top: "9%", left: "7%", size: 10 }, // 左上角：微星
  { top: "7%", right: "11%", size: 26 }, // 右上角：大星
  { top: "4%", left: "45%", size: 13 }, // 中上：小星
  { top: "22%", left: "32%", size: 9 }, // 中上偏左：微星
  { top: "30%", left: "56%", size: 12 }, // 中上偏右：小星
  { top: "46%", left: "12%", size: 8 }, // 中部偏左：微星
  { top: "34%", right: "16%", size: 8 }, // 中部偏右：微星
  { top: "58%", left: "22%", size: 8 }, // 中偏左下：微星
  { bottom: "34%", left: "6%", size: 20 }, // 左下：中星
  { bottom: "12%", left: "40%", size: 11 }, // 中下：小星
];

/** 星星的绝对定位样式（未配置的方位字段忽略） */
function starStyle(s: StarDecoration): Record<string, string> {
  return {
    top: s.top ?? "",
    bottom: s.bottom ?? "",
    left: s.left ?? "",
    right: s.right ?? "",
    width: s.size + "px",
    height: s.size + "px",
  };
}

/**
 * 当前任务的关联标签 —— 直接派生自 taskStore.taskTagMap（唯一数据源）。
 * 列表项、详情面板、侧边栏删除标签时都只维护这一份缓存，自动保持同步，
 * 避免原先「store 缓存 + 本地 ref」双数据源导致删除标签后界面不同步。
 */
const taskTags = computed<db.Tag[]>(() => {
  const id = task.value?.id;
  if (!id) return [];
  return taskStore.taskTagMap[id] ?? [];
});

/** 父任务链（面包屑导航）—— 从直接父级到根级 */
const parentChain = ref<Task[]>([]);

/** 加载父任务链 */
async function loadParentChain() {
  parentChain.value = [];
  if (!task.value?.parentId) return;
  let currentParentId: string | null = task.value.parentId;
  const chain: Task[] = [];
  while (currentParentId) {
    const parent = await db.getTaskById(currentParentId);
    if (!parent) break;
    chain.unshift(parent);
    currentParentId = parent.parentId;
  }
  parentChain.value = chain;
}

// 拖拽调宽
function startResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = props.panelWidth ?? 480;

  function onMouseMove(ev: MouseEvent) {
    const delta = startX - ev.clientX;
    const max = props.maxWidth ?? 900;
    const newWidth = Math.max(480, Math.min(max, startWidth + delta));
    emit("update:panelWidth", newWidth);
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

watch(
  () => task.value?.id,
  async (id) => {
    titleDraft.value = task.value?.title ?? "";
    noteDraft.value = task.value?.note ?? "";
    if (id) {
      await tagStore.loadTags();
      // 兜底：详情面板可能从 DB 单独加载任务（taskTagMap 无该任务条目），
      // 刷新一次确保 store 缓存有值，computed 才能正确派生标签。
      await taskStore.refreshTaskTags(id);
      await loadParentChain();
    } else {
      parentChain.value = [];
    }
  },
  { immediate: true },
);

// ─── 标题编辑 ─────────────────────────────────────
async function saveTitle() {
  if (!task.value) return;
  const trimmed = titleDraft.value.trim();
  if (trimmed && trimmed !== task.value.title) {
    await taskStore.updateTask(task.value.id, { title: trimmed });
  }
}

// ─── 描述编辑 ─────────────────────────────────────
async function saveNote(value: string) {
  if (!task.value) return;
  if (value !== task.value.note) {
    await taskStore.updateTask(task.value.id, { note: value });
  }
}

// ─── 优先级 ───────────────────────────────────────
const priority = computed<Priority>(() => task.value?.priority ?? 0);
const priorityColorValue = computed(() => {
  const map: Record<number, string> = {
    0: "var(--jt-text-tertiary)",
    1: "#3B82F6",
    2: "var(--jt-warning)",
    3: "var(--jt-error)",
  };
  return map[priority.value] ?? "var(--jt-text-tertiary)";
});
const priorityLabel = computed(() => {
  if (!task.value || task.value.priority === 0) return "优先级";
  return PRIORITY_LABELS[task.value.priority];
});

async function setPriority(p: Priority) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, { priority: p });
}

// ─── 清单 ─────────────────────────────────────────
/** 条目可移动到的清单下拉选项：仅未归档项（归档清单不应作为移动目标，
 *  避免任务"消失"在归档区但主页角标却不减）；按当前 task.kind 隔离两棵树
 *  （笔记详情面板只列笔记本/笔记本目录；任务详情面板只列清单/目录）。
 *  task 切换时自动重算。 */
const listOptions = computed(() => {
  const kind = task.value?.kind === "note" ? "note" : "task";
  const source = kind === "note" ? listStore.noteLists : listStore.taskLists;
  // 仅展示可承载条目的清单/笔记本本身，排除目录（目录仅作分组容器，不能放置任务）
  return source
    .filter((l) => !l.isFolder)
    .map((l) => ({ id: l.id, name: l.name, color: l.color }));
});
const currentList = computed(() =>
  listOptions.value.find((l) => l.id === task.value?.listId) ?? null,
);

async function moveToList(listId: string) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, { listId });
}

// ─── 日期 ─────────────────────────────────────────
// 详情面板的日期 chip + Popover 已抽到 DueDateChip，本文件只保留保存逻辑
async function onDateConfirm(start: string | null, end: string | null) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    dueStartAt: start,
    dueEndAt: end,
  });
  // 重置 notified_at：Tiptap 任务列表提醒依赖 dueEndAt 变化时重新触发
  await db.updateTask(task.value.id, { notifiedAt: null } as any);
}

async function onDateClear() {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    dueStartAt: null,
    dueEndAt: null,
  });
}

// ─── 提醒 ─────────────────────────────────────────
const remindLabel = computed(() => {
  if (!task.value || task.value.remindOffsetMinutes == null) return "提醒";
  const offset = task.value.remindOffsetMinutes;
  if (offset === 0) return "准点";
  if (offset < 60) return `提前 ${offset} 分钟`;
  if (offset < 1440) return `提前 ${Math.floor(offset / 60)} 小时`;
  return `提前 ${Math.floor(offset / 1440)} 天`;
});

async function onReminderConfirm(value: number | null) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    remindOffsetMinutes: value,
  });
  await db.updateTask(task.value.id, { notifiedAt: null } as any);
  reminderVisible.value = false;
}

async function onReminderClear() {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    remindOffsetMinutes: null,
  });
  reminderVisible.value = false;
}

// ─── 重复 ─────────────────────────────────────────
const recurrenceLabel = computed(() => {
  if (!task.value?.recurrenceFreq) return "重复";
  return formatRecurrence(task.value.recurrenceFreq, task.value.recurrenceInterval);
});

async function onRecurrenceConfirm(freq: RecurrenceFreq | null, interval: number) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    recurrenceFreq: freq,
    recurrenceInterval: interval,
  });
  recurrenceVisible.value = false;
}

// ─── 标签 ─────────────────────────────────────────
const availableTagOptions = computed(() =>
  tagStore.tags
    .filter((t) => !taskTags.value.some((tt) => tt.id === t.id))
    .map((t) => ({ id: t.id, name: t.name })),
);
const tagLabel = computed(() => {
  if (taskTags.value.length === 0) return "标签";
  if (taskTags.value.length === 1) return taskTags.value[0].name;
  return `${taskTags.value[0].name} +${taskTags.value.length - 1}`;
});

async function addExistingTag(tagId: string) {
  if (!task.value || !tagId) return;
  await db.addTaskTag(task.value.id, tagId);
  // 刷新 store 缓存（taskTagMap 是列表项 + 详情面板的唯一数据源）
  await taskStore.refreshTaskTags(task.value.id);
}

async function createNewTag(name: string) {
  const trimmed = (name || "").trim();
  if (!trimmed || !task.value) return;
  let tag = tagStore.getByName(trimmed);
  if (!tag) {
    tag = await tagStore.createTag(trimmed);
  }
  await db.addTaskTag(task.value.id, tag.id);
  // 刷新 store 缓存（taskTagMap 是列表项 + 详情面板的唯一数据源）
  await taskStore.refreshTaskTags(task.value.id);
}

async function removeTaskTag(tagId: string) {
  if (!task.value) return;
  await db.removeTaskTag(task.value.id, tagId);
  // 刷新 store 缓存（taskTagMap 是列表项 + 详情面板的唯一数据源）
  await taskStore.refreshTaskTags(task.value.id);
}

// ─── 弹层显隐状态 ───────────────────────────────
const reminderVisible = ref(false);
const recurrenceVisible = ref(false);
const priorityVisible = ref(false);
const tagVisible = ref(false);
const listVisible = ref(false);
const moreVisible = ref(false);
/** 富文本工具条浮窗（footer "A" 按钮控制） */
const formatToolbarVisible = ref(false);
/** 大纲浮层面板（footer 大纲按钮控制） */
const outlineVisible = ref(false);
/** 删除二次确认弹窗 */
const deleteConfirmVisible = ref(false);
/** 附件下拉浮窗（chips 行点 📎 触发） */
const attachmentDrawerVisible = ref(false);

/** 汇报「详情面板是否有任意浮层打开」到 task store。
 *  AppLayout 的 ESC 守卫据此实现逐层关闭：有浮层时只关浮层，不关详情面板。
 *  采用显式状态汇总，避开 Arco popover 关闭动画期间 DOM 节点残留导致检测失真。 */
watch(
  [
    reminderVisible,
    recurrenceVisible,
    priorityVisible,
    tagVisible,
    listVisible,
    moreVisible,
    formatToolbarVisible,
    deleteConfirmVisible,
    attachmentDrawerVisible,
  ],
  (states) => {
    taskStore.setDetailOverlay(states.some(Boolean));
  },
);

/** 切换任务时关闭附件浮窗，避免跨任务残留视图 */
watch(
  () => task.value?.id,
  () => {
    attachmentDrawerVisible.value = false;
  },
);
/** RichTextEditor 实例引用（用于工具条调用命令） */
const richTextEditorRef = ref<InstanceType<typeof RichTextEditor> | null>(null);

// ─── 完成切换 ─────────────────────────────────────
async function onToggle() {
  if (!task.value) return;
  await taskStore.toggleTask(task.value.id, !task.value.done);
}

// ─── 删除（二次确认）──────────────────────────────
/** 打开删除确认弹窗（更多菜单点击"删除任务"时调用） */
function askDelete() {
  if (!task.value) return;
  deleteConfirmVisible.value = true;
}

/** 实际执行删除（用户在确认弹窗里点"删除"时调用） */
async function doDelete() {
  if (!task.value) return;
  await taskStore.deleteTask(task.value.id);
  deleteConfirmVisible.value = false;
}

// ─── 更多菜单操作 ─────────────────────────────────

/**
 * 在描述末尾插入一个空的 taskList（检查项）
/** 添加一个新检查项（独立字段 task.checklist） */
async function insertChecklistItem() {
  if (!task.value) return;
  await taskStore.addChecklistItem(task.value.id, "");
  // 滚动到新加的检查项
  await nextTick();
  const inputs = document.querySelectorAll<HTMLInputElement>(
    '.detail-panel__checklist-input',
  );
  const last = inputs[inputs.length - 1];
  if (last) {
    last.focus();
    last.select();
  }
}

/** 切换检查项完成态 */
async function toggleChecklistItem(itemId: string) {
  if (!task.value) return;
  await taskStore.toggleChecklistItem(task.value.id, itemId);
}

/** 删除检查项 */
async function removeChecklistItem(itemId: string) {
  if (!task.value) return;
  await taskStore.removeChecklistItem(task.value.id, itemId);
}

/** 失焦保存检查项的 title 改动 */
async function saveChecklistItem(itemId: string, blurEvent?: FocusEvent) {
  if (!task.value) return;
  const item = task.value.checklist.find((it) => it.id === itemId);
  if (!item) return;
  const trimmed = item.title.trim();
  if (!trimmed) {
    // 空标题处理：
    // - 若焦点转移到了另一个检查项 input（回车新建/上下导航），保留当前空项
    // - 否则（用户点别处离开）删除空项
    const wentToChecklist = blurEvent?.relatedTarget instanceof HTMLInputElement
      && blurEvent.relatedTarget.classList.contains("detail-panel__checklist-input");
    if (!wentToChecklist) {
      await removeChecklistItem(itemId);
    }
    return;
  }
  if (trimmed !== item.title) {
    await taskStore.updateChecklistItem(task.value.id, itemId, { title: trimmed });
  }
}

/**
 * 检查项回车处理（Notion 风格）：
 * 回车 → 在当前项下方新建一个空检查项，并把焦点移过去。
 * - 有内容时先保存规范化当前项；
 * - 空项回车同样新建下一行（空项的清理交给"点别处失焦"路径）。
 */
async function onChecklistEnter(itemId: string) {
  if (!task.value) return;
  const item = task.value.checklist.find((it) => it.id === itemId);
  const hasText = !!(item?.title ?? "").trim();
  // 有内容：先保存当前项（trim 规范化）
  if (hasText) {
    await saveChecklistItem(itemId);
  }
  // 在当前项后插入新空项
  const newId = await taskStore.insertChecklistItemAfter(task.value.id, itemId, "");
  if (!newId) return;
  // 聚焦新项（DOM 更新后通过 data-item-id 精确定位）
  await nextTick();
  focusChecklistInput(newId);
}

/**
 * 把焦点移到指定检查项 input（DOM 更新后通过 data-item-id 精确定位）。
 * 切换焦点时，光标默认置于行尾，符合"继续编辑上一行"的直觉。
 */
function focusChecklistInput(itemId: string) {
  const input = document.querySelector<HTMLInputElement>(
    `.detail-panel__checklist-input[data-item-id="${itemId}"]`,
  );
  if (!input) return;
  input.focus();
  // 光标置于行尾
  const len = input.value.length;
  input.setSelectionRange(len, len);
}

/**
 * 检查项键盘操作统一入口：
 * - Enter：新建下一行（onChecklistEnter）
 * - Backspace：当前项为空且光标在行首 → 删除该项，焦点上移到上一项
 * - ArrowUp / ArrowDown：在检查项之间切换焦点（不改变内容）
 * 其余按键交给浏览器默认行为。
 */
async function onChecklistKeydown(itemId: string, e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    await onChecklistEnter(itemId);
    return;
  }
  if (e.key === "Backspace") {
    await onChecklistBackspace(itemId, e);
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    focusChecklistSibling(itemId, e.key === "ArrowUp" ? "up" : "down");
  }
}

/**
 * Backspace 处理：仅当当前项内容为空、且光标在行首时，删除该项并把焦点移到上一项。
 * 若当前项有内容，或光标不在行首（用户正在编辑中间的文字），交给浏览器默认删除。
 */
async function onChecklistBackspace(itemId: string, e: KeyboardEvent) {
  const input = e.target as HTMLInputElement;
  if (!task.value) return;
  const item = task.value.checklist.find((it) => it.id === itemId);
  const isEmpty = !(item?.title ?? "").length;
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  if (!isEmpty || !atStart) return; // 有内容或选区不在行首 → 默认删除
  e.preventDefault();
  // 删除前先算出目标项（删除后 sortedChecklist 会变，之后取不到原索引）
  const sortedIds = sortedChecklist.value.map((it) => it.id);
  const removedIdx = sortedIds.indexOf(itemId);
  const prevId = removedIdx > 0 ? sortedIds[removedIdx - 1] : (sortedIds[1] ?? null);
  // 删除当前空项
  await removeChecklistItem(itemId);
  // 焦点上移到上一项；若被删的是首项，则移到新的首项
  if (prevId) {
    await nextTick();
    focusChecklistInput(prevId);
  }
}

/** 在检查项之间切换焦点（上下方向键）。direction: up = 上一项, down = 下一项 */
function focusChecklistSibling(itemId: string, direction: "up" | "down") {
  const ids = sortedChecklist.value.map((it) => it.id);
  const idx = ids.indexOf(itemId);
  if (idx === -1) return;
  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= ids.length) return; // 已到边界
  focusChecklistInput(ids[targetIdx]);
}

/** 按 order 排序的检查项 */
const sortedChecklist = computed(() => {
  if (!task.value) return [];
  return [...task.value.checklist].sort((a, b) => a.order - b.order);
});

/** 创建任务/笔记副本（保留 kind，笔记副本同样无日期/完成/重复/提醒） */
async function duplicateTask() {
  if (!task.value) return;
  const t = task.value;
  // createTask 只支持基础字段，recurrence/reminder/note 走 update
  const newTask = await taskStore.createTask({
    title: `${t.title}（副本）`,
    listId: t.listId,
    priority: t.priority,
    dueStartAt: t.dueStartAt,
    dueEndAt: t.dueEndAt,
    kind: t.kind,
  });
  if (newTask) {
    await taskStore.updateTask(newTask.id, {
      note: t.note ?? "",
      recurrenceFreq: t.recurrenceFreq,
      recurrenceInterval: t.recurrenceInterval,
      remindOffsetMinutes: t.remindOffsetMinutes,
    });
  }
}

/** 添加子任务：在当前任务下创建一条新任务（子任务会出现在主面板树形列表里） */
async function addSubtask() {
  if (!task.value) return;
  await taskStore.createSubtask(task.value, "");
  // 重新加载当前任务的子任务，确保详情面板能拉到
  await taskStore.loadSubtasks(task.value.id);
  // 选中新建的子任务，方便用户直接输入标题
  const sub = taskStore.subtasks[taskStore.subtasks.length - 1];
  if (sub) taskStore.selectTask(sub.id);
}

// ─── AI 任务拆解：把大任务拆成多个子任务（预览后批量创建） ───
/** AI 拆解预览是否显示 */
const breakdownVisible = ref(false);

/** 打开 AI 拆解预览 */
function openBreakdown(): void {
  if (!task.value) return;
  breakdownVisible.value = true;
}

/** AI 拆解确认：把编辑后的子任务草稿批量创建为当前任务的子任务 */
async function onBreakdownConfirm(subs: ParsedSubtask[]): Promise<void> {
  if (!task.value) return;
  const parent = task.value;
  // 串行创建（避免并发导致 sort_order 冲突），每条都带完整字段
  for (const sub of subs) {
    const created = await taskStore.createTask({
      title: sub.title.trim(),
      listId: parent.listId,
      parentId: parent.id,
      kind: parent.kind,
      priority: sub.priority as Priority,
      dueStartAt: sub.dueStartAt,
      dueEndAt: sub.dueEndAt,
    });
    // 备注（note）走 update，createTask 不支持 note 字段
    if (sub.note) {
      await taskStore.updateTask(created.id, { note: sub.note });
    }
  }
  // 刷新两份子任务缓存：
  // subtasks 供详情面板，subtaskCache 供主列表树形（getCachedSubtasks）。
  // createTask 不维护 subtaskCache（与 createSubtask 不同），必须显式刷新。
  await Promise.all([
    taskStore.loadSubtasks(parent.id),
    taskStore.loadSubtasksToCache(parent.id),
  ]);
  breakdownVisible.value = false;
  Message.success(`已创建 ${subs.length} 个子任务`);
}

/** 取消 AI 拆解预览 */
function onBreakdownCancel(): void {
  breakdownVisible.value = false;
}

// ─── AI 文本润色：选中文字或整篇 note 用 AI 优化文笔 ───
/** 润色弹窗是否可见 */
const polishVisible = ref(false);
/** 原始文本（润色前，HTML） */
const polishOriginal = ref("");
/** 润色结果（流式增长，HTML） */
const polishResult = ref("");
/** 润色加载中 */
const polishLoading = ref(false);
/** 润色错误信息 */
const polishError = ref("");
/** 润色时是否有选区（决定写回方式：替换选区 vs 替换全文） */
const polishHasSelection = ref(false);
/** 润色时选区位置（写回时用） */
let polishSelectionRange: { from: number; to: number } | null = null;

/** 打开 AI 润色：取选区文字或整篇 note，调 polishText 流式获取结果 */
async function openPolish(): Promise<void> {
  const editor = richTextEditorRef.value?.editor;
  if (!editor) return;

  // 取选区
  const { from, to, empty } = editor.state.selection;
  let text: string;
  if (!empty && to > from) {
    // 有选区：取选中的 HTML 片段
    text = editor.state.doc.slice(from, to).content.size > 0
      ? getSelectionHtml(editor, from, to)
      : "";
    polishHasSelection.value = true;
    polishSelectionRange = { from, to };
  } else {
    // 无选区：取整篇
    text = editor.getHTML();
    polishHasSelection.value = false;
    polishSelectionRange = null;
  }

  if (!text.trim()) {
    Message.warning("没有可润色的内容");
    return;
  }

  // 打开弹窗 + 发起流式润色
  polishOriginal.value = text;
  polishResult.value = "";
  polishError.value = "";
  polishLoading.value = true;
  polishVisible.value = true;

  const res = await polishText(text, (delta) => {
    polishResult.value += delta;
  });
  polishLoading.value = false;
  if (res.ok && res.content) {
    polishResult.value = res.content;
  } else {
    polishError.value = res.message ?? "润色失败";
  }
}

/** 从 Tiptap editor 取选区的 HTML（ProseMirror fragment → HTML 字符串） */
function getSelectionHtml(editor: any, from: number, to: number): string {
  const slice = editor.state.doc.slice(from, to);
  const div = document.createElement("div");
  div.append(slice.content.toDOM(document));
  return div.innerHTML;
}

/** 确认润色：把用户编辑后的结果写回编辑器 */
function onPolishConfirm(editedText: string): void {
  const editor = richTextEditorRef.value?.editor;
  if (!editor || !editedText) return;

  if (polishHasSelection.value && polishSelectionRange) {
    // 有选区：删除选中内容，插入润色结果
    const { from, to } = polishSelectionRange;
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContentAt(from, editedText)
      .run();
  } else {
    // 无选区：整体替换
    editor.commands.setContent(editedText);
  }
  // 写回后 editor 的 onUpdate 会触发 update:modelValue → 自动 saveNote
  polishVisible.value = false;
}

/** 取消润色 */
function onPolishCancel(): void {
  polishVisible.value = false;
}


// ─── 标题编辑：textarea（无边框、自动撑高；Enter 保存 / Esc 还原） ───
const titleEl = ref<HTMLTextAreaElement | null>(null);

function onTitleBlur() {
  if (!task.value) return;
  if (titleDraft.value !== (task.value.title ?? "")) {
    saveTitle();
  }
}

function onTitleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    (e.target as HTMLTextAreaElement).blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    titleDraft.value = task.value?.title ?? "";
    (e.target as HTMLTextAreaElement).blur();
  }
}

// ─── 优先级下拉渲染（已用 <PriorityDot> 替代） ───────
// PRIORITY_DOT_COLORS 由 PriorityDot 组件内部处理

// ─── 窄屏检测（次要 chip 塌缩为纯图标） ───────────
const panelEl = ref<HTMLElement | null>(null);
const narrow = ref(false);
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

/* === checklist 拖拽排序容器 ref（供 ListDragHandle 使用） === */
const checklistContainerRef = ref<HTMLElement | null>(null);

/** 拖动 checklist：把 fromIdx 的项移到 toIdx 位置
 *  —— store 调 updateChecklistItem 把整条 checklist 重排 + 重写 order */
async function onChecklistReorder(fromIndex: number, toIndex: number) {
  if (!task.value) return;
  await taskStore.reorderChecklist(task.value.id, fromIndex, toIndex);
}

onMounted(() => {
  if (!panelEl.value || typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (panelEl.value) {
        narrow.value = panelEl.value.clientWidth < 480;
      }
    }, 100);
  });
  resizeObserver.observe(panelEl.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (resizeTimer) clearTimeout(resizeTimer);
  // 详情面板卸载时复位浮层标记，避免 AppLayout ESC 守卫读到残留 true
  taskStore.setDetailOverlay(false);
});
</script>

<template>
  <Transition :name="transitionName">
  <div
    ref="panelEl"
    v-if="(!isFloatingView || task) && !forceHidden"
    class="detail-panel"
    :class="{ 'detail-panel--fullscreen': fullscreen }"
    :style="fullscreen ? {} : { width: (panelWidth ?? 480) + 'px' }"
  >
    <!-- 未选中任务时：empty 占位（面板始终占位，任务列表不拉伸） -->
    <!-- 拖拽手柄（始终渲染：empty 占位态也能拖拽调宽） -->
    <div v-if="!fullscreen" class="detail-panel__resizer" @mousedown="startResize" />

    <!-- 未选中任务时：empty 占位（面板始终占位，任务列表不拉伸） -->
    <div v-if="!task" class="detail-panel__empty">
      <!-- 背景星星装饰：散布在插画外空白区域（滴答清单风格，四角星 ✦） -->
      <svg
        v-for="(s, i) in starDecorations"
        :key="i"
        class="detail-panel__star"
        :style="starStyle(s)"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M12,2.5 L13.6,10.4 L21.5,12 L13.6,13.6 L12,21.5 L10.4,13.6 L2.5,12 L10.4,10.4 Z"
          stroke="var(--jt-empty-art)"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
      </svg>
      <!-- 滴答清单风格手绘线稿插画：极淡灰细描边、无填充、无卡片。
           元素小尺寸散落，相互间距 ≥ 书宽 15%，只保留铅笔搭书角一处有意接触 -->
      <div class="detail-panel__empty-art">
        <svg width="340" height="215" viewBox="0 0 380 240" fill="none" xmlns="http://www.w3.org/2000/svg">
          <g
            stroke="var(--jt-empty-art)"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <!-- 翻开的笔记本（主体，居中）：书脊 + 左右两页透视 + 模拟文字行 -->
            <g transform="translate(185,70)">
              <path d="M0,0 L0,105" />
              <path d="M0,0 L-58,17 L-58,116 L0,105 Z" />
              <path d="M0,0 L58,17 L58,116 L0,105 Z" />
              <path d="M-42,40 L-12,33 M-42,60 L-19,54 M-42,80 L-26,75" />
              <path d="M12,33 L42,40 M19,54 L42,60 M26,75 L42,80" />
            </g>
            <!-- 铅笔（右上，笔尖轻搭在书右上角） -->
            <g transform="translate(238,26) rotate(40)">
              <rect x="-4" y="-10" width="8" height="10" rx="2.5" />
              <rect x="-4" y="0" width="8" height="52" rx="2.5" />
              <path d="M-4,52 L4,52 L0,64 Z" />
            </g>
            <!-- 咖啡杯 + 杯碟（左下，独立散落） -->
            <g transform="translate(40,192)">
              <ellipse cx="0" cy="26" rx="34" ry="9" />
              <path d="M-29,0 L29,0 L22,14 Q0,23 -22,14 Z" />
              <ellipse cx="0" cy="0" rx="24" ry="6" />
              <path d="M29,3 Q44,0 42,14 Q40,24 24,21" />
            </g>
            <!-- 待办便签条（左中，与书留有间距） -->
            <g transform="translate(16,86)">
              <rect x="0" y="0" width="90" height="36" rx="5" />
              <path d="M0,4 L0,0 L4,0" />
              <rect x="10" y="10" width="14" height="14" rx="4" />
              <path d="M14,17 L18,21 L21,14" />
              <rect x="30" y="10" width="14" height="14" rx="4" />
              <path d="M51,13 L82,13 M51,22 L70,22" />
            </g>
            <!-- 笑脸便签（右下，与书留有间距）+ 叠角小签 -->
            <g transform="translate(258,150)">
              <rect x="0" y="0" width="46" height="46" rx="8" />
              <path d="M14,27 Q23,34 32,27" />
              <circle cx="12" cy="16" r="1.9" fill="var(--jt-empty-art)" stroke="none" />
              <circle cx="31" cy="16" r="1.9" fill="var(--jt-empty-art)" stroke="none" />
              <rect x="26" y="-16" width="18" height="18" rx="4" />
            </g>
            <!-- 四角星 sparkle（✦ 空心线稿），散布四周留白处 -->
            <path d="M58,23 L60.9,26.9 L65,30 L60.9,33.1 L58,37 L55.1,33.1 L51,30 L55.1,26.9 Z" />
            <path d="M168,6 L169.8,9.2 L173,11 L169.8,12.8 L168,16 L166.2,12.8 L163,11 L166.2,9.2 Z" />
            <path d="M330,70 L332.9,73.9 L337,77 L332.9,80.1 L330,84 L327.1,80.1 L323,77 L327.1,73.9 Z" />
            <path d="M150,214 L152.4,217.6 L156,220 L152.4,222.4 L150,226 L147.6,222.4 L144,220 L147.6,217.6 Z" />
            <path d="M330,212.5 L331.6,215.4 L334.5,217 L331.6,218.6 L330,221.5 L328.4,218.6 L325.5,217 L328.4,215.4 Z" />
          </g>
          <!-- 散落的圆点（与线条同色的实心小点） -->
          <circle cx="108" cy="52" r="2.5" fill="var(--jt-empty-art)" />
          <circle cx="352" cy="160" r="2.5" fill="var(--jt-empty-art)" />
          <circle cx="120" cy="222" r="2.5" fill="var(--jt-empty-art)" />
          <circle cx="300" cy="26" r="2.5" fill="var(--jt-empty-art)" />
        </svg>
      </div>
    </div>
    <template v-else>
    <!-- 顶部 chips 行 -->
    <div class="detail-panel__chips">
      <div v-if="!isNote" class="detail-panel__checkbox-wrap">
        <TaskCheckbox
          v-if="task"
          :done="task.done"
          @toggle="onToggle"
          :size="20"
        />
      </div>

      <a-divider v-if="!narrow && !isNote" direction="vertical" :margin="6" />

      <!-- 日期（关键属性，窄屏仍显示文字；笔记无日期，隐藏） -->
      <DueDateChip
        v-if="!isNote"
        :start-iso="task.dueStartAt"
        :end-iso="task.dueEndAt"
        @confirm="onDateConfirm"
        @clear="onDateClear"
      />

      <!-- 提醒（默认只图标 + a-tooltip 黑气泡；笔记无提醒，隐藏） -->
      <a-tooltip v-if="!isNote" :content="remindLabel" position="bottom">
        <ChipPopover v-model:visible="reminderVisible">
          <PropertyChip
            :active="task.remindOffsetMinutes != null"
            icon-only
            :title="remindLabel"
            @click="reminderVisible = !reminderVisible"
          >
            <template #icon>
              <icon-notification :size="14" />
            </template>
          </PropertyChip>
          <template #content>
            <ReminderPopover
              :value="task.remindOffsetMinutes"
              @confirm="onReminderConfirm"
              @clear="onReminderClear"
            />
          </template>
        </ChipPopover>
      </a-tooltip>

      <!-- 重复（笔记无重复，隐藏） -->
      <a-tooltip v-if="!isNote" :content="recurrenceLabel" position="bottom">
        <ChipPopover v-model:visible="recurrenceVisible">
          <PropertyChip
            :active="!!task.recurrenceFreq"
            icon-only
            :title="recurrenceLabel"
            @click="recurrenceVisible = !recurrenceVisible"
          >
            <template #icon>
              <icon-refresh :size="14" />
            </template>
          </PropertyChip>
          <template #content>
            <RecurrencePopover
              :freq="task.recurrenceFreq"
              :interval="task.recurrenceInterval"
              @confirm="onRecurrenceConfirm"
            />
          </template>
        </ChipPopover>
      </a-tooltip>

      <!-- 优先级 -->
      <a-tooltip :content="priorityLabel" position="bottom">
        <ChipPopover v-model:visible="priorityVisible">
          <PropertyChip
            :active="task.priority > 0"
            icon-only
            :title="priorityLabel"
            :style="task.priority > 0 ? { color: priorityColorValue } : {}"
            @click="priorityVisible = !priorityVisible"
          >
            <template #icon>
              <icon-fire :size="14" />
            </template>
          </PropertyChip>
          <template #content>
            <div class="detail-panel__popup">
              <button
                v-for="(label, p) in PRIORITY_LABELS"
                :key="p"
                type="button"
                class="detail-panel__popup-item"
                :class="{ 'detail-panel__popup-item--active': Number(p) === task.priority }"
                @click="setPriority(Number(p) as Priority); priorityVisible = false"
              >
                <PriorityDot :priority="(Number(p) as Priority)" :size="10" />
                <span>{{ label }}</span>
              </button>
            </div>
          </template>
        </ChipPopover>
      </a-tooltip>

      <!-- 标签 -->
      <a-tooltip :content="tagLabel" position="bottom">
        <ChipPopover v-model:visible="tagVisible">
          <PropertyChip
            :active="taskTags.length > 0"
            icon-only
            :title="tagLabel"
            @click="tagVisible = !tagVisible"
          >
            <template #icon>
              <icon-tag :size="14" />
            </template>
          </PropertyChip>
          <template #content>
            <div class="detail-panel__popup detail-panel__popup--tag">
              <button
                v-for="opt in availableTagOptions"
                :key="opt.id"
                type="button"
                class="detail-panel__popup-item"
                @click="addExistingTag(opt.id); tagVisible = false"
              >
                <icon-tag :size="12" />
                <span>{{ opt.name }}</span>
              </button>
              <a-input
                placeholder="+ 新建标签"
                size="mini"
                allow-clear
                style="margin-top: 4px"
                @keydown.enter="(e: any) => { createNewTag(e.target.value); (e.target as HTMLInputElement).value = ''; tagVisible = false; }"
              />
            </div>
          </template>
        </ChipPopover>
      </a-tooltip>

      <!-- 附件（点击弹出下拉浮窗查看附件列表，带箭头指向 chip；
           颜色与其他 chip 一致：默认 --jt-text-tertiary，
           active 仅在浮窗打开中（不再因为有附件就高亮，避免视觉抢眼）） -->
      <a-tooltip
        :content="task.attachments.length ? `附件 (${task.attachments.length})` : '附件'"
        position="bottom"
      >
        <AttachmentPopover
          v-model:visible="attachmentDrawerVisible"
          :task-id="task.id"
          :attachments="task.attachments"
        >
          <PropertyChip
            :active="task.attachments.length > 0"
            icon-only
            :title="task.attachments.length ? `附件 (${task.attachments.length})` : '附件'"
          >
            <template #icon>
              <icon-attachment :size="14" />
            </template>
            {{ task.attachments.length }}
          </PropertyChip>
        </AttachmentPopover>
      </a-tooltip>

      <!-- 行末：添加检查项（用 margin-left: auto 推至行最右，替代原"更多"按钮位置） -->
      <div class="detail-panel__chips-tail">
        <!-- AI 拆解任务（仅 AI 启用时显示） -->
        <button
          v-if="settingsStore.aiEnabled"
          class="detail-panel__more-btn detail-panel__ai-btn"
          title="AI 拆解任务"
          @click="openBreakdown"
        >
          <icon-robot :size="16" />
        </button>
        <button
          class="detail-panel__more-btn"
          title="添加检查项"
          @click="insertChecklistItem()"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <rect x="2" y="3.5" width="12" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="7.25" width="9" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="11" width="6" height="1.5" rx="0.75" fill="currentColor" />
          </svg>
        </button>
        <!-- 全屏切换（铺满视口 / 恢复固定宽） -->
        <button
          class="detail-panel__more-btn"
          :title="fullscreen ? '退出全屏' : '全屏'"
          @click="emit('update:fullscreen', !fullscreen)"
        >
          <icon-fullscreen-exit v-if="fullscreen" :size="16" />
          <icon-fullscreen v-else :size="16" />
        </button>
        <!-- 关闭详情面板（与 ESC 快捷键行为一致：清空选中任务） -->
        <button
          class="detail-panel__more-btn"
          title="关闭"
          @click="taskStore.selectTask(null)"
        >
          <icon-close :size="16" />
        </button>
      </div>
    </div>

    <!-- 标签 chip 列表（已关联的） -->
    <div v-if="taskTags.length" class="detail-panel__tag-list">
      <a-tag
        v-for="tag in taskTags"
        :key="tag.id"
        size="small"
        closable
        @close="removeTaskTag(tag.id)"
      >
        {{ tag.name }}
      </a-tag>
    </div>

    <!-- 面包屑（父任务链）
         整条链路显示在一个胶囊里：祖父 / 父 / 父亲名
         整胶囊可点击 → 返回到直接父任务
         每段单独可点击 → 跳到该祖辈 -->
    <div v-if="parentChain.length" class="detail-panel__breadcrumb">
      <div class="detail-panel__breadcrumb-back">
        <template v-for="(p, i) in parentChain" :key="p.id">
          <button
            class="detail-panel__breadcrumb-back-item"
            :title="i === parentChain.length - 1 ? `返回：${p.title}` : `跳转到：${p.title}`"
            @click="taskStore.selectTask(p.id)"
          >
            <span class="detail-panel__breadcrumb-text">{{ p.title }}</span>
          </button>
          <span v-if="i < parentChain.length - 1" class="detail-panel__breadcrumb-sep">/</span>
        </template>
      </div>
    </div>

    <!-- 主区：标题 + 描述 -->
    <div class="detail-panel__main">
      <!-- 大标题（textarea，无边框，自动撑高；空时显示 placeholder） -->
      <textarea
        ref="titleEl"
        v-model="titleDraft"
        class="detail-panel__title"
        :class="{ 'detail-panel__title--done': task.done }"
        rows="1"
        placeholder="准备做什么?"
        spellcheck="false"
        @blur="onTitleBlur"
        @keydown="onTitleKeydown"
      />

      <!-- 描述（无边框 Tiptap；工具条由 footer "A" 按钮浮出） -->
      <RichTextEditor
        ref="richTextEditorRef"
        :model-value="noteDraft"
        borderless
        placeholder="输入内容或使用 / 快速插入"
        @update:model-value="(v) => { noteDraft = v; saveNote(v); }"
      />

      <!-- AI 任务拆解预览（点「AI 拆解」按钮后出现，确认后批量创建子任务） -->
      <AiBreakdownPreview
        v-if="breakdownVisible"
        :source="{ type: 'breakdown', taskId: task.id }"
        @confirm="onBreakdownConfirm"
        @cancel="onBreakdownCancel"
      />

      <!-- 检查项区（独立于描述） -->
      <div
        ref="checklistContainerRef"
        class="detail-panel__checklist"
      >
        <div
          v-for="item in sortedChecklist"
          :key="item.id"
          class="detail-panel__checklist-item"
          :class="{ 'detail-panel__checklist-item--done': item.done }"
        >
          <button
            class="detail-panel__checklist-check"
            :aria-label="item.done ? '取消完成' : '标记完成'"
            @click="toggleChecklistItem(item.id)"
          >
            <icon-check v-if="item.done" :size="12" />
          </button>
          <input
            v-model="item.title"
            class="detail-panel__checklist-input"
            :class="{ 'detail-panel__checklist-input--done': item.done }"
            :data-item-id="item.id"
            placeholder="请输入检查信息"
            @blur="saveChecklistItem(item.id, $event)"
            @keydown="onChecklistKeydown(item.id, $event)"
          />
          <button
            class="detail-panel__checklist-remove"
            title="删除"
            @click="removeChecklistItem(item.id)"
          >
            <icon-close :size="12" />
          </button>
        </div>
        <!-- 拖拽手柄 + 落点横线（绝对定位在容器内，不抢 input 焦点） -->
        <ListDragHandle
          :container-ref="checklistContainerRef"
          item-selector=".detail-panel__checklist-item"
          :on-move="onChecklistReorder"
        />
      </div>

      <!-- 附件区已迁移到 AttachmentDrawer：chips 行点 📎 打开抽屉查看 -->
    </div>

    <!-- 底部 footer -->
    <div class="detail-panel__footer">
      <!-- 当前清单 -->
      <Popover v-model:visible="listVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip compact :active="!!currentList" @click="listVisible = !listVisible">
            <template #icon>
              <icon-folder :size="12" />
            </template>
            {{ currentList?.name ?? "选择清单" }}
          </PropertyChip>
        </template>
        <div class="detail-panel__popup detail-panel__popup--list">
          <button
            v-for="opt in listOptions"
            :key="opt.id"
            type="button"
            class="detail-panel__popup-item"
            :class="{ 'detail-panel__popup-item--active': opt.id === task.listId }"
            @click="moveToList(opt.id); listVisible = false"
          >
            <span
              class="detail-panel__list-dot"
              :style="{ backgroundColor: opt.color }"
            />
            <span>{{ opt.name }}</span>
          </button>
        </div>
      </Popover>

      <span style="flex: 1" />

      <span class="detail-panel__meta">
        {{ formatMeta(task.createdAt) }}
      </span>

      <!-- 大纲（提取富文本标题树，点击跳转 + 当前章节高亮） -->
      <button
        class="detail-panel__format-btn"
        :class="{ 'detail-panel__format-btn--active': outlineVisible }"
        title="大纲"
        @click="outlineVisible = !outlineVisible"
      >
        <icon-list :size="16" />
      </button>

      <!-- AI 文本润色（仅 AI 启用时显示；选中文字润色选中段，无选区润色整篇） -->
      <button
        v-if="settingsStore.aiEnabled"
        class="detail-panel__format-btn detail-panel__ai-btn"
        title="AI 润色"
        @click="openPolish"
      >
        <icon-edit :size="16" />
      </button>

      <!-- 富文本工具条入口（滴答清单风格：footer "A" 按钮 + 浮出工具条） -->
      <Popover v-model:visible="formatToolbarVisible" placement="top-right" :offset="48">
        <template #trigger>
          <button
            class="detail-panel__format-btn"
            :class="{ 'detail-panel__format-btn--active': formatToolbarVisible }"
            title="文字格式"
            @click="formatToolbarVisible = !formatToolbarVisible"
          >
            <span class="detail-panel__format-btn-text">A</span>
          </button>
        </template>
        <div class="detail-panel__format-popup">
          <RichTextToolbar
            v-if="richTextEditorRef"
            :editor="richTextEditorRef.editor"
            compact
          />
        </div>
      </Popover>

      <!-- 更多菜单（从顶部 chip 行移到 footer） -->
      <Popover v-model:visible="moreVisible" placement="top-right">
        <template #trigger>
          <button class="detail-panel__more-btn" title="更多" @click="moreVisible = !moreVisible">
            <icon-more :size="16" />
          </button>
        </template>
        <div class="detail-panel__popup detail-panel__popup--more">
          <button
            type="button"
            class="detail-panel__popup-item"
            :disabled="attachmentUploading"
            :title="attachmentUploading ? '上传中…' : '添加附件'"
            @click="pickAttachmentFiles(); moreVisible = false"
          >
            <icon-attachment :size="14" />
            <span>{{ attachmentUploading ? "上传中…" : "添加附件" }}</span>
          </button>
          <button
            type="button"
            class="detail-panel__popup-item"
            @click="addSubtask(); moreVisible = false"
          >
            <icon-plus :size="14" />
            <span>{{ isNote ? "添加子笔记" : "添加子任务" }}</span>
          </button>
          <button
            type="button"
            class="detail-panel__popup-item"
            @click="duplicateTask(); moreVisible = false"
          >
            <icon-copy :size="14" />
            <span>创建副本</span>
          </button>
          <a-divider style="margin: 4px 0" />
          <button
            type="button"
            class="detail-panel__popup-item detail-panel__popup-item--danger"
            @click="askDelete(); moreVisible = false"
          >
            <icon-delete :size="14" />
            <span>{{ isNote ? "删除笔记" : "删除任务" }}</span>
          </button>
        </div>
      </Popover>
    </div>

    <!-- 大纲浮层面板（绝对定位在 .detail-panel 内，absolute 锚点） -->
    <OutlinePanel
      v-if="outlineVisible"
      :editor="richTextEditorRef?.editor"
      @close="outlineVisible = false"
    />

    <!-- 删除二次确认弹窗（统一极简卡片风） -->
    <ConfirmDialog
      :visible="deleteConfirmVisible"
      @update:visible="(v) => { deleteConfirmVisible = v; }"
      @confirm="doDelete"
    >
      <template #title>删除{{ isNote ? "笔记" : "任务" }}「<strong>{{ task?.title }}</strong>」？</template>
    </ConfirmDialog>

    <!-- AI 文本润色预览弹窗 -->
    <AiPolishDialog
      :visible="polishVisible"
      :polished-text="polishResult"
      :original-text="polishOriginal"
      :loading="polishLoading"
      :error="polishError"
      @confirm="onPolishConfirm"
      @cancel="onPolishCancel"
    />

    <!-- 附件浮窗（chips 行 📎 点击触发；下拉带箭头，嵌 AttachmentSection） -->
    </template>
  </div>
  </Transition>
</template>

<script lang="ts">
// 辅助函数：格式化元信息日期
function formatMeta(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return "";
  }
}
</script>

<style scoped>
.detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  background: var(--jt-surface);
  border-left: 1px solid var(--jt-border);
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 全屏切换过渡：left/width 平滑变化 */
  transition: left 0.2s ease, width 0.2s ease;
}
/* 全屏态：left:0 让 fixed 面板横向铺满视口（width 不设，靠 left+right 拉伸） */
.detail-panel--fullscreen {
  left: 0;
  border-left: none;
  box-shadow: none;
}

/* 未选中任务时的 empty 占位（滴答清单风格：插画散落右下角 + 大量留白，无文字） */
.detail-panel__empty {
  position: relative; /* 星星装饰的定位基准 */
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 0 56px 48px 0;
  user-select: none;
}
.detail-panel__empty-art {
  /* 线稿插画，无背景卡片 */
  line-height: 0;
}
.detail-panel__star {
  /* 背景装饰星：绝对定位于面板空白处，与右下角插画互不干扰 */
  position: absolute;
  pointer-events: none;
}

/* 滑入抽屉：仅 enter 动画（从右侧滑入 220ms ease-out）。
 * 不定义 leave 动画 —— 面板关闭（含切视图、ESC、关闭按钮）应立即消失，
 * 避免路由切换瞬间因 transitionName 竞态导致的「一瞬间滑出」残留。 */
.detail-drawer-enter-active {
  transition: transform 220ms ease-out;
}
.detail-drawer-enter-from {
  transform: translateX(100%);
}

.detail-panel__resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 1;
  transition: background-color 0.15s ease;
}

.detail-panel__resizer:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 30%, transparent);
}

/* ─── 顶部 chips ───────────────────────────────── */
.detail-panel__chips {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 12px 16px 8px;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.detail-panel__chips::-webkit-scrollbar {
  display: none;
}
.detail-panel__chips > * {
  flex-shrink: 0;
}
/* 更多按钮推到最右 */
.detail-panel__chips-tail {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
}
.detail-panel__more-btn {
  flex-shrink: 0;
}

/* AI 拆解按钮：主色调，区别于其他灰色的 tail 按钮 */
.detail-panel__ai-btn {
  color: var(--jt-primary);
}
.detail-panel__ai-btn:hover {
  color: var(--jt-primary);
  background: var(--jt-accent-soft);
}

.detail-panel__checkbox-wrap {
  padding-right: 4px;
  display: flex;
  align-items: center;
}

/* ─── 标签列表（已关联） ────────────────────────── */
.detail-panel__tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 16px 4px;
}

/* ─── 面包屑（子任务返回区） ─────────────── */
.detail-panel__breadcrumb {
  padding: 6px 16px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-family: var(--font-body);
}

/* 整条链在一个胶囊里（祖父 / 父 / 父亲名）
   胶囊作为载体，文字默认用浅一档的主色，hover 时加深；不再 hover 变背景。 */
.detail-panel__breadcrumb-back {
  display: inline-flex;
  align-items: center;
  gap: 0;
  max-width: 100%;
  height: 28px;
  padding: 0 4px 0 12px;
  border: none;
  border-radius: 14px;
  background-color: color-mix(in srgb, var(--jt-primary) 8%, transparent);
  /* 默认文字色：主色 + 60% 透明（颜色相对浅） */
  color: color-mix(in srgb, var(--jt-primary) 60%, transparent);
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
  overflow: hidden;
  white-space: nowrap;
}

/* 整胶囊 hover：只把内部文字加深，背景几乎不变 */
.detail-panel__breadcrumb-back:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 10%, transparent);
  color: var(--jt-primary);
}

/* 胶囊内每段：可独立点击（跳转到对应父任务）
   默认沿用胶囊的颜色（继承），hover 时只加深文字。 */
.detail-panel__breadcrumb-back-item {
  display: inline-flex;
  align-items: center;
  height: 100%;
  padding: 0 4px;
  border: none;
  background: transparent;
  /* 颜色继承父胶囊（默认浅一档） */
  font-size: 14px;
  font-family: var(--font-body);
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.12s;
  white-space: nowrap;
  max-width: 160px;
}

.detail-panel__breadcrumb-back-item:last-child {
  /* 最后一段（直接父任务）加粗 */
  font-weight: 600;
}

/* 单段 hover：仅文字颜色加深到主色，不改变背景 */
.detail-panel__breadcrumb-back-item:hover {
  color: var(--jt-primary);
}

.detail-panel__breadcrumb-back-item:focus-visible {
  outline: 2px solid var(--jt-primary);
  outline-offset: 1px;
}

.detail-panel__breadcrumb-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

/* 链段间分隔符：跟胶囊默认文字色一致（浅一档） */
.detail-panel__breadcrumb-sep {
  color: color-mix(in srgb, var(--jt-primary) 40%, transparent);
  font-size: 12px;
  user-select: none;
  padding: 0 2px;
  flex-shrink: 0;
  transition: color 0.12s;
}

/* 鼠标 hover 在任意单段时，分隔符也跟着加深 */
.detail-panel__breadcrumb-back:hover .detail-panel__breadcrumb-sep {
  color: color-mix(in srgb, var(--jt-primary) 60%, transparent);
}

/* ─── 主区 ─────────────────────────────────────── */
.detail-panel__main {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px 20px;
  scrollbar-width: none;
}
.detail-panel__main::-webkit-scrollbar {
  display: none;
}

/* ─── 检查项区（独立于描述） ─────────────────── */
.detail-panel__checklist {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 容器 relative，让 ListDragHandle 的手柄 + 落点横线（absolute 定位）
     以本容器为定位基准，不会溢出到别的区域 */
  position: relative;
  /* 左 padding 给 ⋮⋮ 拖拽手柄让位：4 (handle padding) + 18 (handle width) + 8 (gap) = 30 */
  padding-left: 30px;
}

.detail-panel__checklist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  transition: opacity 0.12s;
  /* item 自身 relative，让手柄绝对定位时不会跑到相邻 item 上去 */
  position: relative;
}

.detail-panel__checklist-item--done {
  opacity: 0.5;
}

.detail-panel__checklist-check {
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--jt-text-tertiary);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  transition: all 0.12s;
  padding: 0;
}

.detail-panel__checklist-check:hover {
  border-color: var(--jt-primary);
}

.detail-panel__checklist-item--done .detail-panel__checklist-check {
  background: var(--jt-primary);
  border-color: var(--jt-primary);
}

.detail-panel__checklist-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--jt-text-primary);
  padding: 4px 0;
  min-width: 0;
}

.detail-panel__checklist-input--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

.detail-panel__checklist-remove {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
  transition: all 0.12s;
  flex-shrink: 0;
  padding: 0;
}

.detail-panel__checklist-remove:hover {
  background: var(--jt-surface-sunken);
  color: var(--jt-error);
}

.detail-panel__title {
  /* 与主页 AddTaskBar 一致的"无边框输入框"风格 */
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.5;
  color: var(--jt-text-primary);
  margin: 0 0 16px;
  cursor: text;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background-color: transparent;
  outline: none;
  resize: none;
  overflow: hidden;
  /* textarea 自动撑高（现代浏览器支持，fallback：rows=1 也能容下单行） */
  field-sizing: content;
  /* placeholder 样式 */
  &::placeholder {
    color: var(--jt-text-tertiary);
    font-weight: 400;
  }
}

.detail-panel__title:hover {
  background-color: var(--jt-surface-hover);
}

.detail-panel__title:focus {
  background-color: var(--jt-surface-sunken);
}

.detail-panel__title--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

/* ─── 底部 footer ──────────────────────────────── */
.detail-panel__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--jt-border);
  background: var(--jt-surface);
}

.detail-panel__meta {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  font-family: var(--font-mono);
  margin-right: 4px;
}

/* ─── 弹层（共享） ────────────────────────────── */
.detail-panel__popup {
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 6px;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
}

.detail-panel__popup--list {
  min-width: 200px;
}

.detail-panel__popup--tag {
  min-width: 200px;
}

.detail-panel__popup-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  background: transparent;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--jt-text-primary);
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
}

.detail-panel__popup-item:hover {
  background: var(--jt-surface-sunken);
}

.detail-panel__popup-item--active {
  background: var(--jt-accent-soft);
  color: var(--jt-primary);
}

.detail-panel__popup-item--danger {
  color: var(--jt-error);
}

.detail-panel__popup-item--danger:hover {
  background: color-mix(in srgb, var(--jt-error) 10%, transparent);
}

.detail-panel__popup--more {
  min-width: 180px;
}

.detail-panel__more-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
}

.detail-panel__more-btn:hover {
  color: var(--jt-text-primary);
}

/* ─── 富文本工具条入口（A 按钮 + 浮窗） ─────────── */
.detail-panel__format-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
  margin-right: 2px;
  font-family: var(--font-mono, monospace);
}

.detail-panel__format-btn:hover,
.detail-panel__format-btn--active {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.detail-panel__format-btn-text {
  font-size: 14px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.detail-panel__format-popup {
  padding: 6px 8px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
  max-width: calc(100vw - 16px);
  display: flex;
  align-items: center;
}

body[arco-theme="dark"] .detail-panel__format-popup {
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}

.detail-panel__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
