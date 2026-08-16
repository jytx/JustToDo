<script setup lang="ts">
// 侧边栏清单树形节点 —— 递归渲染目录和清单
// 支持拖拽排序和拖拽到其他目录
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ListTreeNode } from "@/stores/list";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { useSettingsStore } from "@/stores/settings";
import {
  IconFolder,
  IconMore,
  IconEdit,
  IconDelete,
  IconPlus,
  IconRight,
  IconDown,
  IconArchive,
} from "@arco-design/web-vue/es/icon";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import { parseTaskDrag } from "@/utils/dnd";

const props = defineProps<{
  node: ListTreeNode;
  depth: number;
  /**
   * 只读模式（归档区使用）：
   * - 隐藏行内 + 号（在该目录下新建清单）
   * - 目录行的 MenuPopover 不渲染（"+ 子目录 / 编辑 / 删除 / 归档" 等都禁掉）
   * - 清单行的 MenuPopover 仅保留右键菜单项（无 hover 菜单）
   * 任务的右键菜单由调用方通过 ctxmenu 事件自行实现，这里不参与
   * 默认 false
   */
  readonly?: boolean;
  /** 节点类型：'task'（默认，清单/目录）| 'note'（笔记本/笔记本目录）。
   *  决定路由前缀（/list vs /notebook）、计数来源、菜单文案。 */
  kind?: "task" | "note";
  /** 多选态下的行点击处理器（TheSidebar 注入）：返回 true 表示已消费（走多选逻辑），
   *  false 表示未消费（由组件走路由跳转）。未注入时行点击走默认跳转。 */
  onNodeClick?: (id: string, e: MouseEvent) => boolean;
  /** 是否处于多选态（控制行首 checkbox 显示）。TheSidebar 统一注入，递归子节点透传。 */
  batchMode?: boolean;
  /** 多选态下判断节点是否选中的谓词（TheSidebar 注入；递归子节点透传，按各自 node 求值） */
  isBatchSelectedFn?: (id: string) => boolean;
  /** 受保护节点（inbox/默认笔记本）：不参与多选，多选态下不显示 checkbox（保持色点/文件夹图标）。
   *  TheSidebar 注入；递归子节点透传。 */
  isProtected?: boolean;
}>();

/** 是否处于多选态（默认 false） */
const isBatchMode = computed(() => props.batchMode ?? false);
/** 当前节点是否被批量选中 */
const isBatchSelected = computed(() =>
  props.isBatchSelectedFn ? props.isBatchSelectedFn(props.node.id) : false,
);
/** 是否受保护节点（不参与多选，多选态下不显示 checkbox） */
const isProtected = computed(() => props.isProtected ?? false);

const listStore = useListStore();
const taskStore = useTaskStore();
const settingsStore = useSettingsStore();
const router = useRouter();
const route = useRoute();

/** 是否为笔记本节点（kind='note'）：影响路由、计数、菜单文案 */
const isNote = computed(() => props.kind === "note");
/** 是否为影子目录（归档区分组展示补出的激活态祖先目录）：
 *  仅作分组——淡化样式、无右键菜单、不参与多选与拖拽，展开箭头仍可用 */
const isGhost = computed(() => !!props.node.isGhost);
/** 对应的路由名与路径前缀 */
const routeName = computed(() => (isNote.value ? "notebook" : "list"));
// routePrefix 保留供后续扩展使用（暂未在模板内直接使用 —— 兼容路由前缀）
const routePrefix = computed(() => (isNote.value ? "/notebook" : "/list"));

/**
 * 计算树节点左侧缩进。
 * 顶层节点也需要位于“清单”分组标题的右侧，每深入一级再增加 16px。
 */
function getNodePaddingLeft(depth: number): string {
  const baseIndent: number = 16;
  const levelIndent: number = 16;
  return `${baseIndent + depth * levelIndent}px`;
}

/** 当前清单/笔记本项是否处于路由激活态（仅叶节点，非目录） */
const isActive = computed(
  () =>
    !props.node.isFolder &&
    route.name === routeName.value &&
    route.params.id === props.node.id,
);

/** 目录展开状态：提升到 list store（键盘切换清单时需跨组件展开目录链），
 *  缺省视为展开（undefined 按 true 处理，与旧版本地 ref(true) 行为一致） */
const expanded = computed(() => listStore.expandedNodes[props.node.id] ?? true);

const emit = defineEmits<{
  edit: [node: ListTreeNode];
  delete: [node: ListTreeNode];
  /** 在该目录下新建子目录 */
  addFolder: [node: ListTreeNode];
  /** 在该目录下新建清单 */
  addList: [node: ListTreeNode];
  /** 在该清单下新建任务（仅清单菜单） */
  addTask: [node: ListTreeNode];
  /** 导入笔记到该笔记本（仅笔记本菜单）：打开系统文件选择器选 md/txt */
  importNotes: [node: ListTreeNode];
  /** 归档当前节点（目录或清单）；TheSidebar 调 store.archiveTree */
  archive: [node: ListTreeNode];
  /** AI 总结当前节点（目录/清单/笔记本），与右键菜单对齐 */
  aiSummary: [node: ListTreeNode];
  /** 拖拽放置：被拖拽的节点 id 数组（单节点=[id]，多选整组=多个），目标父级 ID，目标位置 */
  move: [draggedIds: string[], targetNode: ListTreeNode, position: "before" | "after" | "inside"];
  /** 任务/笔记拖到清单节点（含 inbox）：移动到该清单 */
  taskDrop: [taskId: string, targetNode: ListTreeNode];
  /** 任务/笔记拖到目录节点：自动新建清单后移入（kind 决定「新清单」/「新笔记本」命名） */
  taskDropToFolder: [taskId: string, folderNode: ListTreeNode, kind: "task" | "note"];
  /** 右键菜单：鼠标事件 + 当前节点（向上冒泡到 TheSidebar 统一处理） */
  contextmenu: [event: MouseEvent, node: ListTreeNode];
  /** 点击色点换色：鼠标事件 + 当前节点（冒泡到 TheSidebar 弹行内色板） */
  colorClick: [event: MouseEvent, node: ListTreeNode];
}>();

/** 菜单点击的 key（addFolder 仅目录菜单有，addTask/importNotes 仅清单菜单有） */
function onMenuClick(
  key: "edit" | "delete" | "addFolder" | "addTask" | "importNotes" | "archive" | "aiSummary",
) {
  folderMenuOpen.value = false;
  listMenuOpen.value = false;
  if (key === "edit") emit("edit", props.node);
  else if (key === "delete") emit("delete", props.node);
  else if (key === "addFolder") emit("addFolder", props.node);
  else if (key === "addTask") emit("addTask", props.node);
  else if (key === "importNotes") emit("importNotes", props.node);
  else if (key === "archive") emit("archive", props.node);
  else if (key === "aiSummary") emit("aiSummary", props.node);
}

/** 目录行更多菜单（独立 ref） */
const folderMenuOpen = ref(false);
/** 清单行更多菜单（独立 ref） */
const listMenuOpen = ref(false);

/** 点击清单/笔记本行 → 路由跳转（按 kind 决定前缀） */
function goToList() {
  if (!props.node.isFolder) {
    router.push(`${routePrefix.value}/${props.node.id}`);
  }
}

/** 行点击统一入口：多选处理器注入且消费（Shift/Cmd/多选态点击）→ 不跳转；
 *  未消费且为清单（非目录）→ 路由跳转。目录行普通点击无行为（仅箭头展开）。
 *  影子目录直接短路：不参与多选（选中它做批量操作无意义），也不跳转。 */
function onRowClick(e: MouseEvent): void {
  if (isGhost.value) return;
  if (props.onNodeClick && props.onNodeClick(props.node.id, e)) return;
  goToList();
}

/** 目录行右键：影子目录不弹菜单（归档区分组节点无任何操作） */
function onFolderContextMenu(e: MouseEvent): void {
  if (isGhost.value) return;
  emit("contextmenu", e, props.node);
}

// ─── 拖拽逻辑 ──────────────────────────────────────────

/** 当前 drag-over 状态：null / 'before' / 'after' / 'inside' / 'target'
 *  （'target' = 任务/笔记拖入清单，整行高亮，语义「移动到该清单」） */
const dragOver = ref<"before" | "after" | "inside" | "target" | null>(null);
const isDragging = ref(false);

/** 是否可拖动（inbox / default-notebook 位置固定，不可拖；影子目录仅作归档区分组，不可拖） */
const canDrag = computed(
  () =>
    props.node.id !== "inbox" &&
    props.node.id !== "default-notebook" &&
    !props.node.isGhost,
);

/** 多选拖拽的「多行收在一起」拖拽视觉元素（当前挂载中的引用，dragend 时移除） */
let multiDragBadgeEl: HTMLElement | null = null;

/** 生成并挂载「多行收在一起」的拖拽视觉：DOM div + CSS 多层 box-shadow 堆叠卡片。
 *  注意：**必须挂载到 body 再 setDragImage**——WebKit 要求 setDragImage 的图像元素
 *  已连接文档（传未挂载 canvas 兼容性差，可能抛异常中止拖拽会话 =「拖不动」）。
 *  元素定位到屏幕外（渲染快照可用，visibility:hidden 不渲染会显示空白）。
 *  纯函数：不修改业务状态，返回已挂载元素（调用方在 dragend 调 removeDragBadge 清理）。 */
function createMultiDragBadge(count: number, kind: "task" | "note"): HTMLElement {
  const el = document.createElement("div");
  el.className = "list-node__drag-badge";
  // 多层 box-shadow 模拟堆叠卡片：后两层主题色半透明偏移轮廓 + 顶层实心主色卡片
  el.style.cssText = `
    position: fixed; left: -9999px; top: 0;
    pointer-events: none;
    display: flex; align-items: center; justify-content: center;
    min-width: 96px; height: 40px; padding: 0 14px;
    background: var(--jt-primary); color: #fff;
    font-size: 13px; font-weight: 600;
    font-family: var(--font-body);
    border-radius: 8px;
    box-shadow:
      4px 4px 0 0 color-mix(in srgb, var(--jt-primary) 35%, transparent),
      8px 8px 0 0 color-mix(in srgb, var(--jt-primary) 18%, transparent);
  `;
  el.textContent = `${count} 个${kind === "note" ? "笔记本" : "清单"}`;
  document.body.appendChild(el);
  multiDragBadgeEl = el;
  return el;
}

/** 移除多选拖拽视觉元素（dragend 时调用，避免残留屏幕外元素） */
function removeDragBadge(): void {
  if (multiDragBadgeEl) {
    multiDragBadgeEl.remove();
    multiDragBadgeEl = null;
  }
}

function onDragStart(e: DragEvent) {
  if (!canDrag.value) {
    e.preventDefault();
    return;
  }
  // 多选态下拖动任一选中节点 → 整组平移（dataTransfer 放 JSON 数组；
  // 单节点保持原样放单个 id 字符串，onDrop 端两种格式都兼容）
  const dragIds =
    isBatchMode.value && isBatchSelected.value
      ? listStore.batchSelectedIdsArr
      : [props.node.id];
  e.dataTransfer!.setData("text/plain", JSON.stringify(dragIds));
  e.dataTransfer!.effectAllowed = "move";
  // 多选整组：自定义「多行收在一起」drag image（堆叠卡片 + 计数）。
  // try-catch 兜底：setDragImage 失败时移除挂载元素，降级为浏览器默认图，拖拽不中断
  if (dragIds.length > 1) {
    try {
      const badge = createMultiDragBadge(
        dragIds.length,
        isNote.value ? "note" : "task",
      );
      e.dataTransfer!.setDragImage(badge, 14, 14);
    } catch (err) {
      console.error("[SidebarListNode] setDragImage 失败，降级默认图:", err);
      removeDragBadge();
    }
  }
  // 单节点不设置自定义 setDragImage，让浏览器默认用整个清单项的半透明截图作为拖拽视觉，
  // 体现"整行被移动"的效果（而不是只有文字的小卡片）。
  // 多选整组：ids 已快照进 dataTransfer（drop 端不依赖 store 选中集合），
  // 开始拖拽即退出多选态——避免拖拽途中/取消拖拽时选中态残留（用户 2026-08-14 反馈）
  if (dragIds.length > 1) {
    listStore.exitBatchMode();
  }
  isDragging.value = true;
}

/** 判断目标节点是否是被拖节点自身或其后代（防环）。
 *  被拖集合为 dragIds（批量整组 或 单节点数组），沿 parentId 上溯比对。 */
function isDropTargetForbidden(targetId: string, dragIds: string[]): boolean {
  let curId: string | null = targetId;
  while (curId) {
    if (dragIds.includes(curId)) return true;
    const node = listStore.getById(curId);
    curId = node?.parentId ?? null;
  }
  return false;
}

/** 从 dataTransfer 解析被拖节点 id 数组（兼容 JSON 数组与旧版单 id 字符串） */
function parseDraggedIds(e: DragEvent): string[] {
  const raw = e.dataTransfer!.getData("text/plain") ?? "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
    return [String(parsed)];
  } catch {
    return [raw];
  }
}

function onDragEnd() {
  isDragging.value = false;
  dragOver.value = null;
  // 清理多选拖拽视觉元素（避免屏幕外残留）
  removeDragBadge();
}

function onDragOver(e: DragEvent) {
  // 始终 preventDefault + 设 dropEffect="move"，保证整个侧边栏区域都显示
  // "可移动"光标，避免鼠标经过 inbox 时光标闪烁成禁止/加号。
  // inbox 是否真正接受 drop 由 onDrop 里的业务判断决定。
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  // 归档区只读：不参与任何拖放高亮（仅作过路，避免误导）
  if (props.readonly) return;
  // 收件箱 / 默认笔记本：自身不可拖（canDrag=false），但可作为清单排序的参照落点——
  // 清单/多选整组可以拖到它们的前/后（用户 2026-08-14 反馈：拖到第一项之前无响应）。
  // 任务/笔记拖入 inbox 仍是"移到该清单"语义（kind 匹配时整行高亮）。
  if (props.node.id === "inbox" || props.node.id === "default-notebook") {
    const payload = parseTaskDrag(e);
    if (payload) {
      if (payload.kind === props.kind) {
        dragOver.value = "target";
      } else {
        // 跨 kind（任务拖到默认笔记本等）→ 禁止
        e.dataTransfer!.dropEffect = "none";
        dragOver.value = null;
      }
      return;
    }
    // 清单拖拽：仅 before/after 排序落点（收件箱是清单行非目录，无 inside）
    const dragIds = parseDraggedIds(e);
    if (isDropTargetForbidden(props.node.id, dragIds)) {
      e.dataTransfer!.dropEffect = "none";
      dragOver.value = null;
      return;
    }
    const iRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOver.value = e.clientY - iRect.top < iRect.height * 0.5 ? "before" : "after";
    return;
  }

  // 任务/笔记拖拽（自定义 MIME 与清单拖拽 text/plain 隔离）
  const payload = parseTaskDrag(e);
  if (payload) {
    // 跨 kind（任务拖到笔记本树 / 笔记拖到清单树）→ 禁止光标
    if (payload.kind !== props.kind) {
      e.dataTransfer!.dropEffect = "none";
      dragOver.value = null;
      return;
    }
    // 目录：拖入 = 自动新建清单 → inset 高亮；清单：拖入 = 移动 → 整行高亮
    dragOver.value = props.node.isFolder ? "inside" : "target";
    return;
  }

  // 清单拖拽（原逻辑）：目录行上 1/3=before / 中 1/3=inside / 下 1/3=after；
  // 清单行上半=before / 下半=after
  // 批量整组平移：被拖节点含自身/后代 → 拒绝落点（防环，无高亮）
  const dragIds = parseDraggedIds(e);
  if (isDropTargetForbidden(props.node.id, dragIds)) {
    e.dataTransfer!.dropEffect = "none";
    dragOver.value = null;
    return;
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;

  if (props.node.isFolder) {
    // 目录：上 1/3 = before，中间 1/3 = inside，下 1/3 = after
    if (y < h * 0.33) dragOver.value = "before";
    else if (y > h * 0.66) dragOver.value = "after";
    else dragOver.value = "inside";
  } else {
    // 清单：上半 = before，下半 = after
    if (y < h * 0.5) dragOver.value = "before";
    else dragOver.value = "after";
  }
}

/** dragenter：拖拽进入元素时立即锁定 dropEffect="move"，
 *  消除"刚拖起来那一瞬间"光标闪成默认 +/copy 的现象（react-dnd issue #414）。
 *  dragenter 到首个 dragover 之间存在光标未定窗口，必须在此显式声明。 */
function onDragEnter(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
}

function onDragLeave(e: DragEvent) {
  // 只有真正离开这个元素（不是进入子元素）才清除
  const related = e.relatedTarget as HTMLElement | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  dragOver.value = null;
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  // 归档区只读：不接受 drop
  if (props.readonly) return;

  // 任务/笔记拖拽分支（优先于清单拖拽，避免把任务 id 误当清单 id 移动）
  const payload = parseTaskDrag(e);
  if (payload) {
    dragOver.value = null;
    // 跨 kind（任务拖到笔记本树 / 笔记拖到清单树）→ 拒绝（dragover 已禁止高亮，此处兜底）
    if (payload.kind !== props.kind) return;
    // 同步标记「任务已通过拖拽移走」：dragend 据此跳过旧清单排序持久化
    // （drop 处理链是异步的，必须在同步阶段标记，防止 IPC 竞态覆盖 sort_order）
    taskStore.markTaskDragMoved(payload.id);
    if (props.node.isFolder) {
      // 拖到目录 → 自动新建清单（由 TheSidebar 处理命名与创建），并展开目录让用户看到
      emit("taskDropToFolder", payload.id, props.node, props.kind);
      listStore.setNodeExpanded(props.node.id, true);
    } else {
      // 拖到清单（含 inbox）→ 移动到该清单
      emit("taskDrop", payload.id, props.node);
    }
    return;
  }

  // 收件箱 / 默认笔记本：自身不可拖，但接受清单的 before/after 排序 drop
  // （作为排序参照落点；它是清单行非目录，下方几何计算只会得到 before/after）

  const draggedIds = parseDraggedIds(e);
  // 目标节点是被拖节点自身或其后代 → 拒绝（防环；dragover 已禁高亮，此处兜底）
  if (draggedIds.length === 0 || isDropTargetForbidden(props.node.id, draggedIds)) {
    dragOver.value = null;
    return;
  }

  // 重新计算放置位置（不依赖 dragOver，因为它可能已被 dragLeave 清除）
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;

  let position: "before" | "after" | "inside";
  if (props.node.isFolder) {
    if (y < h * 0.33) position = "before";
    else if (y > h * 0.66) position = "after";
    else position = "inside";
  } else {
    position = y < h * 0.5 ? "before" : "after";
  }

  emit("move", draggedIds, props.node, position);

  // 如果是放入目录且目录收起，展开它
  if (position === "inside" && props.node.isFolder) {
    listStore.setNodeExpanded(props.node.id, true);
  }

  dragOver.value = null;
}
</script>

<template>
  <div class="list-node" :class="{ 'list-node--dragging': isDragging }">
    <!-- 目录 -->
    <div
      v-if="node.isFolder"
      class="list-node__row list-node__folder"
      :class="{
        'list-node--drag-over': dragOver === 'before' || dragOver === 'after',
        'list-node--drag-inside': dragOver === 'inside',
        'list-node--batch-selected': isBatchMode && isBatchSelected,
        'list-node--ghost': isGhost,
      }"
      :style="{ paddingLeft: getNodePaddingLeft(depth) }"
      :draggable="canDrag ? 'true' : 'false'"
      @click="onRowClick"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @contextmenu.prevent="onFolderContextMenu($event)"
    >
      <span class="list-node__expand" @click="listStore.toggleNodeExpanded(node.id)">
        <icon-down v-if="expanded" :size="12" />
        <icon-right v-else :size="12" />
      </span>
      <!-- 多选态：文件夹图标位置替换为 checkbox（多选时关注选中状态多于图标识别）。
           受保护节点（inbox/默认笔记本）与影子目录不参与多选，不显示 checkbox。
           点击 checkbox 也走行点击逻辑（@click.stop 防双重触发 + onRowClick 内 toggle）。 -->
      <a-checkbox
        v-if="isBatchMode && !isProtected && !isGhost"
        class="list-node__checkbox"
        :model-value="isBatchSelected"
        @click.stop="onRowClick"
      />
      <icon-folder
        v-else
        :size="16"
        class="list-node__folder-icon"
        :style="{ color: node.color }"
      />
      <span class="list-node__name">{{ node.name }}</span>
      <!-- 在该目录下新建清单/笔记本（hover 才显示）；只读模式（归档区）隐藏 -->
      <button
        v-if="!readonly"
        class="list-node__add-btn"
        :title="isNote ? '在此目录下新建笔记本' : '在此目录下新建清单'"
        @click.stop="emit('addList', node)"
      >
        <icon-plus :size="14" />
      </button>
      <MenuPopover v-if="!readonly" v-model:visible="folderMenuOpen">
        <template #trigger>
          <button class="list-node__menu-btn" @click.stop="folderMenuOpen = !folderMenuOpen">
            <icon-more :size="16" />
          </button>
        </template>
        <MenuPopoverItem @click="onMenuClick('addFolder')">
          <icon-plus :size="15" />
          <span>添加子目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onMenuClick('edit')">
          <icon-edit :size="15" />
          <span>编辑目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onMenuClick('delete')">
          <icon-delete :size="15" />
          <span>删除目录</span>
        </MenuPopoverItem>
        <MenuPopoverItem v-if="settingsStore.aiEnabled && !node.archived" @click="onMenuClick('aiSummary')">
          <icon-robot :size="15" />
          <span>AI 总结</span>
        </MenuPopoverItem>
        <!-- 归档：仅主页（未归档）显示。归档区由 contextmenu 触发取消归档，
             hover 菜单不暴露，避免误点导致跨树来回 -->
        <MenuPopoverItem v-if="!node.archived" @click="onMenuClick('archive')">
          <icon-archive :size="15" />
          <span>归档目录</span>
        </MenuPopoverItem>
      </MenuPopover>
    </div>

    <!-- 清单（非目录）—— 用 div 包裹以支持 draggable -->
    <div
      v-else
      class="list-node__row list-node__list-item"
      :class="{
        'list-node--active': isActive,
        'list-node--drag-over': dragOver === 'before' || dragOver === 'after' || dragOver === 'target',
        'list-node--batch-selected': isBatchMode && isBatchSelected,
      }"
      :style="{ paddingLeft: getNodePaddingLeft(depth) }"
      :draggable="canDrag ? 'true' : 'false'"
      @click="onRowClick"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @contextmenu.prevent="emit('contextmenu', $event, node)"
    >
      <span class="list-node__dot-placeholder" />
      <!-- 多选态：色点位置替换为 checkbox（多选时关注选中状态；批量改色由菜单承担）。
           受保护节点（inbox/默认笔记本）不参与多选，不显示 checkbox。
           点击 checkbox 也走行点击逻辑（@click.stop 防双重触发 + onRowClick 内 toggle）。 -->
      <a-checkbox
        v-if="isBatchMode && !isProtected"
        class="list-node__checkbox"
        :model-value="isBatchSelected"
        @click.stop="onRowClick"
      />
      <span
        v-else
        class="list-node__dot list-node__dot--clickable"
        :style="{ backgroundColor: node.color }"
        :title="`更改 ${node.name} 颜色`"
        @click.stop="(e: MouseEvent) => emit('colorClick', e, node)"
      />
      <span class="list-node__title">{{ node.name }}</span>
      <span v-if="(isNote ? taskStore.noteCounts : taskStore.listCounts)[node.id]" class="list-node__count">{{ (isNote ? taskStore.noteCounts : taskStore.listCounts)[node.id] }}</span>
      <!-- 更多菜单：所有清单/笔记本都有（含收件箱/默认笔记本）——
           受保护节点仅「新建条目 / AI 总结」两项，其余节点全量菜单 -->
      <MenuPopover
        v-if="!readonly"
        v-model:visible="listMenuOpen"
      >
        <template #trigger>
          <button class="list-node__menu-btn" @click.stop.prevent="listMenuOpen = !listMenuOpen">
            <icon-more :size="16" />
          </button>
        </template>
        <!-- 受保护节点（收件箱 inbox / 默认笔记本）：仅新建条目 + AI 总结，
             编辑/删除/归档等不适用（与右键菜单的精简分支保持一致） -->
        <template v-if="isProtected">
          <MenuPopoverItem @click="onMenuClick('addTask')">
            <icon-plus :size="15" />
            <span>{{ isNote ? "新建笔记" : "新建任务" }}</span>
          </MenuPopoverItem>
          <MenuPopoverItem v-if="settingsStore.aiEnabled" @click="onMenuClick('aiSummary')">
            <icon-robot :size="15" />
            <span>AI 总结</span>
          </MenuPopoverItem>
        </template>
        <template v-else>
          <MenuPopoverItem @click="onMenuClick('addTask')">
            <icon-plus :size="15" />
            <span>{{ isNote ? "新建笔记" : "新建任务" }}</span>
          </MenuPopoverItem>
          <!-- 导入笔记：仅笔记本（清单不显示），与右键菜单项一致 -->
          <MenuPopoverItem v-if="isNote" @click="onMenuClick('importNotes')">
            <icon-import :size="15" />
            <span>导入笔记…</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="onMenuClick('edit')">
            <icon-edit :size="15" />
            <span>{{ isNote ? "编辑笔记本" : "编辑清单" }}</span>
          </MenuPopoverItem>
          <MenuPopoverItem danger @click="onMenuClick('delete')">
            <icon-delete :size="15" />
            <span>{{ isNote ? "删除笔记本" : "删除清单" }}</span>
          </MenuPopoverItem>
          <MenuPopoverItem v-if="settingsStore.aiEnabled && !node.archived" @click="onMenuClick('aiSummary')">
            <icon-robot :size="15" />
            <span>AI 总结</span>
          </MenuPopoverItem>
          <!-- 归档：仅主页（未归档）显示 -->
          <MenuPopoverItem v-if="!node.archived" @click="onMenuClick('archive')">
            <icon-archive :size="15" />
            <span>{{ isNote ? "归档笔记本" : "归档清单" }}</span>
          </MenuPopoverItem>
        </template>
      </MenuPopover>
    </div>

    <!-- 递归渲染子节点 -->
    <div v-if="node.isFolder && expanded && node.children.length" class="list-node__children">
      <SidebarListNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :readonly="readonly"
        :kind="kind"
        :batch-mode="isBatchMode"
        :on-node-click="onNodeClick"
        :is-batch-selected-fn="isBatchSelectedFn"
        :is-protected="isProtected"
        @edit="(n: ListTreeNode) => $emit('edit', n)"
        @delete="(n: ListTreeNode) => $emit('delete', n)"
        @addFolder="(n: ListTreeNode) => $emit('addFolder', n)"
        @addList="(n: ListTreeNode) => $emit('addList', n)"
        @addTask="(n: ListTreeNode) => $emit('addTask', n)"
        @importNotes="(n: ListTreeNode) => $emit('importNotes', n)"
        @archive="(n: ListTreeNode) => $emit('archive', n)"
        @aiSummary="(n: ListTreeNode) => $emit('aiSummary', n)"
        @move="(ids: string[], target: ListTreeNode, pos: 'before' | 'after' | 'inside') => $emit('move', ids, target, pos)"
        @taskDrop="(taskId: string, target: ListTreeNode) => $emit('taskDrop', taskId, target)"
        @taskDropToFolder="(taskId: string, folder: ListTreeNode, k: 'task' | 'note') => $emit('taskDropToFolder', taskId, folder, k)"
        @contextmenu="(e: MouseEvent, n: ListTreeNode) => $emit('contextmenu', e, n)"
        @colorClick="(e: MouseEvent, n: ListTreeNode) => $emit('colorClick', e, n)"
      />
    </div>
  </div>
</template>

<style scoped>
/* 通用行样式 */
.list-node__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  position: relative;
}

/* 清单行（router-link）去掉下划线 */
.list-node__list-item {
  text-decoration: none;
}

.list-node__list-item:hover {
  background-color: var(--jt-surface-hover);
}

.list-node__folder:hover {
  background-color: var(--jt-surface-hover);
}

/* 影子目录（归档区分组展示的激活态祖先目录）：整体淡化 + 默认光标，
 * 仅作分组容器（展开箭头仍可交互），区别于可操作的真实归档目录 */
.list-node--ghost {
  cursor: default;
}

.list-node--ghost .list-node__expand,
.list-node--ghost .list-node__folder-icon,
.list-node--ghost .list-node__name {
  opacity: 0.55;
}

/* 选中状态（路由激活） */
.list-node--active {
  background-color: var(--jt-accent-soft) !important;
  color: var(--jt-primary);
}

.list-node--active:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 15%, var(--jt-accent-soft)) !important;
}

/* 批量选中态：背景比路由激活更浅（用透明混合避免 !important 竞争），
 * 名称加粗 + 主题色，区别于「当前路由激活」的单行态。
 * 注意：批量选中与路由激活可能同时存在（多选时当前路由行也在选中集合），
 * 此时批量选中背景覆盖激活背景（视觉优先级更高，因为多选是临时操作态）。 */
.list-node--batch-selected {
  background-color: color-mix(in srgb, var(--jt-primary) 10%, var(--jt-surface)) !important;
}

.list-node--batch-selected .list-node__title,
.list-node--batch-selected .list-node__name {
  color: var(--jt-primary);
  font-weight: 600;
}

/* 多选态行首 checkbox：替换色点/文件夹图标位置（行宽不变）。
 * 覆盖 Arco 默认样式（2px 粗边框 + 2px 小圆角 + Arco fill-3 浅灰，在 32px
 * 紧凑行内显笨重）：细边框 1.5px + 4px 圆角 + 主题 token（深浅模式自适应）。 */
.list-node__checkbox {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* 勾选框本体 */
.list-node__checkbox :deep(.arco-checkbox-icon) {
  width: 14px;
  height: 14px;
  border-width: 1.5px;
  border-color: var(--jt-border);
  border-radius: 4px;
  background-color: transparent;
  transition: border-color 0.15s, background-color 0.15s;
}

/* hover：边框加深，提示可点选 */
.list-node__checkbox:hover :deep(.arco-checkbox-icon) {
  border-color: var(--jt-text-tertiary);
}

/* 选中态：主题色填充（checked 类在 root 元素自身，须并写而非后代选择） */
.list-node__checkbox.arco-checkbox-checked :deep(.arco-checkbox-icon) {
  background-color: var(--jt-primary);
  border-color: var(--jt-primary);
}

/* 隐藏 Arco 自带细勾（8px svg，浅色主题下几乎不可见） */
.list-node__checkbox.arco-checkbox-checked :deep(.arco-checkbox-icon-check) {
  display: none;
}

/* 自绘粗勾：L 形 border 2px，颜色用 --jt-surface 自适应对比——
 * 浅色模式（深靛蓝底 + 白勾）/ 深色模式（浅靛蓝底 + 深勾）都清晰。
 * 覆盖 Arco 的 indeterminate 横条 ::after（checked 态下无需它）。 */
.list-node__checkbox.arco-checkbox-checked :deep(.arco-checkbox-icon)::after {
  width: 6px;
  height: 3px;
  border: none;
  border-left: 2px solid var(--jt-surface);
  border-bottom: 2px solid var(--jt-surface);
  border-radius: 0.5px;
  background: transparent;
  transform: translate(-50%, -62%) rotate(-45deg);
  transform-origin: center;
}

/* 隐藏 Arco icon-hover 大圆背景（hover 弹出 24px 圆形，紧凑行内突兀） */
.list-node__checkbox :deep(.arco-icon-hover.arco-checkbox-icon-hover::before) {
  display: none;
}

/* 拖拽中：原行不变透明度（与标签行为一致，仅高亮落点行；半透明视觉由拖动浏览器提供） */

/* drag-over：整行 outline 高亮（与标签 --drag-over 视觉一致） */
.list-node--drag-over {
  outline: 1.5px solid var(--jt-primary);
  outline-offset: -1.5px;
  background-color: var(--jt-accent-soft);
}

/* dragable 行：grab cursor（与标签一致） */
.list-node__row[draggable="true"] {
  cursor: grab;
}
.list-node__row[draggable="true"]:active {
  cursor: grabbing;
}

/* 不可拖拽行（收件箱 inbox）—— 在渲染层彻底阻止拖拽。
 * WKWebView (macOS) 中 draggable="false" 的元素其子文本节点仍默认可被
 * 原生拖拽，可能导致原生拖拽会话异常。-webkit-user-drag: none 是 WebKit
 * 专用属性，在渲染层阻止元素及其子元素启动拖拽，作为防御性保护。 */
.list-node__row[draggable="false"] {
  -webkit-user-drag: none;
}

/* drag-inside：放入目录 —— 用更深的 inset 阴影区别于排序提示 */
.list-node--drag-inside {
  background-color: color-mix(in srgb, var(--jt-primary) 12%, transparent) !important;
  box-shadow: inset 0 0 0 1.5px var(--jt-primary);
  border-radius: 8px;
}

/* 展开箭头 */
.list-node__expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
  cursor: pointer;
}

/* 文件夹图标（默认橙色，inline style 会覆盖为 node.color） */
.list-node__folder-icon {
  color: var(--jt-warning);
  flex-shrink: 0;
}

/* 名称 */
.list-node__name,
.list-node__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 色点占位（清单行对齐用） */
.list-node__dot-placeholder {
  width: 14px;
  flex-shrink: 0;
}

/* 色点 */
.list-node__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 色点可点击换色（清单/笔记本；目录与归档区无此态） */
.list-node__dot--clickable {
  cursor: pointer;
  transition: transform 0.12s;
}

.list-node__dot--clickable:hover {
  transform: scale(1.3);
}

/* 任务计数 */
.list-node__count {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
  position: absolute;
  right: 8px;
  transition: right 0.15s;
}

/* hover 时计数左移给菜单按钮让位 */
.list-node__list-item:hover .list-node__count,
.list-node__folder:hover .list-node__count {
  right: 32px;
}

/* 在目录下新建任务按钮 —— 仅目录行有，hover 显示 */
.list-node__add-btn {
  position: absolute;
  right: 28px;
  margin: 0;
  padding: 0;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 5;
}

.list-node__folder:hover .list-node__add-btn {
  opacity: 1;
}

.list-node__add-btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

/* hover 时让位：让 + 按钮跟更多按钮共存时计数再往左一点 */
.list-node__folder:hover .list-node__count {
  right: 56px;
}

/* 更多按钮 */
.list-node__menu-btn {
  position: absolute;
  top: 50%;
  right: 4px;
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
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

.list-node__row:hover .list-node__menu-btn {
  opacity: 1;
}

.list-node__menu-btn:hover {
  /* 选中态已有 accent-soft 背景，hover 不再叠加背景，只通过图标颜色加深反馈 */
  background-color: transparent;
  color: var(--jt-text-primary);
  color: var(--jt-text-primary);
}
</style>
