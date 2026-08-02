// 看板视图多列拖拽 composable
//
// 参照 useTaskDragReorder 的设计（原生 Drag API + dragend 持久化），
// 扩展为多列横向 + 跨列拖拽：
// · dragstart 记录被拖任务 id + 源列 key
// · dragover 阶段判断鼠标在哪个列 + 列内位置，实时调整 localColumns
// · dragend 时持久化：跨列改字段（优先级 / 分组）+ 持久化最终顺序
//
// 列键类型为通用 string，由调用方决定语义：
// - 优先级模式：列键 = String(priority)，跨列改 priority
// - 分组模式：列键 = groupId，跨列改 groupId

import { ref, watch } from "vue";
import type { Task } from "@/types";
import { useTaskStore } from "@/stores/task";

/** 列定义（调用方按模式生成：优先级列 / 分组列） */
export interface KanbanColumnDef {
  /** 列的唯一键（优先级模式是 "0"/"1"/...；分组模式是 groupId） */
  key: string;
  /** 列标题 */
  label: string;
  /** 列头色点颜色（优先级色 / 分组用次要色） */
  color: string;
}

/**
 * 看板拖拽 composable（参数化列键，支持优先级 / 分组两种模式）。
 *
 * @param getOpenTasks 获取全部未完成任务的 getter
 * @param getColumnKey 从任务取所属列键（优先级模式返回 String(t.priority)，分组模式返回 t.groupId）
 * @param onCrossColumn 跨列持久化回调（优先级模式 updateTask priority，分组模式 updateTask groupId）
 * @param columnKeys 当前所有列键（用于初始化 localColumns + 遍历）
 * @returns 拖拽状态 + 事件处理器 + 按列分组的任务 id 映射
 */
export function useKanbanDrag(
  getOpenTasks: () => Task[],
  getColumnKey: (task: Task) => string,
  onCrossColumn: (taskId: string, toKey: string) => Promise<void>,
  columnKeys: () => string[],
) {
  const taskStore = useTaskStore();

  /** 建一个空的列映射（键来自 columnKeys，避免残留旧模式的列） */
  function emptyCols(): Record<string, string[]> {
    const cols: Record<string, string[]> = {};
    for (const k of columnKeys()) cols[k] = [];
    return cols;
  }

  /** 每列的本地顺序（列键 → id 数组） */
  const localColumns = ref<Record<string, string[]>>(emptyCols());
  /** 正在被拖动的任务 id */
  const draggingId = ref<string | null>(null);
  /** 被拖任务的源列键 */
  const draggingFromKey = ref<string | null>(null);

  /** 本次拖拽期间是否有变化（用于 dragend 判断要不要持久化） */
  let dragChanged = false;
  /** 被拖任务的 id 快照（dragend 清空 ref 后，autoPersist 仍可用闭包变量） */
  let lastDragTaskId: string | null = null;
  /** 被拖任务的源列键快照 */
  let lastDragFromKey: string | null = null;

  /** 拖拽进行中（dragstart→dragend 期间禁止 watch 重置 localColumns） */
  let isDragging = false;

  /** store 数据变化时同步本地列（加载/新建/删除后）。
   *  拖拽期间跳过，避免覆盖拖拽中间态。 */
  function syncFromStore(): void {
    if (isDragging) return;
    const tasks = getOpenTasks();
    const cols = emptyCols();
    // 按 sortOrder 排序后分组
    const sorted = [...tasks].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const t of sorted) {
      const k = getColumnKey(t);
      if (cols[k]) cols[k].push(t.id);
    }
    localColumns.value = cols;
  }

  watch(
    () => getOpenTasks(),
    () => syncFromStore(),
    { immediate: true, deep: true },
  );

  /** dragstart：记录被拖任务 id + 源列 */
  function onCardDragStart(taskId: string, columnKey: string): void {
    draggingId.value = taskId;
    draggingFromKey.value = columnKey;
    lastDragTaskId = taskId;
    lastDragFromKey = columnKey;
    dragChanged = false;
    isDragging = true;
  }

  /**
   * 根据鼠标坐标判断目标列 + 列内插入位置。
   * 遍历所有列容器，找到鼠标所在的列；再在该列内按 clientY 中点找位置。
   */
  function computeTarget(
    clientX: number,
    clientY: number,
    columnEls: Map<string, HTMLElement>,
  ): { key: string; index: number } | null {
    // 找鼠标在哪个列（水平方向）
    let targetKey: string | null = null;
    for (const [k, el] of columnEls) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        targetKey = k;
        break;
      }
    }
    // 鼠标不在任何列内（在列间隙），用最近列兜底
    if (targetKey === null) {
      let minDist = Infinity;
      for (const [k, el] of columnEls) {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const dist = Math.abs(clientX - centerX);
        if (dist < minDist) {
          minDist = dist;
          targetKey = k;
        }
      }
    }
    if (targetKey === null) return null;

    // 在目标列内按 clientY 中点找插入位置。
    // 直接遍历 DOM 卡片元素，返回它在「目标列不含 dragging」的序列中的序号，
    // 这个序号就是插入位置（不查 localColumns，避免 DOM 和数据不同步）。
    const targetEl = columnEls.get(targetKey);
    if (!targetEl) return { key: targetKey, index: 0 };

    const cards = Array.from(
      targetEl.querySelectorAll<HTMLElement>("[data-card-id]"),
    ).filter((c) => c.getAttribute("data-card-id") !== draggingId.value);

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      // 鼠标在该卡片上半段 → 插到它前面（序号 i 就是插入位置）
      if (clientY <= centerY) {
        return { key: targetKey, index: i };
      }
    }
    // 鼠标在所有卡片下方 → 插到末尾
    return { key: targetKey, index: cards.length };
  }

  /**
   * 列级 dragover：实时调整 localColumns（跨列 + 列内排序）。
   * columnEls 由 KanbanView 传入（每列容器的 DOM 引用映射）。
   */
  function onColumnDragOver(
    e: DragEvent,
    columnEls: Map<string, HTMLElement>,
  ): void {
    if (!draggingId.value) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";

    const target = computeTarget(e.clientX, e.clientY, columnEls);
    if (!target) return;

    // 从所有列中移除 dragging
    const newCols = emptyCols();
    const keys = columnKeys();
    for (const k of keys) {
      newCols[k] = (localColumns.value[k] ?? []).filter((id) => id !== draggingId.value);
    }
    // 插入目标列的目标位置
    const clampedIdx = Math.max(0, Math.min(target.index, (newCols[target.key] ?? []).length));
    if (!newCols[target.key]) newCols[target.key] = [];
    newCols[target.key].splice(clampedIdx, 0, draggingId.value);

    // 检查是否有变化
    let changed = false;
    for (const k of keys) {
      const before = localColumns.value[k] ?? [];
      const after = newCols[k] ?? [];
      if (before.length !== after.length || after.some((id, i) => id !== before[i])) {
        changed = true;
        break;
      }
    }
    if (changed) {
      localColumns.value = newCols;
      dragChanged = true;
      // 每次有变化时重置自动持久化计时器（dragover 停止 500ms 后自动持久化）
      // 这是 WKWebView 的兜底方案：drop/dragend 可能不触发
      scheduleAutoPersist();
    }
  }

  /** 自动持久化计时器（dragover 停止后 500ms 触发，兜底 drop/dragend 不触发的情况） */
  let autoPersistTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutoPersist(): void {
    if (autoPersistTimer) clearTimeout(autoPersistTimer);
    autoPersistTimer = setTimeout(() => {
      autoPersistTimer = null;
      // 不检查 draggingId（dragend 可能已清空它），只看 dragChanged
      if (dragChanged) {
        void persistDragResult();
      }
    }, 500);
  }

  /** drop：在目标列上释放，触发持久化（WKWebView 的 dragend 不可靠，以 drop 为准） */
  function onColumnDrop(e: DragEvent): void {
    if (!draggingId.value) return;
    e.preventDefault();
    void persistDragResult();
  }

  /** 持久化拖拽结果（跨列改字段 + 全局重排 sortOrder）。
   *  可能被 drop / dragend / autoPersist 多次调用，用 persisting 标志防重。 */
  let persisting = false;
  async function persistDragResult(): Promise<void> {
    if (persisting) return;
    // 用闭包快照（dragend 可能已清空 draggingId ref，但闭包变量还在）
    const taskId = draggingId.value ?? lastDragTaskId;
    const fromKey = draggingFromKey.value ?? lastDragFromKey;

    if (!taskId || fromKey === null || !dragChanged) {
      isDragging = false;
      draggingId.value = null;
      draggingFromKey.value = null;
      return;
    }
    persisting = true;

    // 找任务当前在哪个列
    let toKey: string | null = null;
    for (const k of columnKeys()) {
      if ((localColumns.value[k] ?? []).includes(taskId)) {
        toKey = k;
        break;
      }
    }
    if (toKey === null) {
      isDragging = false;
      draggingId.value = null;
      draggingFromKey.value = null;
      persisting = false;
      return;
    }

    // 跨列：改对应字段（优先级 / 分组），由调用方的 onCrossColumn 决定
    if (toKey !== fromKey) {
      await onCrossColumn(taskId, toKey);
    }

    // 持久化所有列的顺序（sortOrder 全局重排）
    const allIds: string[] = [];
    for (const k of columnKeys()) {
      allIds.push(...(localColumns.value[k] ?? []));
    }
    await taskStore.persistTaskOrder(allIds);

    isDragging = false;
    draggingId.value = null;
    draggingFromKey.value = null;
    dragChanged = false;
    persisting = false;
  }

  /**
   * dragend：拖拽结束的兜底钩子。
   * 主要持久化由 drop 完成；dragend 清理状态，若 drop 没触发但 dragChanged 为 true 也兜底持久化。
   */
  async function onCardDragEnd(): Promise<void> {
    // 如果 drop 已经处理了（draggingId 已清空），什么都不做
    if (!draggingId.value) return;
    // drop 没触发，用 dragend 兜底
    await persistDragResult();
  }

  return {
    /** 每列的本地顺序（列键 → id 数组） */
    localColumns,
    /** 正在被拖动的任务 id */
    draggingId,
    /** 手动重新从 store 同步（模式切换时调用，因 getColumnKey 变了 watch 不会自动触发） */
    syncFromStore,
    /** dragstart 处理器 */
    onCardDragStart,
    /** 列级 dragover 处理器 */
    onColumnDragOver,
    /** drop 处理器 */
    onColumnDrop,
    /** dragend 处理器 */
    onCardDragEnd,
  };
}
