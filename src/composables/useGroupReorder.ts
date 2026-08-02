// 分组拖拽排序 composable —— 拖动分组标题手柄，调整分组先后顺序。
//
// 与任务跨组拖拽（useGroupDrag）完全隔离：
// - 本 composable 用自定义 MIME「application/x-group-reorder」标记拖拽类型；
//   任务拖拽用 text/plain。两者 drop handler 各自只认自己的类型，互不干扰。
// - 数据模型是单层有序 id 数组（分组自身的顺序），不是任务那种「多容器分布」。
//
// 持久化直接复用 groupStore.reorderGroups（全量重写 sort_order = i*1000），
// 后端 group_reorder 命令已就绪，无需改动 store/db/Rust。

import { ref, reactive } from "vue";
import { useGroupStore } from "@/stores/group";

/** 分组拖拽专用的 dataTransfer MIME，与任务拖拽（text/plain）区分 */
export const GROUP_REORDER_MIME = "application/x-group-reorder";

/** 落点位置：目标分组的上方 / 下方 */
type DropPos = "before" | "after";

/**
 * 分组拖拽排序
 *
 * @param getGroupIds 返回当前清单分组 id 的有序列表（getter，随 store 变化）
 * @returns 本地有序数组 + 拖拽状态 + 事件处理器
 */
export function useGroupReorder(getGroupIds: () => string[]) {
  const groupStore = useGroupStore();

  /** 本地有序分组 id（拖拽中实时调整，驱动渲染） */
  const localGroupIds = ref<string[]>([...getGroupIds()]);

  /** 正在被拖动的分组 id */
  const draggingId = ref<string | null>(null);

  /** 落点高亮：目标分组 id + 位置（before/after）；id 为空串表示无落点 */
  const dragOver = reactive<{ id: string; pos: DropPos }>({ id: "", pos: "before" });

  /** 拖拽进行中（禁止 syncFromStore 覆盖本地中间态） */
  let isDragging = false;
  /** 持久化防重入 */
  let persisting = false;
  /** 本次拖拽是否有变化 */
  let dragChanged = false;
  /** 拖拽源分组 id 快照（dragend 清空 ref 后兜底用） */
  let lastDragId: string | null = null;

  /** 同步 store 数据到 localGroupIds（非拖拽期间调用） */
  function syncFromStore(): void {
    if (isDragging) return;
    localGroupIds.value = [...getGroupIds()];
  }

  /** 拖拽手柄 dragstart：写自定义 MIME + 记录源分组 */
  function onHandleDragStart(e: DragEvent, groupId: string): void {
    draggingId.value = groupId;
    lastDragId = groupId;
    isDragging = true;
    dragChanged = false;
    // 自定义 MIME 标记分组拖拽类型；同时写 text/plain 兜底（部分环境对自定义 MIME 兼容性差）
    e.dataTransfer!.setData(GROUP_REORDER_MIME, groupId);
    e.dataTransfer!.setData("text/plain", groupId);
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.dropEffect = "move";
  }

  /** 判定 dataTransfer 是否为分组拖拽（区分任务拖拽） */
  function isGroupDrag(e: DragEvent): boolean {
    // 优先认自定义 MIME；部分 WKWebView 读自定义 MIME 不可靠时，
    // 用 draggingId 兜底（任务拖拽不会设本 composable 的 draggingId）
    return e.dataTransfer?.types.includes(GROUP_REORDER_MIME) || draggingId.value !== null;
  }

  /** header dragover：算落点 before/after，实时重排本地数组 + 调度 autoPersist。
   *  实时重排让分组在拖动过程中就"让位"（与任务拖拽体验一致），不等到 drop。 */
  function onHeaderDragOver(e: DragEvent, groupId: string): void {
    if (!isGroupDrag(e)) return; // 任务拖拽：不干预
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const draggedId = draggingId.value;
    if (!draggedId || draggedId === groupId) return; // 无效源或拖到自己

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const pos: DropPos = y < rect.height / 2 ? "before" : "after";
    dragOver.id = groupId;
    dragOver.pos = pos;
    reorderLocal(draggedId, groupId, pos);
    scheduleAutoPersist();
  }

  /** header dragleave：清落点高亮（仅真正离开时） */
  function onHeaderDragLeave(e: DragEvent, groupId: string): void {
    if (!isGroupDrag(e)) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    if (dragOver.id === groupId) {
      dragOver.id = "";
    }
  }

  /** header drop：dragover 已实时重排，这里直接持久化（WKWebView 下 drop 可能不触发，autoPersist 兜底） */
  function onHeaderDrop(e: DragEvent, targetId: string): void {
    if (!isGroupDrag(e)) return; // 任务拖拽：放行给外层任务 drop
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到外层 .list-view__content 的任务 drop

    const draggedId = draggingId.value ?? lastDragId;
    if (!draggedId || draggedId === targetId) {
      clearDragState();
      return;
    }
    void persist();
  }

  /** 重排本地数组：把 draggedId 移到 targetId 的 before/after 位置 */
  function reorderLocal(draggedId: string, targetId: string, pos: DropPos): void {
    const ids = localGroupIds.value.filter((id) => id !== draggedId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex === -1) return;
    const insertIndex = pos === "before" ? targetIndex : targetIndex + 1;
    ids.splice(insertIndex, 0, draggedId);
    localGroupIds.value = ids;
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

  /** 持久化：把本地顺序整体提交给 store（全量重写 sort_order） */
  async function persist(): Promise<void> {
    if (persisting) return;
    if (!dragChanged) {
      clearDragState();
      return;
    }
    persisting = true;
    try {
      await groupStore.reorderGroups(localGroupIds.value);
    } finally {
      dragChanged = false;
      persisting = false;
      clearDragState();
    }
  }

  /** 清理拖拽状态 */
  function clearDragState(): void {
    isDragging = false;
    draggingId.value = null;
    dragOver.id = "";
  }

  /** 手柄 dragend：清状态 + 兜底持久化 */
  function onHandleDragEnd(): void {
    if (dragChanged) void persist();
    else clearDragState();
  }

  return {
    /** 本地有序分组 id（渲染数据源） */
    localGroupIds,
    /** 正在被拖动的分组 id */
    draggingId,
    /** 落点高亮状态 */
    dragOver,
    /** 同步 store 数据（非拖拽期间调用） */
    syncFromStore,
    /** 手柄 dragstart */
    onHandleDragStart,
    /** header dragover */
    onHeaderDragOver,
    /** header dragleave */
    onHeaderDragLeave,
    /** header drop */
    onHeaderDrop,
    /** 手柄 dragend */
    onHandleDragEnd,
  };
}
