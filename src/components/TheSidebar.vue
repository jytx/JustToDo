<script setup lang="ts">
// 侧边栏 —— 智能视图 / 清单 / 标签导航
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ListTreeNode } from "@/stores/list";
import type { List } from "@/types";
import type { Tag } from "@/api/db";
import {
  IconStar,
  IconClockCircle,
  IconCheckCircle,
  IconTag,
  IconPlus,
  IconDelete,
  IconMore,
  IconMenuFold,
  IconMenuUnfold,
  IconRight,
  IconDown,
  IconFolder,
  IconArchive,
  IconSwap,
  IconHome,
} from "@arco-design/web-vue/es/icon";
// IconEdit 移到 SidebarListNode 中使用
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { useTaskStore } from "@/stores/task";
import { useSettingsStore } from "@/stores/settings";
import { useQuickAdd } from "@/composables/useQuickAdd";
import SidebarListNode from "./SidebarListNode.vue";
import SidebarRailCascade from "./SidebarRailCascade.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import ListCascadeMenu from "./menu/ListCascadeMenu.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import ContextMenu from "./ContextMenu.vue";
import TeleportPopper from "./TeleportPopper.vue";
import * as db from "@/api/db";
import { LIST_COLORS } from "@/utils/colors";
import { Message } from "@arco-design/web-vue";

const props = defineProps<{
  collapsed?: boolean;
  /** 受控宽度（展开态生效；收起态固定走 CSS 的 48px） */
  width?: number;
}>();

const emit = defineEmits<{
  "update:collapsed": [value: boolean];
  "update:width": [value: number];
  /** 触发 AI 总结：携带 scope 数据，由 AppLayout 打开弹窗 */
  "ai-summary": [scope: import("@/api/ai").SummaryScope];
}>();

/** 侧边栏宽度边界：最小 = 收起态宽度，最大避免挤压主区域 */
const SIDEBAR_MIN_WIDTH: number = 48;
const SIDEBAR_MAX_WIDTH: number = 480;
/** 默认展开宽度（点击展开图标恢复到此值） */
const SIDEBAR_DEFAULT_WIDTH: number = 240;

/** 过滤出「移动至」可选目标树：仅保留目录节点（清单是叶子，不可挂子项），
 *  并排除 excludeId 自身及其整个后代子树（防止把节点移进自己名下造成环）。
 *  纯函数：不修改入参，返回新树。 */
function filterFolderTree(nodes: ListTreeNode[], excludeId: string): ListTreeNode[] {
  const result: ListTreeNode[] = [];
  for (const n of nodes) {
    // 跳过被移动节点自身（其整棵子树随之排除）与非目录节点
    if (n.id === excludeId || !n.isFolder) continue;
    result.push({ ...n, children: filterFolderTree(n.children, excludeId) });
  }
  return result;
}

/** 把宽度限制在 [最小, 最大] 区间（纯函数） */
function clampWidth(w: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

function toggleCollapsed() {
  const nextCollapsed = !props.collapsed;
  emit("update:collapsed", nextCollapsed);
  // 由收起 → 展开时，恢复默认宽度
  if (!nextCollapsed) {
    emit("update:width", SIDEBAR_DEFAULT_WIDTH);
  }
}

/** 拖拽中标志：临时关闭 width 过渡，避免宽度滞后鼠标 */
const isResizing = ref(false);

/** 判定"真正开始拖拽"的位移阈值（px）。小于此值视为单纯点击，不改变任何状态，
 *  避免收起态下点一下手柄就意外展开。 */
const DRAG_THRESHOLD: number = 3;

/** 拖拽调宽 —— 范式参考 TaskDetailPanel.startResize，方向相反（侧边栏在左）。
 *  - mousedown 不改变状态；只有移动超过阈值才算"开始拖拽"
 *  - 起点若是收起态，首次真正拖动时才退出收起（从 48px 起算跟随鼠标）
 *  - 拖到最小宽度 48px 时，吸附为收起态 */
function startResize(e: MouseEvent) {
  e.preventDefault();
  const startX: number = e.clientX;
  const startWidth: number = props.collapsed
    ? SIDEBAR_MIN_WIDTH
    : props.width ?? SIDEBAR_DEFAULT_WIDTH;
  /** 是否已跨过阈值、进入真正的拖拽（首次跨过时退出收起态） */
  let dragStarted: boolean = false;

  function onMouseMove(ev: MouseEvent) {
    const delta: number = ev.clientX - startX;
    // 未跨过阈值：单纯点击抖动，不改变状态
    if (!dragStarted && Math.abs(delta) < DRAG_THRESHOLD) return;
    // 首次跨过阈值：若是收起态，先退出收起（从 48px 起算跟随鼠标）
    if (!dragStarted) {
      dragStarted = true;
      isResizing.value = true;
      if (props.collapsed) {
        emit("update:collapsed", false);
      }
    }
    const newWidth = clampWidth(startWidth + delta);
    if (newWidth <= SIDEBAR_MIN_WIDTH) {
      // 吸附收起
      emit("update:width", SIDEBAR_MIN_WIDTH);
      emit("update:collapsed", true);
    } else {
      emit("update:collapsed", false);
      emit("update:width", newWidth);
    }
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    isResizing.value = false;
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

const route = useRoute();
const router = useRouter();
const listStore = useListStore();
const tagStore = useTagStore();
const taskStore = useTaskStore();
const settingsStore = useSettingsStore();
const quickAdd = useQuickAdd();

/** 各区块展开/收起状态 */
const sectionCollapsed = ref<Record<string, boolean>>({
  smart: false,
  lists: false,
  /** 笔记本区（与清单对称，独立成区） */
  notebooks: false,
  tags: false,
  /** 归档折叠区默认收起（用户进入归档较少） */
  archive: true,
  /** 归档下二级分组：清单归档 / 笔记归档，可独立展开/收起。
   *  仅在归档区展开后可见；默认展开（用户进入归档就是要看内容） */
  archiveTask: false,
  archiveNote: false,
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

/** 删除确认对话框中目标清单/笔记本的 kind（决定文案：清单/任务/收件箱 vs 笔记本/笔记/默认笔记本） */
const confirmDeleteListKind = computed<"task" | "note">(() => {
  if (!confirmDelete.value || confirmDelete.value.type !== "list") return "task";
  const node = listStore.getById(confirmDelete.value.id);
  return node?.kind === "note" ? "note" : "task";
});

/** 编辑清单/目录弹窗 */
const showEditDialog = ref(false);

function startEditList(list: { id: string; name: string; color: string }) {
  if (list.id === "inbox") return;
  if (list.id === "default-notebook") return;
  editingList.value = { id: list.id, name: list.name, color: list.color };
  editListName.value = list.name;
  editListColor.value = list.color;
  showEditDialog.value = true;
}

/** 编辑弹窗目标节点的 kind（决定 placeholder：清单名称 vs 笔记本名称） */
const editingListKind = computed<"task" | "note">(() => {
  if (!editingList.value) return "task";
  const node = listStore.getById(editingList.value.id);
  return node?.kind === "note" ? "note" : "task";
});

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

/** 新建子目录弹窗状态 —— 点击"添加子目录"后打开，回车才真正创建（ESC 可取消）
 *  通用入口：根级（parentId=null）和子级（parentId=<父目录 id>）共用同一弹窗。 */
const showCreateSubFolderDialog = ref(false);
const newSubFolderName = ref("");
const newSubFolderParentId = ref<string | null>(null);
const newSubFolderNameInputRef = ref<HTMLInputElement | null>(null);
/** 子目录颜色（与新建清单一致，默认橙色） */
const newSubFolderColor = ref("#F59E0B");
/** 子目录类型：继承自父目录的 kind（清单目录 vs 笔记本目录），根级时由 subheader 传入 */
const newSubFolderKind = ref<"task" | "note">("task");

/** 通用"打开新建目录弹窗"入口：
 *  - parentId=null：根级目录（清单 subheader / 笔记本 subheader 触发），kind 由调用方指定
 *  - parentId=<id>：在指定目录下新建子目录，kind 继承自父目录
 *  仅打开弹窗，不立即创建；提交走 confirmNewSubFolder。 */
function openCreateFolderDialog(opts: {
  parentId: string | null;
  kind: "task" | "note";
}): void {
  newSubFolderParentId.value = opts.parentId;
  newSubFolderName.value = "";
  newSubFolderColor.value = "#F59E0B";
  newSubFolderKind.value = opts.kind;
  showCreateSubFolderDialog.value = true;
  nextTick(() => {
    newSubFolderNameInputRef.value?.focus();
  });
}

/** 根级新建目录：subheader 的 + 按钮 / 右键菜单触发；
 *  kind 由 subheader 决定（清单区→'task'，笔记本区→'note'） */
function addRootFolder(kind: "task" | "note"): void {
  openCreateFolderDialog({ parentId: null, kind });
}

/** 回车创建目录（名字必填：空名保持弹窗打开，不做任何事）。
 *  根级 / 子级共用：根据 parentId 是否为 null 决定；listStore.createList 已完整支持两种场景。 */
async function confirmNewSubFolder() {
  const name = newSubFolderName.value.trim();
  if (!name) return; // 名字必填：空名不创建、不关闭弹窗
  await listStore.createList({
    name,
    color: newSubFolderColor.value,
    parentId: newSubFolderParentId.value,
    isFolder: true,
    kind: newSubFolderKind.value,
  });
  showCreateSubFolderDialog.value = false;
}

/** 从目录行的 + 按钮发起"在该目录下新建清单/笔记本"：
 *  把当前目录路径预填到新建弹窗的目录字段，复用现有 showCreateDialog。
 *  kind 继承自父目录（保证叶节点与目录同属一棵树）。
 *  注意：startNewList 会清空 newListFolder，所以这里在它之后再覆盖路径。 */
function onAddListInFolder(folder: { id: string }) {
  const folderNode = listStore.getById(folder.id);
  const kind: "task" | "note" = folderNode?.kind === "note" ? "note" : "task";
  startNewList(kind);
  newListFolder.value = buildFolderPath(folder.id);
}

/** 笔记本菜单"新建笔记"：在指定笔记本下创建空笔记并打开详情面板。
 *  笔记不走 QuickAddDialog（它强依赖日期），改为空标题 + 选中详情范式。 */
async function onAddNote(notebookId: string): Promise<void> {
  const created = await taskStore.createTask({
    title: "",
    listId: notebookId,
    parentId: null,
    kind: "note",
  });
  // 跳转到对应笔记本视图，让用户在上下文中编辑
  router.push(`/notebook/${notebookId}`);
  taskStore.selectTask(created.id);
}

async function askDeleteList(list: { id: string; name: string }) {
  if (list.id === "inbox") return; // 收件箱不可删
  if (list.id === "default-notebook") return; // 默认笔记本不可删
  // 统计条目数（清单统计任务，笔记本统计笔记；底层都是 getTasksByList）
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

/** 选中清单/笔记本时按 Backspace/Delete → 弹删除确认框（键盘入口，等价于右键「删除」）。
 *  守卫：删除框已开 / 非清单·笔记本路由 / 任务列表非空（让位任务删除——用户在
 *  任务列表里按 Backspace 期望删任务，弹清单删除框有误删风险）/ 详情面板打开
 *  （操作态）/ 输入框聚焦 / 非 Backspace·Delete 键，均不处理。
 *  与 AppLayout 的 ↑/↓ 切清单保持同一触发条件（任务列表为空时才生效）。 */
function onSidebarListKeydown(e: KeyboardEvent): void {
  if (confirmDelete.value) return;
  if (route.name !== "list" && route.name !== "notebook") return;
  if (taskStore.openTasks.length > 0) return;
  if (taskStore.detailOpen) return;
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      (active as HTMLElement).isContentEditable)
  ) {
    return;
  }
  const id = route.params.id as string;
  const node = listStore.getById(id);
  if (!node || node.isFolder) return; // 目录无独立路由，理论不会出现
  // preventDefault 放在所有守卫之后：阻止 webview 中 Backspace 触发历史回退
  e.preventDefault();
  askDeleteList(node);
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
    // list_delete 会把被删清单的任务迁移到收件箱，
    // 必须刷新各清单角标，否则收件箱数字不变
    await taskStore.refreshCounts();
    if (route.params.id === id) {
      // 删除后任务也会级联删除，刷新 currentTasks
      taskStore.selectedTaskId = null;
    }
  } else {
    // 如果当前在标签视图，跳走
    if (route.name === "tag" && route.params.id === id) {
      router.push("/all");
    }
    await tagStore.deleteTag(id);
    // 删标签后刷新角标（标签计数可能变化）
    await taskStore.refreshCounts();
  }
  confirmDelete.value = null;
  console.log(`已删除 ${type}: ${name}`);
}

function cancelDelete() {
  confirmDelete.value = null;
}

/** 新建清单/笔记本弹窗（kind 决定创建的是清单还是笔记本） */
const showCreateDialog = ref(false);
const newListName = ref("");
const newListNameInputRef = ref<HTMLInputElement | null>(null);
/** 目录路径字符串，支持 "A/B" 多级（可输入已有目录路径名以提示筛选） */
const newListFolder = ref("");
const selectedColor = ref('#10B981');
/** 新建容器的类型：'task' 清单/目录 | 'note' 笔记本/笔记本目录 */
const newListKind = ref<"task" | "note">("task");

/** subheader 的 + 按钮 popover 开关：'lists' = 清单 subheader, 'notebooks' = 笔记本 subheader
 *  同一时刻只可能开一个；用户点击菜单项或外部自动关闭。 */
const subheaderMenuOpen = ref<"lists" | "notebooks" | null>(null);
/** 关闭 subheader popover（菜单项点击后调用） */
function closeSubheaderMenu(): void {
  subheaderMenuOpen.value = null;
}

/** 8 种预定义颜色 —— 引用共享常量（utils/colors.ts） */
// LIST_COLORS 由 @/utils/colors 导入，此处不再重复定义

/** 打开新建弹窗。kind 决定创建清单还是笔记本（两棵独立树互不混淆） */
function startNewList(kind: "task" | "note" = "task") {
  newListName.value = "";
  newListFolder.value = "";
  selectedColor.value = '#10B981';
  newListKind.value = kind;
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
/** 新建标签颜色（默认第一个颜色；弹窗里可选） */
const newTagColor = ref<string>(LIST_COLORS[0]);

function startNewTag() {
  newTagName.value = "";
  newTagColor.value = LIST_COLORS[0];
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
  await tagStore.createTag(name, newTagColor.value);
  showCreateTagDialog.value = false;
}

/** 编辑标签弹窗状态 */
const showEditTagDialog = ref(false);
const editingTag = ref<{ id: string; name: string; color: string } | null>(null);
const editTagName = ref("");
const editTagNameInputRef = ref<HTMLInputElement | null>(null);
/** 编辑标签颜色（回填当前标签颜色，可改） */
const editTagColor = ref<string>(LIST_COLORS[0]);

/** 从标签菜单发起编辑：回填当前名称 + 颜色并打开弹窗 */
function startEditTag(tag: { id: string; name: string; color: string }) {
  tagMenuOpen[tag.id] = false;
  editingTag.value = { id: tag.id, name: tag.name, color: tag.color };
  editTagName.value = tag.name;
  editTagColor.value = tag.color;
  showEditTagDialog.value = true;
  nextTick(() => {
    editTagNameInputRef.value?.focus();
    // 选中全部文本，方便直接覆盖输入
    editTagNameInputRef.value?.select();
  });
}

/** 保存标签重命名 + 颜色（空名视为取消；名称和颜色都未变也视为取消） */
async function saveTagEdit() {
  if (!editingTag.value) return;
  const name = editTagName.value.trim();
  const colorChanged = editTagColor.value !== editingTag.value.color;
  if (!name || (name === editingTag.value.name && !colorChanged)) {
    showEditTagDialog.value = false;
    return;
  }
  // 名称变了或颜色变了才提交；颜色变了就一并传 color
  await tagStore.renameTag(
    editingTag.value.id,
    name,
    colorChanged ? editTagColor.value : undefined,
  );
  showEditTagDialog.value = false;
  editingTag.value = null;
}

// ─── 行内色板：点侧边栏标签色点直接换色（不用进编辑弹窗） ──────────────
/** 行内色板状态：当前操作的标签 id + trigger 元素 */
const inlineColorTagId = ref<string | null>(null);
const inlineColorTriggerEl = ref<HTMLElement | null>(null);
const inlineColorOpen = ref(false);

/** 点击色点：阻止冒泡（避免触发 router-link 导航）+ 打开行内色板 */
function onClickTagColorDot(e: MouseEvent, tag: { id: string }): void {
  e.preventDefault();
  e.stopPropagation();
  closeAllColorPickers();
  inlineListColorOpen.value = false;
  inlineColorTagId.value = tag.id;
  inlineColorTriggerEl.value = e.currentTarget as HTMLElement;
  inlineColorOpen.value = true;
}

/** 行内选色：即时调 renameTag 只改颜色，立即生效 */
async function onPickInlineTagColor(color: string): Promise<void> {
  const tagId = inlineColorTagId.value;
  inlineColorOpen.value = false;
  if (!tagId) return;
  const tag = tagStore.tags.find((t) => t.id === tagId);
  if (!tag || tag.color === color) return;
  await tagStore.renameTag(tagId, tag.name, color);
}

/** 行内色板当前高亮的颜色（当前操作标签的 color） */
const inlineColorActiveColor = computed(() => {
  const tagId = inlineColorTagId.value;
  const tag = tagStore.tags.find((t) => t.id === tagId);
  return tag?.color ?? "";
});

// ─── 行内色板：点侧边栏清单/笔记本色点直接换色（与标签色板同构） ──────────
/** 行内色板状态：当前操作的清单/笔记本节点 id + trigger 元素 */
const inlineListColorId = ref<string | null>(null);
const inlineListColorTriggerEl = ref<HTMLElement | null>(null);
const inlineListColorOpen = ref(false);

/** 点击清单/笔记本色点：阻止冒泡（避免触发行点击进入清单）+ 打开行内色板 */
function onClickListColorDot(e: MouseEvent, node: { id: string }): void {
  e.preventDefault();
  e.stopPropagation();
  closeAllColorPickers();
  inlineColorOpen.value = false;
  inlineListColorId.value = node.id;
  inlineListColorTriggerEl.value = e.currentTarget as HTMLElement;
  inlineListColorOpen.value = true;
}

/** 行内选色：即时调 listStore.setColor 只改颜色，立即生效 */
async function onPickInlineListColor(color: string): Promise<void> {
  const listId = inlineListColorId.value;
  inlineListColorOpen.value = false;
  if (!listId) return;
  const node = listStore.getById(listId);
  if (!node || node.color === color) return;
  await listStore.setColor(listId, color);
}

/** 行内色板当前高亮的颜色（当前操作清单/笔记本的 color） */
const inlineListColorActiveColor = computed(() => {
  const listId = inlineListColorId.value;
  const node = listId ? listStore.getById(listId) : undefined;
  return node?.color ?? "";
});

/** 编辑弹窗选色：即时保存颜色（用输入框当前名称），不等到回车。
 *  选色后更新 editTagColor + editingTag 的 color 基准，这样回车时不会重复提交颜色。 */
async function onPickEditTagColor(color: string): Promise<void> {
  colorPickerOpen.tagEdit = false;
  if (!editingTag.value || editingTag.value.color === color) return;
  const name = editTagName.value.trim() || editingTag.value.name;
  editTagColor.value = color;
  editingTag.value = { ...editingTag.value, color };
  await tagStore.renameTag(editingTag.value.id, name, color);
}

/** 颜色选择器状态（各自独立 anchor；list/edit 清单、subfolder 子目录、tagCreate/tagEdit 标签） */
const colorPickerOpen = reactive<{
  list: boolean;
  edit: boolean;
  subfolder: boolean;
  tagCreate: boolean;
  tagEdit: boolean;
}>({
  list: false,
  edit: false,
  subfolder: false,
  tagCreate: false,
  tagEdit: false,
});

/** 颜色 trigger 元素缓存（与 colorPickerOpen 的 key 一一对应） */
const colorTriggerEls = reactive<{
  list: HTMLElement | null;
  edit: HTMLElement | null;
  subfolder: HTMLElement | null;
  tagCreate: HTMLElement | null;
  tagEdit: HTMLElement | null;
}>({
  list: null,
  edit: null,
  subfolder: null,
  tagCreate: null,
  tagEdit: null,
});

/** 关闭所有颜色 picker（切换前调用，避免多个同时打开） */
function closeAllColorPickers(): void {
  colorPickerOpen.list = false;
  colorPickerOpen.edit = false;
  colorPickerOpen.subfolder = false;
  colorPickerOpen.tagCreate = false;
  colorPickerOpen.tagEdit = false;
}

/** 点击颜色 trigger —— 切换 popper + 缓存 trigger 元素
 *  scope: "list"（新建清单）/ "edit"（编辑清单）/ "subfolder"（新建子目录）/
 *         "tagCreate"（新建标签）/ "tagEdit"（编辑标签） */
function onClickColorTrigger(
  e: MouseEvent,
  scope: "list" | "edit" | "subfolder" | "tagCreate" | "tagEdit",
): void {
  const el = e.currentTarget as HTMLElement;
  closeAllColorPickers();
  colorTriggerEls[scope] = el;
  colorPickerOpen[scope] = true;
}

/** 目录 trigger 元素 + 弹层状态 */
const folderTriggerEl = ref<HTMLElement | null>(null);
const newListFolderPopupVisible = ref(false);

function onClickFolderTrigger(e: MouseEvent) {
  folderTriggerEl.value = e.currentTarget as HTMLElement;
  newListFolderPopupVisible.value = !newListFolderPopupVisible.value;
}

/** 根据目录 id，向上追溯父级，拼出完整路径字符串（如 "工作/项目A"）。
 *  纯函数：只读 listStore，不修改任何状态。 */
function buildFolderPath(folderId: string): string {
  const ids: string[] = [];
  let curId: string | null = folderId;
  while (curId) {
    ids.unshift(curId);
    const node: List | undefined = listStore.getById(curId);
    curId = node?.parentId ?? null;
  }
  return ids
    .map((nid) => listStore.getById(nid)?.name)
    .filter(Boolean)
    .join("/");
}

/** 输入提示：把已有的目录拼成完整路径，作为自动补全的数据源
 *  仅展示未归档目录（主页新建清单时不应引用归档目录名）；
 *  且按当前弹窗的 newListKind 隔离两棵树（清单/笔记本互不混入）。
 *  底层 listStore 已提供 taskLists / noteLists 两棵独立树，直接用避免自己再判 kind。 */
const folderSuggestions = computed(() => {
  const kind = newListKind.value;
  const source = kind === "note" ? listStore.noteLists : listStore.taskLists;
  return source
    .filter((l) => l.isFolder)
    .map((f) => {
      const path = buildFolderPath(f.id);
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
      // before/after：和 target 同级（仅未归档；归档项不计索引）
      const targetParentId = target.parentId;
      // 找到 target 在同级中的索引
      const siblings = listStore.activeLists.filter((l) => l.parentId === targetParentId);
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

/** 处理任务/笔记拖到清单（含 inbox）：移动到该清单（含整棵子任务树） */
async function onTaskDrop(taskId: string, targetNode: ListTreeNode): Promise<void> {
  const ok = await taskStore.moveTaskToList(taskId, targetNode.id);
  if (!ok) {
    Message.error("移动任务失败");
  }
}

/** 处理任务/笔记拖到目录：自动新建清单（固定名 + 序号）后移入 */
async function onTaskDropToFolder(
  taskId: string,
  folderNode: ListTreeNode,
  kind: "task" | "note",
): Promise<void> {
  try {
    const list = await listStore.createList({
      name: nextAutoListName(kind),
      color: selectedColor.value,
      parentId: folderNode.id,
      isFolder: false,
      kind,
    });
    const ok = await taskStore.moveTaskToList(taskId, list.id);
    if (!ok) {
      Message.error("移动任务失败");
    }
  } catch (e) {
    console.error("[Sidebar] 拖拽新建清单失败:", e);
    Message.error(`新建清单失败：${String(e)}`);
  }
}

/** 计算自动清单名：「新清单 N」/「新笔记本 N」（N = 现有同名最大序号 + 1，无则从 1 起）。
 *  命名规则后续可改（见 discuss/task-cross-list-drag-design.md）。 */
function nextAutoListName(kind: "task" | "note"): string {
  const prefix = kind === "note" ? "新笔记本" : "新清单";
  const regex = new RegExp(`^${prefix} (\\d+)$`);
  let max = 0;
  for (const l of listStore.lists) {
    if ((l.kind ?? "task") !== kind) continue;
    const m = l.name.match(regex);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix} ${max + 1}`;
}

async function confirmNewList() {
  const name = newListName.value.trim();
  if (!name) {
    showCreateDialog.value = false;
    return;
  }

  // 处理目录路径（支持 "A/B" 创建多级目录；kind 保证目录与叶节点同属一棵树）
  let parentId: string | null = null;
  const folderPath = newListFolder.value.trim();
  if (folderPath) {
    parentId = await listStore.ensureFolderPath(folderPath, selectedColor.value, newListKind.value);
  }

  await listStore.createList({ name, color: selectedColor.value, parentId, kind: newListKind.value });
  showCreateDialog.value = false;
}

/** 目录展开状态（目前由 SidebarListNode 内部管理，保留备用） */

const activeListId = computed(() => route.params.id as string);
const activeRouteName = computed(() => route.name as string);

/** 收起态用：根级清单/目录（扁平，不含嵌套子项；仅未归档；kind='task'） */
const rootLists = computed(() =>
  listStore.activeLists.filter((l) => l.parentId === null && l.kind !== "note"),
);

/** 收起态用：根级笔记本/笔记本目录（扁平，仅未归档；kind='note'） */
const rootNoteLists = computed(() =>
  listStore.activeLists.filter((l) => l.parentId === null && l.kind === "note"),
);

/** 收起态用：清单/笔记本是否处于 active 态。
 *  目录 active 当其任意未归档子项被选中；叶节点 active 当自身被选中。
 *  routeName 区分清单（'list'）与笔记本（'notebook'）。 */
function isListActive(node: { id: string; isFolder: boolean }, routeName: string): boolean {
  if (activeRouteName.value !== routeName) return false;
  if (!node.isFolder) return activeListId.value === node.id;
  return listStore.activeLists.some(
    (l) => l.parentId === node.id && l.id === activeListId.value,
  );
}

/* === 收起态 hover tooltip（单例：一个气泡服务所有 rail-item） === */
const railTip = reactive<{ visible: boolean; text: string; top: number; left: number }>({
  visible: false,
  text: "",
  top: 0,
  left: 0,
});

/** 鼠标进入 rail-item：贴 trigger 右边缘 + 垂直居中定位，填入文本 */
function showRailTip(e: MouseEvent, text: string): void {
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  railTip.text = text;
  railTip.top = rect.top + rect.height / 2;
  railTip.left = rect.right; /* trigger 右边缘，气泡再向右偏移间距（见 CSS） */
  railTip.visible = true;
}

/** 鼠标离开 rail-item：隐藏气泡（延迟，避免在相邻图标间移动时闪烁） */
let hideRailTipTimer: number | null = null;
function hideRailTip(): void {
  if (hideRailTipTimer !== null) window.clearTimeout(hideRailTipTimer);
  hideRailTipTimer = window.setTimeout(() => {
    railTip.visible = false;
  }, 80);
}

/** 鼠标再次进入时取消隐藏计时（在相邻图标快速移动时保持气泡常显） */
function cancelHideRailTip(): void {
  if (hideRailTipTimer !== null) {
    window.clearTimeout(hideRailTipTimer);
    hideRailTipTimer = null;
  }
}

/* === tooltip 文本生成（纯函数：名称 + 可选计数） === */
function smartViewTip(v: { id: string; label: string }): string {
  const n = taskStore.smartCounts[v.id];
  return n ? `${v.label} (${n})` : v.label;
}

function listTip(node: { id: string; name: string; isFolder: boolean }): string {
  if (node.isFolder) return node.name;
  const n = taskStore.listCounts[node.id];
  return n ? `${node.name} (${n})` : node.name;
}

function tagTip(tag: { id: string; name: string }): string {
  const n = taskStore.tagCounts[tag.id];
  return n ? `${tag.name} (${n})` : tag.name;
}

/* === 收起态：目录级联浮动面板 === */
/** 展开链项：目录 id + 该级面板的垂直锚点 + kind（决定从哪棵树取节点） */
interface CascadeItem {
  id: string;
  anchorTop: number;
  /** 'task' 清单目录 | 'note' 笔记本目录（决定级联面板从哪棵树取子节点） */
  kind: "task" | "note";
}

/** 当前展开的目录链（从根目录开始）；空数组 = 无面板 */
const cascadeChain = ref<CascadeItem[]>([]);

/** 第一级面板要展开的根目录节点（展开链第 0 项；按 kind 从对应树取） */
const cascadeRootFolder = computed<ListTreeNode | null>(() => {
  const rootItem = cascadeChain.value[0];
  if (!rootItem) return null;
  const tree = rootItem.kind === "note" ? listStore.noteListTree : listStore.listTree;
  return tree.find((n) => n.id === rootItem.id) ?? null;
});

/** 点击 rail 上的清单/笔记本按钮：
 *  - 目录：打开级联面板（重置展开链为 [该目录]，kind 决定级联从哪棵树取节点）
 *  - 叶节点：按 kind 路由跳转（/list 或 /notebook） */
function onRailListClick(e: MouseEvent, node: { id: string; isFolder: boolean; kind?: string }) {
  const kind: "task" | "note" = node.kind === "note" ? "note" : "task";
  const prefix = kind === "note" ? "/notebook" : "/list";
  if (!node.isFolder) {
    router.push(`${prefix}/${node.id}`);
    return;
  }
  // 找到目录节点（rail 渲染的是根级，按 kind 从对应树取）
  const tree = kind === "note" ? listStore.noteListTree : listStore.listTree;
  const folder = tree.find((n) => n.id === node.id);
  if (!folder) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  cascadeChain.value = [{ id: folder.id, anchorTop: rect.top + rect.height / 2, kind }];
}

/** 级联面板内展开子目录：
 *  parentDepth = 被点击 folder 所在面板的深度；
 *  新链 = 截断到 parentDepth（含）+ push 新目录及其锚点（kind 继承父级） */
function onCascadeExpand(folder: ListTreeNode, anchorTop: number, parentDepth: number) {
  const parentKind = cascadeChain.value[parentDepth]?.kind ?? "task";
  const next = cascadeChain.value.slice(0, parentDepth + 1);
  next.push({ id: folder.id, anchorTop, kind: parentKind });
  cascadeChain.value = next;
}

/** 级联面板内选择清单：跳转后关闭整个级联 */
function onCascadeSelect(_listId: string) {
  cascadeChain.value = [];
}

/** 收起态 rail 点击归档图标：若侧栏收起则展开，并在下一帧打开归档折叠区 */
async function onRailArchiveClick(): Promise<void> {
  if (props.collapsed) {
    // 先展开侧栏（width 恢复默认），下一帧再切归档区
    toggleCollapsed();
    await nextTick();
  }
  sectionCollapsed.value.archive = false;
}

/** 关闭级联面板（点外部 / Esc 时调用） */
function closeCascade() {
  if (cascadeChain.value.length > 0) {
    cascadeChain.value = [];
  }
}

/** 全局 mousedown：点在级联面板外部则关闭 */
function onDocMouseDownForCascade(e: MouseEvent) {
  if (cascadeChain.value.length === 0) return;
  const target = e.target as HTMLElement | null;
  // 面板容器带 .rail-cascade 类；触发按钮带 .sidebar__rail-cascade-trigger
  if (target?.closest(".rail-cascade")) return;
  if (target?.closest(".sidebar__rail-cascade-trigger")) return;
  closeCascade();
}

/** 全局 keydown：Esc 关闭级联 */
function onEscForCascade(e: KeyboardEvent) {
  if (e.key === "Escape") closeCascade();
}

onMounted(() => {
  document.addEventListener("mousedown", onDocMouseDownForCascade);
  document.addEventListener("keydown", onEscForCascade);
  // 选中清单/笔记本时 Backspace/Delete 弹删除确认框（窗口级，与 AppLayout 任务删除互补）
  window.addEventListener("keydown", onSidebarListKeydown);
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onDocMouseDownForCascade);
  document.removeEventListener("keydown", onEscForCascade);
  window.removeEventListener("keydown", onSidebarListKeydown);
});

const smartViews = [
  { id: "today", route: "today", icon: IconStar, label: "今天" },
  { id: "upcoming", route: "upcoming", icon: IconClockCircle, label: "未来 7 天" },
  { id: "all", route: "all", icon: IconCheckCircle, label: "全部" },
];

/* === 侧边栏右键菜单（清单/目录/标签 统一由一个 ContextMenu 实例服务） === */
/** 右键目标类型：区分目录 / 清单 / 标签，决定渲染哪些菜单项 */
type CtxTarget =
  | { kind: "folder"; node: ListTreeNode }
  | { kind: "list"; node: ListTreeNode }
  | { kind: "tag"; tag: Tag };

/** 右键菜单状态：可见性 + 鼠标坐标 + 当前目标 */
const ctxMenu = reactive<{
  visible: boolean;
  x: number;
  y: number;
  target: CtxTarget | null;
}>({
  visible: false,
  x: 0,
  y: 0,
  target: null,
});

/** 打开右键菜单：记录坐标与目标类型。由各行的 @contextmenu.prevent 调用。
 *  受保护节点（收件箱 inbox / 默认笔记本 default-notebook）不可新建 / 归档 / 编辑 / 删除 ——
 *  菜单项全部屏蔽会变成"空弹窗"，这里直接不弹出，避免把菜单容器渲染给用户看一个白窗。 */
function openCtxMenu(e: MouseEvent, target: CtxTarget): void {
  if (
    target.kind === "list" &&
    (target.node.id === "inbox" || target.node.id === "default-notebook")
  ) {
    return;
  }
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.target = target;
  ctxMenu.visible = true;
}

/** 关闭右键菜单（点击菜单项后调用） */
function closeCtxMenu(): void {
  ctxMenu.visible = false;
  ctxMenu.target = null;
  // 连带关闭「移动至」级联子菜单（用户点了其他菜单项时避免残留）
  moveCascade.visible = false;
}

/* === 「移动至」级联子菜单（参照 TaskListItem 的级联子菜单方案：
 *   Teleport 到 body + fixed 定位 + .task-item-submenu 类名 ——
 *   ContextMenu 的点外部关闭 / 滚动关闭逻辑已对该类名豁免） === */
/** 子菜单状态：可见性 + 定位（left/top 为 px 字符串） */
const moveCascade = reactive<{
  visible: boolean;
  top: string | undefined;
  left: string | undefined;
}>({ visible: false, top: undefined, left: undefined });

let moveCascadeTimer: number | null = null;
/** 鼠标离开菜单项到子菜单关闭的延迟（给用户留出移动到子菜单的时间） */
const MOVE_CASCADE_CLOSE_DELAY: number = 200;

/** 打开「移动至」子菜单：定位到触发菜单项右侧，超出视口则翻转到左侧 */
async function showMoveCascade(triggerEl: HTMLElement): Promise<void> {
  if (moveCascadeTimer !== null) {
    clearTimeout(moveCascadeTimer);
    moveCascadeTimer = null;
  }
  moveCascade.visible = true;
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
  moveCascade.left = left + "px";
  moveCascade.top = tr.top + "px";
}

function scheduleCloseMoveCascade(): void {
  if (moveCascadeTimer !== null) clearTimeout(moveCascadeTimer);
  moveCascadeTimer = window.setTimeout(() => {
    moveCascade.visible = false;
    moveCascadeTimer = null;
  }, MOVE_CASCADE_CLOSE_DELAY);
}

function cancelCloseMoveCascade(): void {
  if (moveCascadeTimer !== null) {
    clearTimeout(moveCascadeTimer);
    moveCascadeTimer = null;
  }
}

/** 「移动至」可选目标树：按当前右键目标的 kind 选树（清单树 / 笔记本树，两棵树独立），
 *  过滤为仅目录 + 排除被移动节点自身及后代。 */
const moveTargetTree = computed<ListTreeNode[]>(() => {
  const target = ctxMenu.target;
  if (!target || target.kind === "tag") return [];
  const tree = target.node.kind === "note" ? listStore.noteListTree : listStore.listTree;
  return filterFolderTree(tree, target.node.id);
});

/** 移动到目标父级（null = 根目录）：
 *  目标与当前位置相同（根级→根级 / 已在同目录）时仅关菜单，避免无意义更新；
 *  否则调 store.moveNode 持久化 + 本地更新，并展开目标目录让用户看到结果。 */
async function onMoveToParent(targetParentId: string | null): Promise<void> {
  const target = ctxMenu.target;
  if (!target || target.kind === "tag") return;
  const node = target.node;
  closeCtxMenu();
  moveCascade.visible = false;
  if (targetParentId === node.parentId) return;
  // 追加到目标父级子列表末尾
  const siblings = listStore.getChildren(targetParentId);
  await listStore.moveNode(node.id, targetParentId, siblings.length);
  if (targetParentId !== null) {
    listStore.setNodeExpanded(targetParentId, true);
  }
}

/** 目录右键菜单项 —— 复用现有 hover 菜单的处理函数 */
function onCtxAddFolder(node: ListTreeNode): void {
  closeCtxMenu();
  // 子级场景：parentId=node.id，kind 继承父目录
  openCreateFolderDialog({
    parentId: node.id,
    kind: node.kind === "note" ? "note" : "task",
  });
}
function onCtxEdit(node: ListTreeNode): void {
  closeCtxMenu();
  startEditList(node);
}
function onCtxDeleteList(node: ListTreeNode): void {
  closeCtxMenu();
  askDeleteList(node);
}
/** 清单/笔记本右键：新建条目 —— 笔记本走 onAddNote（建笔记），清单走 quickAdd（建任务） */
function onCtxAddTask(node: ListTreeNode): void {
  closeCtxMenu();
  if (node.kind === "note") {
    onAddNote(node.id);
  } else {
    quickAdd.open(node.id);
  }
}
/** 标签右键：编辑 / 删除 —— 复用现有 hover 菜单的处理函数 */
function onCtxEditTag(tag: Tag): void {
  closeCtxMenu();
  startEditTag(tag);
}
function onCtxDeleteTag(tag: Tag): void {
  closeCtxMenu();
  askDeleteTag(tag);
}

/** 归档前若当前正浏览被归档节点，跳到一个安全页（避免停留在已归档节点）。
 *  清单跳「全部」智能视图；笔记本跳「默认笔记本」。 */
function redirectAwayIfActive(node: ListTreeNode): void {
  const routeName = node.kind === "note" ? "notebook" : "list";
  if (route.name === routeName && route.params.id === node.id) {
    router.push(node.kind === "note" ? "/notebook/default-notebook" : "/all");
  }
}

/** 归档整棵子树（首页右键菜单调用）：先关菜单再调 store；若是当前激活路由则跳走 */
async function onCtxArchive(node: ListTreeNode): Promise<void> {
  closeCtxMenu();
  redirectAwayIfActive(node);
  await listStore.archiveTree(node.id);
  // 主页角标已由 Rust 端的 task_count_by_list 自动过滤，但需要触发前端重新拉
  await taskStore.refreshCounts();
}

/** 取消归档整棵子树 */
async function onCtxUnarchive(node: ListTreeNode): Promise<void> {
  closeCtxMenu();
  await listStore.unarchiveTree(node.id);
  await taskStore.refreshCounts();
}

/** AI 总结：构造 scope（清单/目录）并 emit 给 AppLayout 打开弹窗 */
function onCtxAiSummary(node: ListTreeNode): void {
  closeCtxMenu();
  emit("ai-summary", {
    type: node.isFolder ? "folder" : "list",
    id: node.id,
    name: node.name,
    kind: (node.kind ?? "task") as "task" | "note",
  });
}

/** SidebarListNode hover 三点菜单触发的归档：
 *  与 onCtxArchive 同流程（路由跳转 + store + refreshCounts），不关菜单（hover 菜单已自己关） */
async function onHoverArchive(node: ListTreeNode): Promise<void> {
  redirectAwayIfActive(node);
  await listStore.archiveTree(node.id);
  await taskStore.refreshCounts();
}

onMounted(async () => {
  await listStore.loadLists();
  await tagStore.loadTags();
  await taskStore.refreshCounts();
});
</script>

<template>
  <aside
    class="sidebar"
    :class="{ 'sidebar--collapsed': collapsed, 'sidebar--resizing': isResizing }"
    :style="!collapsed && width ? { width: width + 'px' } : {}"
  >
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
      <!-- ===== 收起态：垂直图标列（智能视图 + 清单圆点 + 标签） ===== -->
      <template v-if="collapsed">
        <!-- 智能视图图标（带未完成数角标） -->
        <router-link
          v-for="v in smartViews"
          :key="v.id"
          :to="`/${v.route}`"
          class="sidebar__rail-item"
          :class="{ 'sidebar__rail-item--active': activeRouteName === v.route }"
          @mouseenter="showRailTip($event, smartViewTip(v))"
          @mousemove="cancelHideRailTip"
          @mouseleave="hideRailTip"
        >
          <component :is="v.icon" :size="18" />
          <span
            v-if="taskStore.smartCounts[v.id]"
            class="sidebar__rail-badge"
          >{{ taskStore.smartCounts[v.id] }}</span>
        </router-link>

        <!-- 分隔线（仅当有清单时才显示） -->
        <div v-if="rootLists.length > 0" class="sidebar__rail-divider" />

        <!-- 清单/目录按钮（目录点击展开级联面板，清单点击跳转） -->
        <button
          v-for="node in rootLists"
          :key="node.id"
          type="button"
          class="sidebar__rail-item"
          :class="{
            'sidebar__rail-item--active': isListActive(node, 'list'),
            'sidebar__rail-cascade-trigger': node.isFolder,
            'sidebar__rail-item--cascade-open': node.isFolder && cascadeChain[0]?.id === node.id,
          }"
          @click="onRailListClick($event, node)"
          @mouseenter="showRailTip($event, listTip(node))"
          @mousemove="cancelHideRailTip"
          @mouseleave="hideRailTip"
        >
          <icon-folder
            v-if="node.isFolder"
            :size="18"
            :style="{ color: node.color }"
          />
          <span
            v-else
            class="sidebar__rail-dot"
            :style="{ backgroundColor: node.color }"
          />
          <span
            v-if="!node.isFolder && taskStore.listCounts[node.id]"
            class="sidebar__rail-badge"
          >{{ taskStore.listCounts[node.id] }}</span>
        </button>

        <!-- 笔记本分隔线 + 笔记本/笔记本目录按钮（kind='note'，与清单两棵独立树） -->
        <div v-if="rootNoteLists.length > 0" class="sidebar__rail-divider" />
        <button
          v-for="node in rootNoteLists"
          :key="node.id"
          type="button"
          class="sidebar__rail-item"
          :class="{
            'sidebar__rail-item--active': isListActive(node, 'notebook'),
            'sidebar__rail-cascade-trigger': node.isFolder,
            'sidebar__rail-item--cascade-open': node.isFolder && cascadeChain[0]?.id === node.id,
          }"
          @click="onRailListClick($event, node)"
          @mouseenter="showRailTip($event, listTip(node))"
          @mousemove="cancelHideRailTip"
          @mouseleave="hideRailTip"
        >
          <icon-folder
            v-if="node.isFolder"
            :size="18"
            :style="{ color: node.color }"
          />
          <span
            v-else
            class="sidebar__rail-dot"
            :style="{ backgroundColor: node.color }"
          />
          <span
            v-if="!node.isFolder && taskStore.noteCounts[node.id]"
            class="sidebar__rail-badge"
          >{{ taskStore.noteCounts[node.id] }}</span>
        </button>

        <!-- 归档入口 —— 仅当有归档项时才显示分隔线 + 图标 -->
        <div v-if="listStore.archivedLists.length > 0" class="sidebar__rail-divider" />
        <button
          v-if="listStore.archivedLists.length > 0"
          type="button"
          class="sidebar__rail-item"
          :class="{ 'sidebar__rail-item--active': activeRouteName === 'list' && listStore.archivedLists.some((l) => l.id === activeListId) }"
          :title="`归档（${listStore.archivedLists.length}）`"
          @click="onRailArchiveClick"
          @mouseenter="showRailTip($event, `归档（${listStore.archivedLists.length}）`)"
          @mousemove="cancelHideRailTip"
          @mouseleave="hideRailTip"
        >
          <icon-archive :size="18" />
        </button>

        <!-- 分隔线（仅当有标签时才显示） -->
        <div v-if="tagStore.tags.length > 0" class="sidebar__rail-divider" />

        <!-- 标签图标 -->
        <router-link
          v-for="tag in tagStore.tags"
          :key="tag.id"
          :to="`/tag/${tag.id}`"
          class="sidebar__rail-item"
          :class="{ 'sidebar__rail-item--active': activeRouteName === 'tag' && activeListId === tag.id }"
          @mouseenter="showRailTip($event, tagTip(tag))"
          @mousemove="cancelHideRailTip"
          @mouseleave="hideRailTip"
        >
          <span class="sidebar__rail-dot" :style="{ backgroundColor: tag.color }" />
        </router-link>
      </template>

      <template v-else>
      <!-- ===== 展开态：原有完整导航 ===== -->
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
      <div
        class="sidebar__subheader sidebar__subheader--toggle"
        @contextmenu.prevent="subheaderMenuOpen = 'lists'"
      >
        <div class="sidebar__subheader-left" @click="toggleSection('lists')">
          <icon-down v-if="!sectionCollapsed.lists" :size="12" class="sidebar__toggle-icon" />
          <icon-right v-else :size="12" class="sidebar__toggle-icon" />
          <span>清单</span>
        </div>
        <MenuPopover
          :visible="subheaderMenuOpen === 'lists'"
          @update:visible="(v) => subheaderMenuOpen = v ? 'lists' : null"
          placement="bottom-right"
        >
          <template #trigger>
            <a-button
              size="mini"
              type="text"
              title="新建清单或目录"
              @click.stop="subheaderMenuOpen = 'lists'"
            >
              <template #icon><icon-plus :size="16" /></template>
            </a-button>
          </template>
          <MenuPopoverItem @click="startNewList('task'); closeSubheaderMenu()">
            <icon-plus :size="15" />
            <span>新建清单</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="addRootFolder('task'); closeSubheaderMenu()">
            <icon-folder :size="15" />
            <span>新建目录</span>
          </MenuPopoverItem>
        </MenuPopover>
      </div>

      <!-- 树形清单渲染 -->
      <div v-show="!sectionCollapsed.lists" class="sidebar__list-tree">
        <SidebarListNode
          v-for="node in listStore.listTree"
          :key="node.id"
          :node="node"
          :depth="0"
          kind="task"
          @edit="(n: any) => startEditList(n)"
          @delete="(n: any) => askDeleteList(n)"
          @addFolder="(n: ListTreeNode) => openCreateFolderDialog({ parentId: n.id, kind: n.kind === 'note' ? 'note' : 'task' })"
          @addList="(n: ListTreeNode) => onAddListInFolder(n)"
          @addTask="(n: ListTreeNode) => quickAdd.open(n.id)"
          @archive="(n: ListTreeNode) => onHoverArchive(n)"
          @aiSummary="(n: ListTreeNode) => onCtxAiSummary(n)"
          @move="onListMove"
          @taskDrop="onTaskDrop"
          @taskDropToFolder="onTaskDropToFolder"
          @contextmenu="(e: MouseEvent, n: ListTreeNode) => openCtxMenu(e, { kind: n.isFolder ? 'folder' : 'list', node: n })"
          @colorClick="onClickListColorDot"
        />
      </div>

      <!-- 笔记本（与清单对称，kind='note' 独立成区，两棵树互不混淆） -->
      <div
        class="sidebar__subheader sidebar__subheader--toggle"
        @contextmenu.prevent="subheaderMenuOpen = 'notebooks'"
      >
        <div class="sidebar__subheader-left" @click="toggleSection('notebooks')">
          <icon-down v-if="!sectionCollapsed.notebooks" :size="12" class="sidebar__toggle-icon" />
          <icon-right v-else :size="12" class="sidebar__toggle-icon" />
          <span>笔记本</span>
        </div>
        <MenuPopover
          :visible="subheaderMenuOpen === 'notebooks'"
          @update:visible="(v) => subheaderMenuOpen = v ? 'notebooks' : null"
          placement="bottom-right"
        >
          <template #trigger>
            <a-button
              size="mini"
              type="text"
              title="新建笔记本或目录"
              @click.stop="subheaderMenuOpen = 'notebooks'"
            >
              <template #icon><icon-plus :size="16" /></template>
            </a-button>
          </template>
          <MenuPopoverItem @click="startNewList('note'); closeSubheaderMenu()">
            <icon-plus :size="15" />
            <span>新建笔记本</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="addRootFolder('note'); closeSubheaderMenu()">
            <icon-folder :size="15" />
            <span>新建目录</span>
          </MenuPopoverItem>
        </MenuPopover>
      </div>

      <!-- 树形笔记本渲染（复用 SidebarListNode，kind='note' 控制路由/计数/文案） -->
      <div v-show="!sectionCollapsed.notebooks" class="sidebar__list-tree">
        <SidebarListNode
          v-for="node in listStore.noteListTree"
          :key="node.id"
          :node="node"
          :depth="0"
          kind="note"
          @edit="(n: any) => startEditList(n)"
          @delete="(n: any) => askDeleteList(n)"
          @addFolder="(n: ListTreeNode) => openCreateFolderDialog({ parentId: n.id, kind: n.kind === 'note' ? 'note' : 'task' })"
          @addList="(n: ListTreeNode) => onAddListInFolder(n)"
          @addTask="(n: ListTreeNode) => onAddNote(n.id)"
          @archive="(n: ListTreeNode) => onHoverArchive(n)"
          @aiSummary="(n: ListTreeNode) => onCtxAiSummary(n)"
          @move="onListMove"
          @taskDrop="onTaskDrop"
          @taskDropToFolder="onTaskDropToFolder"
          @contextmenu="(e: MouseEvent, n: ListTreeNode) => openCtxMenu(e, { kind: n.isFolder ? 'folder' : 'list', node: n })"
          @colorClick="onClickListColorDot"
        />
      </div>

      <!-- 归档 —— 与清单/标签同级，无 + 按钮；目录与清单同理可点击展开进入 -->
      <div class="sidebar__subheader sidebar__subheader--toggle">
        <div class="sidebar__subheader-left" @click="toggleSection('archive')">
          <icon-down v-if="!sectionCollapsed.archive" :size="12" class="sidebar__toggle-icon" />
          <icon-right v-else :size="12" class="sidebar__toggle-icon" />
          <span>归档</span>
        </div>
      </div>

      <!-- 归档树渲染（按 kind 分两组，各组独立展开/收起；某组无归档项则不显示该组） -->
      <div v-show="!sectionCollapsed.archive" class="sidebar__list-tree">
        <!-- 归档清单二级分组（仅当有清单归档时才出现） -->
        <template v-if="listStore.archiveListTree.length > 0">
          <div
            class="sidebar__archive-group"
            @click="toggleSection('archiveTask')"
          >
            <icon-down v-if="!sectionCollapsed.archiveTask" :size="12" class="sidebar__toggle-icon" />
            <icon-right v-else :size="12" class="sidebar__toggle-icon" />
            <span>清单</span>
            <span class="sidebar__archive-group-count">{{ listStore.archiveListTree.length }}</span>
          </div>
          <SidebarListNode
            v-show="!sectionCollapsed.archiveTask"
            v-for="node in listStore.archiveListTree"
            :key="node.id"
            :node="node"
            :depth="0"
            :readonly="true"
            kind="task"
            @contextmenu="(e: MouseEvent, n: ListTreeNode) => openCtxMenu(e, { kind: n.isFolder ? 'folder' : 'list', node: n })"
          />
        </template>
        <!-- 归档笔记本二级分组（仅当有笔记本归档时才出现） -->
        <template v-if="listStore.archiveNoteListTree.length > 0">
          <div
            class="sidebar__archive-group"
            @click="toggleSection('archiveNote')"
          >
            <icon-down v-if="!sectionCollapsed.archiveNote" :size="12" class="sidebar__toggle-icon" />
            <icon-right v-else :size="12" class="sidebar__toggle-icon" />
            <span>笔记本</span>
            <span class="sidebar__archive-group-count">{{ listStore.archiveNoteListTree.length }}</span>
          </div>
          <SidebarListNode
            v-show="!sectionCollapsed.archiveNote"
            v-for="node in listStore.archiveNoteListTree"
            :key="node.id"
            :node="node"
            :depth="0"
            :readonly="true"
            kind="note"
            @contextmenu="(e: MouseEvent, n: ListTreeNode) => openCtxMenu(e, { kind: n.isFolder ? 'folder' : 'list', node: n })"
          />
        </template>
        <div v-if="listStore.archivedLists.length === 0" class="sidebar__item sidebar__item--disabled">
          <icon-archive :size="16" class="sidebar__item-icon" />
          <span class="sidebar__item-title">归档区为空</span>
        </div>
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
        @contextmenu.prevent="openCtxMenu($event, { kind: 'tag', tag })"
      >
        <span
          class="sidebar__tag-color sidebar__tag-color--clickable"
          :style="{ backgroundColor: tag.color }"
          :title="`更改 ${tag.name} 颜色`"
          @click="onClickTagColorDot($event, tag)"
        />
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
          <MenuPopoverItem @click="startEditTag(tag)">
            <icon-edit :size="15" />
            <span>编辑标签</span>
          </MenuPopoverItem>
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

      <!-- 习惯区块已移除 —— 习惯入口已上移到 AppRail，TheSidebar 只承担任务二级导航 -->
      </template>
    </nav>

    <!-- 拖拽调宽手柄（贴右边缘；双击切换收起/展开，收起态也保留可拖拽重新展开） -->
    <div class="sidebar__resizer" @mousedown="startResize" @dblclick="toggleCollapsed" />
  </aside>

  <!-- 收起态 hover tooltip（Teleport 到 body，避开 sidebar overflow:hidden 裁剪） -->
  <Teleport to="body">
    <div
      v-if="railTip.visible"
      class="rail-tooltip"
      :style="{ top: `${railTip.top}px`, left: `${railTip.left}px` }"
    >
      {{ railTip.text }}
    </div>
  </Teleport>

  <!-- 收起态：目录级联浮动面板（点击目录图标后展开，递归渲染子项） -->
  <SidebarRailCascade
    v-if="cascadeRootFolder"
    :folder="cascadeRootFolder"
    :anchor-top="cascadeChain[0].anchorTop"
    :left="112"
    :expanded-chain="cascadeChain"
    :depth="0"
    :kind="cascadeChain[0].kind"
    @expand="onCascadeExpand"
    @select="onCascadeSelect"
  />

  <!-- 删除确认对话框（统一极简卡片风） -->
  <ConfirmDialog
    :visible="!!confirmDelete"
    @update:visible="(v) => { if (!v) cancelDelete(); }"
    @confirm="confirmDeleteAction"
  >
    <template #title>
      删除{{ confirmDelete?.type === "list" ? (confirmDeleteListKind === "note" ? "笔记本" : "清单") : "标签" }}
      「<strong>{{ confirmDelete?.name }}</strong>」？
    </template>
    <template v-if="confirmDelete?.type === 'list' && confirmDelete.taskCount > 0">
      {{ confirmDeleteListKind === "note" ? "笔记本" : "清单" }}下的 {{ confirmDelete.taskCount }} 个{{ confirmDeleteListKind === "note" ? "笔记" : "任务" }}将移动到「{{ confirmDeleteListKind === "note" ? "默认笔记本" : "收件箱" }}」。
    </template>
    <template v-else-if="confirmDelete?.type === 'list'">
      {{ confirmDeleteListKind === "note" ? "笔记本" : "清单" }}为空，将直接删除。
    </template>
    <template v-else-if="confirmDelete?.type === 'tag'">
      标签将被删除，任务不受影响。
    </template>
  </ConfirmDialog>

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
          :placeholder="newListKind === 'note' ? '笔记本名称' : '清单名称'"
          @keydown.enter="confirmNewList"
          @keydown.escape.stop="showCreateDialog = false"
        />
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
          @click="onClickColorTrigger($event, 'list')"
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

  <!-- 编辑清单/目录弹窗（QuickAdd 风格：裸 input + 属性 trigger + 回车提交） -->
  <a-modal
    v-model:visible="showEditDialog"
    :width="440"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="sidebar-create-modal"
  >
    <div class="sidebar-create">
      <!-- 主输入行 -->
      <div class="sidebar-create__input-row">
        <input
          v-model="editListName"
          class="sidebar-create__input"
          :placeholder="editingListKind === 'note' ? '笔记本名称' : '清单名称'"
          @keydown.enter="saveListEdit"
          @keydown.escape.stop="showEditDialog = false"
        />
      </div>
      <div class="sidebar-create__divider" />
      <!-- 属性行：仅颜色 trigger（清单不能改父级目录） -->
      <div class="sidebar-create__attrs">
        <button
          data-color-trigger="edit"
          type="button"
          class="sidebar-create__trigger"
          @click="onClickColorTrigger($event, 'edit')"
        >
          <span
            class="sidebar-create__color-dot"
            :style="{ backgroundColor: editListColor }"
          />
          <span>颜色</span>
        </button>

        <span class="sidebar-create__spacer" />

        <span class="sidebar-create__hint">回车保存</span>
      </div>
    </div>
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
      </div>
      <div class="sidebar-create__divider" />
      <div class="sidebar-create__attrs">
        <button
          data-color-trigger="tagCreate"
          type="button"
          class="sidebar-create__trigger"
          @click="onClickColorTrigger($event, 'tagCreate')"
        >
          <span
            class="sidebar-create__color-dot"
            :style="{ backgroundColor: newTagColor }"
          />
          <span>颜色</span>
        </button>
        <span class="sidebar-create__spacer" />
        <span class="sidebar-create__hint">回车保存</span>
      </div>
    </div>
  </a-modal>

  <!-- 编辑标签弹窗（QuickAdd 风格，与新建标签一致） -->
  <a-modal
    v-model:visible="showEditTagDialog"
    :width="440"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="sidebar-create-modal"
  >
    <div class="sidebar-create">
      <div class="sidebar-create__input-row">
        <input
          ref="editTagNameInputRef"
          v-model="editTagName"
          class="sidebar-create__input"
          placeholder="标签名称"
          @keydown.enter="saveTagEdit"
          @keydown.escape.stop="showEditTagDialog = false"
        />
      </div>
      <div class="sidebar-create__divider" />
      <div class="sidebar-create__attrs">
        <button
          data-color-trigger="tagEdit"
          type="button"
          class="sidebar-create__trigger"
          @click="onClickColorTrigger($event, 'tagEdit')"
        >
          <span
            class="sidebar-create__color-dot"
            :style="{ backgroundColor: editTagColor }"
          />
          <span>颜色</span>
        </button>
        <span class="sidebar-create__spacer" />
        <span class="sidebar-create__hint">回车保存</span>
      </div>
    </div>
  </a-modal>

  <!-- 新建子目录弹窗（QuickAdd 风格：仅名字输入 + 回车创建） -->
  <a-modal
    v-model:visible="showCreateSubFolderDialog"
    :width="440"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="sidebar-create-modal"
  >
    <div class="sidebar-create">
      <div class="sidebar-create__input-row">
        <input
          ref="newSubFolderNameInputRef"
          v-model="newSubFolderName"
          class="sidebar-create__input"
          :placeholder="newSubFolderParentId === null ? '目录名称' : '子目录名称'"
          @keydown.enter="confirmNewSubFolder"
          @keydown.escape.stop="showCreateSubFolderDialog = false"
        />
      </div>
      <div class="sidebar-create__divider" />
      <div class="sidebar-create__attrs">
        <!-- 颜色 trigger：与新建清单弹窗同款 -->
        <button
          data-color-trigger="subfolder"
          type="button"
          class="sidebar-create__trigger"
          @click="onClickColorTrigger($event, 'subfolder')"
        >
          <span
            class="sidebar-create__color-dot"
            :style="{ backgroundColor: newSubFolderColor }"
          />
          <span>颜色</span>
        </button>

        <span class="sidebar-create__spacer" />

        <span class="sidebar-create__hint">回车创建</span>
      </div>
    </div>
  </a-modal>

  <!-- 新建子目录颜色 picker 弹层（独立 anchor） -->
  <TeleportPopper
    v-model:visible="colorPickerOpen.subfolder"
    :anchor="colorTriggerEls.subfolder"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': newSubFolderColor === c }"
        :style="{ backgroundColor: c }"
        @click="newSubFolderColor = c; colorPickerOpen.subfolder = false"
      />
    </div>
  </TeleportPopper>

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

  <!-- 编辑清单颜色 picker 弹层（独立 anchor，对应编辑弹窗的颜色 trigger） -->
  <TeleportPopper
    v-model:visible="colorPickerOpen.edit"
    :anchor="colorTriggerEls.edit"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': editListColor === c }"
        :style="{ backgroundColor: c }"
        @click="editListColor = c; colorPickerOpen.edit = false"
      />
    </div>
  </TeleportPopper>

  <!-- 新建标签颜色 picker 弹层 -->
  <TeleportPopper
    v-model:visible="colorPickerOpen.tagCreate"
    :anchor="colorTriggerEls.tagCreate"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': newTagColor === c }"
        :style="{ backgroundColor: c }"
        @click="newTagColor = c; colorPickerOpen.tagCreate = false"
      />
    </div>
  </TeleportPopper>

  <!-- 编辑标签颜色 picker 弹层 -->
  <TeleportPopper
    v-model:visible="colorPickerOpen.tagEdit"
    :anchor="colorTriggerEls.tagEdit"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': editTagColor === c }"
        :style="{ backgroundColor: c }"
        @click="onPickEditTagColor(c)"
      />
    </div>
  </TeleportPopper>

  <!-- 行内色板：点侧边栏标签色点直接弹板换色（选色即时生效，不进编辑弹窗） -->
  <TeleportPopper
    v-model:visible="inlineColorOpen"
    :anchor="inlineColorTriggerEl"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': inlineColorActiveColor === c }"
        :style="{ backgroundColor: c }"
        @click="onPickInlineTagColor(c)"
      />
    </div>
  </TeleportPopper>

  <!-- 行内色板：点侧边栏清单/笔记本色点直接弹板换色（与标签色板同构） -->
  <TeleportPopper
    v-model:visible="inlineListColorOpen"
    :anchor="inlineListColorTriggerEl"
    placement="bottom-left"
  >
    <div class="sidebar-create__color-picker">
      <button
        v-for="c in LIST_COLORS"
        :key="c"
        class="sidebar-create__color-swatch"
        :class="{ 'sidebar-create__color-swatch--active': inlineListColorActiveColor === c }"
        :style="{ backgroundColor: c }"
        @click="onPickInlineListColor(c)"
      />
    </div>
  </TeleportPopper>

  <!-- 侧边栏右键菜单（清单/目录/标签 统一服务，菜单项与 hover 三点菜单一致） -->
  <ContextMenu
    v-model:visible="ctxMenu.visible"
    :x="ctxMenu.x"
    :y="ctxMenu.y"
  >
    <!-- 目录：未归档 显示 添加子目录 / 编辑 / 删除 / 归档 ；已归档 仅显示 取消归档 -->
    <template v-if="ctxMenu.target?.kind === 'folder'">
      <template v-if="!ctxMenu.target.node.archived">
        <MenuPopoverItem @click="onCtxAddFolder(ctxMenu.target.node)">
          <icon-plus :size="15" />
          <span>添加子目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onCtxEdit(ctxMenu.target.node)">
          <icon-edit :size="15" />
          <span>编辑目录</span>
        </MenuPopoverItem>
        <!-- 移动至：hover 弹出级联子菜单（根目录 + 目录树，仅未归档目录可选） -->
        <MenuPopoverItem
          @mouseenter="(e: MouseEvent) => showMoveCascade(e.currentTarget as HTMLElement)"
          @mouseleave="scheduleCloseMoveCascade"
        >
          <icon-swap :size="15" />
          <span>移动至</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onCtxDeleteList(ctxMenu.target.node)">
          <icon-delete :size="15" />
          <span>删除目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem v-if="settingsStore.aiEnabled" @click="onCtxAiSummary(ctxMenu.target.node)">
          <icon-robot :size="15" />
          <span>AI 总结</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onCtxArchive(ctxMenu.target.node)">
          <icon-archive :size="15" />
          <span>归档目录</span>
        </MenuPopoverItem>
      </template>
      <template v-else>
        <MenuPopoverItem @click="onCtxUnarchive(ctxMenu.target.node)">
          <icon-archive :size="15" />
          <span>取消归档</span>
        </MenuPopoverItem>
      </template>
    </template>
    <!-- 清单/笔记本：未归档 显示 新建条目 / 编辑 / 删除 / 归档 ；已归档 仅显示 取消归档。
         文案按 node.kind 区分（清单→任务/清单，笔记本→笔记/笔记本）。
         inbox / default-notebook 受保护，右键不弹菜单（在 openCtxMenu 拦截），故此处无需再判 id。 -->
    <template v-else-if="ctxMenu.target?.kind === 'list'">
      <template v-if="!ctxMenu.target.node.archived">
        <MenuPopoverItem @click="onCtxAddTask(ctxMenu.target.node)">
          <icon-plus :size="15" />
          <span>{{ ctxMenu.target.node.kind === "note" ? "新建笔记" : "新建任务" }}</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onCtxEdit(ctxMenu.target.node)">
          <icon-edit :size="15" />
          <span>{{ ctxMenu.target.node.kind === "note" ? "编辑笔记本" : "编辑清单" }}</span>
        </MenuPopoverItem>
        <!-- 移动至：hover 弹出级联子菜单（根目录 + 目录树，仅未归档目录可选） -->
        <MenuPopoverItem
          @mouseenter="(e: MouseEvent) => showMoveCascade(e.currentTarget as HTMLElement)"
          @mouseleave="scheduleCloseMoveCascade"
        >
          <icon-swap :size="15" />
          <span>移动至</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onCtxDeleteList(ctxMenu.target.node)">
          <icon-delete :size="15" />
          <span>{{ ctxMenu.target.node.kind === "note" ? "删除笔记本" : "删除清单" }}</span>
        </MenuPopoverItem>
        <MenuPopoverItem v-if="settingsStore.aiEnabled" @click="onCtxAiSummary(ctxMenu.target.node)">
          <icon-robot :size="15" />
          <span>AI 总结</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onCtxArchive(ctxMenu.target.node)">
          <icon-archive :size="15" />
          <span>{{ ctxMenu.target.node.kind === "note" ? "归档笔记本" : "归档清单" }}</span>
        </MenuPopoverItem>
      </template>
      <template v-else>
        <MenuPopoverItem @click="onCtxUnarchive(ctxMenu.target.node)">
          <icon-archive :size="15" />
          <span>取消归档</span>
        </MenuPopoverItem>
      </template>
    </template>
    <!-- 标签：编辑标签 / 删除标签 -->
    <template v-else-if="ctxMenu.target?.kind === 'tag'">
      <MenuPopoverItem @click="onCtxEditTag(ctxMenu.target.tag)">
        <icon-edit :size="15" />
        <span>编辑标签</span>
      </MenuPopoverItem>
      <MenuPopoverItem danger @click="onCtxDeleteTag(ctxMenu.target.tag)">
        <icon-delete :size="15" />
        <span>删除标签</span>
      </MenuPopoverItem>
    </template>
  </ContextMenu>

  <!-- 「移动至」级联子菜单：Teleport 到 body + fixed 定位，类名 .task-item-submenu
       （ContextMenu 的点外部 / 滚动关闭逻辑已对该类名豁免，点击子菜单不会误关一级菜单）。
       置顶「根目录」项 + ListCascadeMenu 递归目录树（selectFolders：目录项可点击选中）。
       mouseenter/mouseleave 与触发菜单项成对：移入子菜单取消延迟关闭，离开后延迟收起。 -->
  <Teleport to="body">
    <div
      v-if="moveCascade.visible"
      class="task-item-submenu context-menu"
      :style="{ position: 'fixed', top: moveCascade.top, left: moveCascade.left, zIndex: '10010' }"
      @mouseenter="cancelCloseMoveCascade"
      @mouseleave="scheduleCloseMoveCascade"
    >
      <MenuPopoverItem @click="onMoveToParent(null)">
        <icon-home :size="15" />
        <span>根目录</span>
      </MenuPopoverItem>
      <ListCascadeMenu
        :nodes="moveTargetTree"
        :current-list-id="''"
        :on-select="(folderId: string) => onMoveToParent(folderId)"
        :select-folders="true"
      />
    </div>
  </Teleport>
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
  position: relative; /* 拖拽手柄绝对定位的基准 */
}

.sidebar--collapsed {
  width: 48px;
}

/* 拖拽调宽手柄：贴右边缘，跨在边框上（一半在内一半在外） */
.sidebar__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 10;
  transition: background-color 0.15s ease;
}

.sidebar__resizer:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 30%, transparent);
}

/* 拖拽期间关闭 width 过渡，避免宽度滞后鼠标 */
.sidebar--resizing {
  transition: none !important;
}

/* 收起态：nav 不再隐藏，改为渲染垂直图标列（见模板侧 collapsed 分支） */
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

/* 收起态：折叠按钮居中，与下方图标列对齐 */
.sidebar--collapsed .sidebar__header {
  justify-content: center;
  padding: 32px 4px 4px;
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

/* 收起态：nav 变成垂直图标列，居中排列 */
.sidebar--collapsed .sidebar__nav {
  padding: 0 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
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

/* 选中状态（路由激活） —— 加 !important 压过 .sidebar__item:hover，
 * 否则鼠标悬停在选中项上时，背景会被 --jt-surface-hover 浅灰覆盖，
 * 表现为"点击后没底色、鼠标移开才显示强调色"。
 * 与清单 .list-node--active 的处理完全一致。 */
.sidebar__item--active {
  background-color: var(--jt-accent-soft) !important;
  color: var(--jt-primary);
}

.sidebar__item--active:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 15%, var(--jt-accent-soft)) !important;
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

/* 标签项的色点（展开态，替代统一图标）——与清单/笔记本色点视觉一致 */
.sidebar__tag-color {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 可点击的色点：点按弹出色板换色 */
.sidebar__tag-color--clickable {
  cursor: pointer;
  transition: transform 0.12s;
}
.sidebar__tag-color--clickable:hover {
  transform: scale(1.3);
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

/* ===== 收起态：垂直图标列样式 ===== */
.sidebar__rail-item {
  position: relative;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;            /* 重置 <button> UA 默认的 outset 立体边框 */
  background: transparent; /* 重置 <button> UA 默认的灰色底，与 <a>(router-link) 起点一致 */
  border-radius: 8px;
  color: var(--jt-text-secondary);
  text-decoration: none;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.sidebar__rail-item:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.sidebar__rail-item--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

/* 目录图标在级联面板展开时的高亮（与 active 同色，表示"正在浏览此目录"） */
.sidebar__rail-item--cascade-open {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

/* 收起态圆点（清单颜色标识） */
.sidebar__rail-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 收起态未完成数角标（右上角小数字） */
.sidebar__rail-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background-color: var(--jt-error);
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
  box-sizing: border-box;
  pointer-events: none;
}

/* 收起态分组分隔线 */
.sidebar__rail-divider {
  width: 20px;
  height: 1px;
  margin: 4px 0;
  background-color: var(--jt-border);
  flex-shrink: 0;
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

.sidebar__warn-text {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 8px 0 0;
}

.sidebar__menu-danger {
  color: var(--jt-error);
}
</style>

<!-- 新建/编辑清单弹窗统一用 sidebar-create 类（样式在全局 sidebar-create.css） -->
<style scoped>
.sidebar__list-tree {
  display: flex;
  flex-direction: column;
}

/* 归档区二级分组（清单 / 笔记本）：可展开/收起的子标题行，
 * 风格与 sidebar__subheader 一致但更轻：左侧缩进 4px、字号略小、带数量角标 */
.sidebar__archive-group {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding: 0 8px 0 12px;
  min-height: 28px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
}

.sidebar__archive-group:hover {
  color: var(--jt-text-secondary);
  background-color: var(--jt-surface-hover);
}

.sidebar__archive-group-count {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  color: var(--jt-text-tertiary);
}
</style>

<!-- 收起态 hover tooltip：Teleport 到 body，必须用非 scoped 样式才能命中 -->
<style>
.rail-tooltip {
  position: fixed;
  margin-left: 8px; /* trigger 右边缘 + 8px 间距（left 由 JS 动态设为 rect.right） */
  transform: translateY(-50%); /* 垂直居中到 trigger 中点 */
  z-index: 9999;
  padding: 4px 10px;
  border-radius: 6px;
  background-color: var(--jt-text-primary);
  color: var(--jt-surface);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none; /* 气泡不拦截鼠标，避免干扰 hover 状态 */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  animation: rail-tooltip-in 0.12s ease-out;
}

@keyframes rail-tooltip-in {
  from {
    opacity: 0;
    transform: translateY(-50%) translateX(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(-50%) translateX(0);
  }
}
</style>

<!-- 样式已抽取到 src/styles/sidebar-create.css（全局），
     TheSidebar 和 HabitView 复用同一份 -->
