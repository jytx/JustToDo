// 看板视图多列拖拽 composable
//
// 参照 useTaskDragReorder 的设计（原生 Drag API + dragend 持久化），
// 扩展为多列横向 + 跨列拖拽：
// · dragstart 记录被拖任务 id + 源列优先级
// · dragover 阶段判断鼠标在哪个列 + 列内位置，实时调整 localColumns
// · dragend 时持久化：跨列改 priority + 持久化最终顺序

import { ref, watch } from "vue";
import type { Task, Priority } from "@/types";
import { useTaskStore } from "@/stores/task";

/** 优先级列定义 */
export const KANBAN_COLUMNS: Priority[] = [0, 1, 2, 3];

/**
 * 看板拖拽 composable。
 *
 * @param getOpenTasks 获取全部未完成任务的 getter
 * @returns 拖拽状态 + 事件处理器 + 按列分组的任务 id 映射
 */
export function useKanbanDrag(getOpenTasks: () => Task[]) {
  const taskStore = useTaskStore();

  /** 每列的本地顺序（priority → id 数组） */
  const localColumns = ref<Record<Priority, string[]>>({ 0: [], 1: [], 2: [], 3: [] });
  /** 正在被拖动的任务 id */
  const draggingId = ref<string | null>(null);
  /** 被拖任务的源列优先级 */
  const draggingFromPriority = ref<Priority | null>(null);

  /** 本次拖拽期间是否有变化（用于 dragend 判断要不要持久化） */
  let dragChanged = false;

  /** 拖拽进行中（dragstart→dragend 期间禁止 watch 重置 localColumns） */
  let isDragging = false;

  /** store 数据变化时同步本地列（加载/新建/删除后） */
  watch(
    () => getOpenTasks(),
    (tasks) => {
      // 拖拽期间不重置（否则 updateTask/persistTaskOrder 触发的 store 变化会覆盖拖拽结果）
      if (isDragging) return;
      const cols: Record<Priority, string[]> = { 0: [], 1: [], 2: [], 3: [] };
      // 按 sortOrder 排序后分组
      const sorted = [...tasks].sort((a, b) => a.sortOrder - b.sortOrder);
      for (const t of sorted) {
        const p = (t.priority ?? 0) as Priority;
        if (cols[p]) cols[p].push(t.id);
      }
      localColumns.value = cols;
    },
    { immediate: true, deep: true },
  );

  /** dragstart：记录被拖任务 id + 源列 */
  function onCardDragStart(taskId: string, priority: Priority): void {
    draggingId.value = taskId;
    draggingFromPriority.value = priority;
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
    columnEls: Map<Priority, HTMLElement>,
  ): { priority: Priority; index: number } | null {
    // 找鼠标在哪个列（水平方向）
    let targetPriority: Priority | null = null;
    for (const [p, el] of columnEls) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        targetPriority = p;
        break;
      }
    }
    // 鼠标不在任何列内（在列间隙），用最近列兜底
    if (targetPriority === null) {
      let minDist = Infinity;
      for (const [p, el] of columnEls) {
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const dist = Math.abs(clientX - centerX);
        if (dist < minDist) {
          minDist = dist;
          targetPriority = p;
        }
      }
    }
    if (targetPriority === null) return null;

    // 在目标列内按 clientY 中点找插入位置。
    // 直接遍历 DOM 卡片元素，返回它在「目标列不含 dragging」的序列中的序号，
    // 这个序号就是插入位置（不查 localColumns，避免 DOM 和数据不同步）。
    const targetEl = columnEls.get(targetPriority);
    if (!targetEl) return { priority: targetPriority, index: 0 };

    const cards = Array.from(
      targetEl.querySelectorAll<HTMLElement>("[data-card-id]"),
    ).filter((c) => c.getAttribute("data-card-id") !== draggingId.value);

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      // 鼠标在该卡片上半段 → 插到它前面（序号 i 就是插入位置）
      if (clientY <= centerY) {
        return { priority: targetPriority, index: i };
      }
    }
    // 鼠标在所有卡片下方 → 插到末尾
    return { priority: targetPriority, index: cards.length };
  }

  /**
   * 列级 dragover：实时调整 localColumns（跨列 + 列内排序）。
   * columnEls 由 KanbanView 传入（每列容器的 DOM 引用映射）。
   */
  function onColumnDragOver(
    e: DragEvent,
    columnEls: Map<Priority, HTMLElement>,
  ): void {
    if (!draggingId.value) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";

    const target = computeTarget(e.clientX, e.clientY, columnEls);
    if (!target) return;

    // 从所有列中移除 dragging
    const newCols: Record<Priority, string[]> = { 0: [], 1: [], 2: [], 3: [] };
    for (const p of KANBAN_COLUMNS) {
      newCols[p] = localColumns.value[p].filter((id) => id !== draggingId.value);
    }
    // 插入目标列的目标位置
    const clampedIdx = Math.max(0, Math.min(target.index, newCols[target.priority].length));
    newCols[target.priority].splice(clampedIdx, 0, draggingId.value);

    // 检查是否有变化
    let changed = false;
    for (const p of KANBAN_COLUMNS) {
      if (newCols[p].length !== localColumns.value[p].length ||
          newCols[p].some((id, i) => id !== localColumns.value[p][i])) {
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
      if (draggingId.value && dragChanged) {
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

  /** 持久化拖拽结果（跨列改 priority + 全局重排 sortOrder）。
   *  可能被 drop / dragend / autoPersist 多次调用，用 persisting 标志防重。 */
  let persisting = false;
  async function persistDragResult(): Promise<void> {
    if (persisting) return;
    persisting = true;
    const taskId = draggingId.value;
    const fromPriority = draggingFromPriority.value;

    if (!taskId || !fromPriority || !dragChanged) {
      persisting = false;
      isDragging = false;
      draggingId.value = null;
      draggingFromPriority.value = null;
      return;
    }

    // 找任务当前在哪个列
    let toPriority: Priority | null = null;
    for (const p of KANBAN_COLUMNS) {
      if (localColumns.value[p].includes(taskId)) {
        toPriority = p;
        break;
      }
    }
    if (toPriority === null) {
      isDragging = false;
      draggingId.value = null;
      draggingFromPriority.value = null;
      persisting = false;
      return;
    }

    // 跨列：先改优先级
    if (toPriority !== fromPriority) {
      await taskStore.updateTask(taskId, { priority: toPriority });
    }

    // 持久化所有列的顺序（sortOrder 全局重排）
    const allIds: string[] = [];
    for (const p of KANBAN_COLUMNS) {
      allIds.push(...localColumns.value[p]);
    }
    await taskStore.persistTaskOrder(allIds);

    isDragging = false;
    draggingId.value = null;
    draggingFromPriority.value = null;
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
    /** 每列的本地顺序（priority → id 数组） */
    localColumns,
    /** 正在被拖动的任务 id */
    draggingId,
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
