// 任务项内标签拖拽排序 composable —— 拖动任务项上的标签 chip，调整该任务内标签的显示顺序。
//
// 与任务行拖拽（TaskListItem 的 onDragStart 等，用 text/plain）、侧边栏标签拖拽
// （TheSidebar，用 text/plain）完全隔离：
// - 本 composable 用自定义 MIME「application/x-task-tag-reorder」标记拖拽类型；
//   任务行拖拽和侧边栏标签拖拽都不写这个 MIME，三方互不干扰。
// - 所有 chip 拖拽事件处理器内 stopPropagation，阻断冒泡到外层 .task-item 的任务行
//   drag handler（避免触发任务重排 / FLIP 让位 / 覆写 text/plain）。
//
// 与 useGroupReorder（纵向 before/after）的区别：标签 chip 是横向排列（flex-wrap），
// 落点判定按 chip 的 getBoundingClientRect 中心点左右半区（左半=before / 右半=after）。
//
// 持久化调 taskStore.reorderTaskTags（乐观更新 taskTagMap + 调 task_reorder_tags 命令），
// 后端按 i*1000 全量重写 task_tags.sort_order。

import { ref, reactive, watch, type Ref } from "vue";
import type { Tag } from "@/api/db";
import { useTaskStore } from "@/stores/task";

/** 标签拖拽专用的 dataTransfer MIME，与任务拖拽（text/plain）区分 */
export const TASK_TAG_REORDER_MIME = "application/x-task-tag-reorder";

/** 落点位置：目标标签的左侧 / 右侧 */
type DropPos = "before" | "after";

/**
 * 任务项内标签拖拽排序
 *
 * @param getTaskId 获取当前任务 id 的 getter（持久化时用；用 getter 而非固定字符串，
 *                  支持详情面板切换任务后仍持久化到正确的 task）
 * @param sourceTags 响应式的外部标签数据源（来自 taskStore.taskTagMap[taskId]）
 * @returns 本地有序标签数组 + 拖拽状态 + 事件处理器
 */
export function useTaskTagReorder(getTaskId: () => string, sourceTags: Ref<Tag[]>) {
  const taskStore = useTaskStore();

  /** 本地有序标签数组（拖拽中实时调整，驱动渲染） */
  const localTags = ref<Tag[]>([...sourceTags.value]);

  /** 正在被拖动的标签 id */
  const draggingTagId = ref<string | null>(null);

  /** 落点高亮：目标标签 id + 位置（before/after）；id 为空串表示无落点 */
  const dragOver = reactive<{ id: string; pos: DropPos }>({ id: "", pos: "before" });

  /** 拖拽进行中（禁止外部 watch 覆盖本地中间态） */
  let isDragging = false;
  /** 持久化防重入 */
  let persisting = false;
  /** 本次拖拽是否有变化 */
  let dragChanged = false;
  /** 拖拽源标签 id 快照（dragend 清空 ref 后兜底用） */
  let lastDragId: string | null = null;

  /** 同步外部数据到 localTags（非拖拽期间由 watch 自动调用） */
  function syncFromStore(tags: Tag[]): void {
    if (isDragging) return;
    localTags.value = [...tags];
  }

  // 外部数据变化时同步（如增删标签、切换任务后 store 刷新）
  watch(
    sourceTags,
    (tags) => syncFromStore(tags),
    { deep: true },
  );

  /** 判定 dataTransfer 是否为标签拖拽（区分任务拖拽 / 侧边栏标签拖拽） */
  function isTagDrag(e: DragEvent): boolean {
    // 优先认自定义 MIME；部分 WKWebView 读自定义 MIME 不可靠时，
    // 用 draggingTagId 兜底（任务拖拽不会设本 composable 的 draggingTagId）
    return e.dataTransfer?.types.includes(TASK_TAG_REORDER_MIME) || draggingTagId.value !== null;
  }

  /** chip dragstart：写自定义 MIME + 记录源 + stopPropagation 阻断任务行 dragstart */
  function onTagDragStart(e: DragEvent, tagId: string): void {
    e.stopPropagation(); // 阻止冒泡到 .task-item 的 onDragStart（否则会覆写 text/plain 为 task id）
    draggingTagId.value = tagId;
    lastDragId = tagId;
    isDragging = true;
    dragChanged = false;
    e.dataTransfer!.setData(TASK_TAG_REORDER_MIME, tagId);
    // 同时写 text/plain 兜底（部分环境对自定义 MIME 兼容性差），但任务行/侧边栏
    // 的 drop handler 不读这个 MIME，且本 composable 的 handler 已 stopPropagation，
    // 所以不会被它们误处理。
    e.dataTransfer!.setData("text/plain", tagId);
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.dropEffect = "move";
  }

  /** chip dragover：算左右落点 before/after，实时重排本地数组 + 调度 autoPersist。
   *  实时重排让标签在拖动过程中就"让位"（与任务拖拽体验一致），不等到 drop。 */
  function onTagDragOver(e: DragEvent, tagId: string): void {
    if (!isTagDrag(e)) return; // 任务拖拽：不干预（放行给外层）
    e.preventDefault(); // 允许 drop
    e.stopPropagation(); // 阻断任务行 onDragOver（否则会显示任务重排高亮 + FLIP 让位）
    e.dataTransfer!.dropEffect = "move";

    const draggedId = draggingTagId.value;
    if (!draggedId || draggedId === tagId) return; // 无效源或拖到自己

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pos: DropPos = x < rect.width / 2 ? "before" : "after";
    dragOver.id = tagId;
    dragOver.pos = pos;
    reorderLocal(draggedId, tagId, pos);
    scheduleAutoPersist();
  }

  /** chip dragleave：清落点高亮（仅真正离开时） */
  function onTagDragLeave(e: DragEvent, tagId: string): void {
    if (!isTagDrag(e)) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    if (dragOver.id === tagId) {
      dragOver.id = "";
    }
  }

  /** chip drop：dragover 已实时重排，这里直接持久化 */
  function onTagDrop(e: DragEvent, tagId: string): void {
    if (!isTagDrag(e)) return; // 任务拖拽：放行给外层
    e.preventDefault();
    e.stopPropagation(); // 阻断任务行 onDrop（否则会误触发任务重排）

    const draggedId = draggingTagId.value ?? lastDragId;
    if (!draggedId || draggedId === tagId) {
      clearDragState();
      return;
    }
    void persist();
  }

  /** 重排本地数组：把 draggedId 移到 targetId 的 before/after 位置 */
  function reorderLocal(draggedId: string, targetId: string, pos: DropPos): void {
    const ids = localTags.value.filter((t) => t.id !== draggedId);
    const targetIndex = ids.findIndex((t) => t.id === targetId);
    if (targetIndex === -1) return;
    const draggedTag = localTags.value.find((t) => t.id === draggedId);
    if (!draggedTag) return;
    const insertIndex = pos === "before" ? targetIndex : targetIndex + 1;
    ids.splice(insertIndex, 0, draggedTag);
    localTags.value = ids;
    dragChanged = true;
  }

  /** autoPersist 计时器（dragover 停止 500ms 后兜底持久化，WKWebView drop/dragend 不可靠） */
  let autoPersistTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutoPersist(): void {
    if (autoPersistTimer) clearTimeout(autoPersistTimer);
    autoPersistTimer = setTimeout(() => {
      autoPersistTimer = null;
      if (dragChanged) void persist();
    }, 500);
  }

  /** 持久化：把本地顺序整体提交给 store（乐观更新 + 后端 i*1000 重写） */
  async function persist(): Promise<void> {
    if (persisting) return;
    if (!dragChanged) {
      clearDragState();
      return;
    }
    persisting = true;
    try {
      const orderedIds = localTags.value.map((t) => t.id);
      await taskStore.reorderTaskTags(getTaskId(), orderedIds);
    } finally {
      dragChanged = false;
      persisting = false;
      clearDragState();
    }
  }

  /** 清理拖拽状态 */
  function clearDragState(): void {
    isDragging = false;
    draggingTagId.value = null;
    dragOver.id = "";
  }

  /** chip dragend：清状态 + 兜底持久化 */
  function onTagDragEnd(e: DragEvent): void {
    e.stopPropagation(); // 阻断任务行 onDragEnd
    if (dragChanged) void persist();
    else clearDragState();
  }

  return {
    /** 本地有序标签数组（渲染数据源） */
    localTags,
    /** 正在被拖动的标签 id */
    draggingTagId,
    /** 落点高亮状态 */
    dragOver,
    /** 手动同步外部数据（一般由 watch 自动触发，极少手动调） */
    syncFromStore,
    /** chip dragstart */
    onTagDragStart,
    /** chip dragover */
    onTagDragOver,
    /** chip dragleave */
    onTagDragLeave,
    /** chip drop */
    onTagDrop,
    /** chip dragend */
    onTagDragEnd,
  };
}
