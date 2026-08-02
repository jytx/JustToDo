// 分组拖拽 composable —— 任务在分组间拖拽（跨组改 group_id + 组内排序）
//
// 参照 useKanbanDrag 的设计（原生 Drag API + autoPersist 兜底），
// 适配 ListView 的分组折叠区：每个分组一个拖拽容器。
//
// 与 useKanbanDrag 的差异：
// - 分组是动态的（用户可增删），不像优先级是固定 4 列
// - 容器是 collapse-item 内的 div，由 ListView 传入 DOM 引用

import { ref, reactive } from "vue";
import type { Task } from "@/types";
import { useTaskStore } from "@/stores/task";

/**
 * 分组拖拽 composable
 *
 * @param getOpenTasks 获取全部未完成任务的 getter
 * @param getGroupIds 获取当前清单所有分组 ID 的 getter（按顺序）
 * @returns 拖拽状态 + 事件处理器
 */
export function useGroupDrag(
  getOpenTasks: () => Task[],
  getGroupIds: () => string[],
) {
  const taskStore = useTaskStore();

  /** 每组的本地顺序（groupId → id 数组） */
  const localGroups = reactive<Record<string, string[]>>({});

  /** 正在被拖动的任务 id */
  const draggingId = ref<string | null>(null);
  /** 被拖任务的源分组 */
  let lastDragTaskId: string | null = null;
  let lastDragFromGroup: string | null = null;

  /** 本次拖拽是否有变化 */
  let dragChanged = false;
  /** 拖拽进行中（禁止 watch 重置） */
  let isDragging = false;
  /** 持久化防重入 */
  let persisting = false;

  /** 同步 store 数据到 localGroups（非拖拽期间调用） */
  function syncFromStore(): void {
    if (isDragging) return;
    const tasks = getOpenTasks();
    const groupIds = getGroupIds();
    // 清空旧数据
    for (const key of Object.keys(localGroups)) {
      delete localGroups[key];
    }
    // 按 sortOrder 排序后分组
    const sorted = [...tasks].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const gid of groupIds) {
      localGroups[gid] = sorted
        .filter((t) => (t.groupId ?? "") === gid)
        .map((t) => t.id);
    }
    // 兜底：groupId 不在任何已知分组里的任务
    const knownIds = new Set(groupIds);
    for (const t of sorted) {
      const gid = t.groupId ?? "";
      if (!knownIds.has(gid)) {
        if (!localGroups[gid]) localGroups[gid] = [];
        localGroups[gid].push(t.id);
      }
    }
  }

  /** dragstart */
  function onTaskDragStart(taskId: string, groupId: string): void {
    draggingId.value = taskId;
    lastDragTaskId = taskId;
    lastDragFromGroup = groupId;
    dragChanged = false;
    isDragging = true;
  }

  /**
   * dragover：判断鼠标在哪个分组容器 + 列内位置，实时调整 localGroups。
   * groupEls 由 ListView 传入（groupId → 容器 DOM）。
   */
  function onGroupDragOver(
    e: DragEvent,
    groupEls: Map<string, HTMLElement>,
  ): void {
    if (!draggingId.value) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";

    const target = computeTarget(e.clientX, e.clientY, groupEls);
    if (!target) return;

    // 从所有组中移除 dragging
    for (const gid of Object.keys(localGroups)) {
      localGroups[gid] = localGroups[gid].filter((id) => id !== draggingId.value);
    }
    // 插入目标组
    if (!localGroups[target.groupId]) localGroups[target.groupId] = [];
    const clampedIdx = Math.max(0, Math.min(target.index, localGroups[target.groupId].length));
    localGroups[target.groupId].splice(clampedIdx, 0, draggingId.value);

    dragChanged = true;
    scheduleAutoPersist();
  }

  /** 计算鼠标在哪个组 + 组内位置 */
  function computeTarget(
    clientX: number,
    clientY: number,
    groupEls: Map<string, HTMLElement>,
  ): { groupId: string; index: number } | null {
    // 找鼠标在哪个组容器
    let targetGroup: string | null = null;
    for (const [gid, el] of groupEls) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom) {
        targetGroup = gid;
        break;
      }
    }
    // 用最近组兜底
    if (!targetGroup) {
      let minDist = Infinity;
      for (const [gid, el] of groupEls) {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(clientX - cx, clientY - cy);
        if (dist < minDist) {
          minDist = dist;
          targetGroup = gid;
        }
      }
    }
    if (!targetGroup) return null;

    // 组内按 clientY 中点找位置
    const targetEl = groupEls.get(targetGroup);
    if (!targetEl) return { groupId: targetGroup, index: 0 };

    const cards = Array.from(
      targetEl.querySelectorAll<HTMLElement>("[data-task-id]"),
    ).filter((c) => c.getAttribute("data-task-id") !== draggingId.value);

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      if (clientY <= centerY) {
        return { groupId: targetGroup, index: i };
      }
    }
    return { groupId: targetGroup, index: cards.length };
  }

  /** drop */
  function onGroupDrop(e: DragEvent): void {
    if (!draggingId.value) return;
    e.preventDefault();
    void persistDragResult();
  }

  /** autoPersist 计时器 */
  let autoPersistTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutoPersist(): void {
    if (autoPersistTimer) clearTimeout(autoPersistTimer);
    autoPersistTimer = setTimeout(() => {
      autoPersistTimer = null;
      if (dragChanged) {
        void persistDragResult();
      }
    }, 500);
  }

  /** 持久化拖拽结果 */
  async function persistDragResult(): Promise<void> {
    if (persisting) return;
    const taskId = draggingId.value ?? lastDragTaskId;
    const fromGroup = draggingId.value ? lastDragFromGroup : lastDragFromGroup;

    if (!taskId || !fromGroup || !dragChanged) {
      isDragging = false;
      draggingId.value = null;
      return;
    }
    persisting = true;

    // 找任务当前在哪个组
    let toGroup: string | null = null;
    for (const gid of Object.keys(localGroups)) {
      if (localGroups[gid].includes(taskId)) {
        toGroup = gid;
        break;
      }
    }
    if (!toGroup) {
      isDragging = false;
      draggingId.value = null;
      persisting = false;
      return;
    }

    // 跨组：改 group_id
    if (toGroup !== fromGroup) {
      await taskStore.updateTask(taskId, { groupId: toGroup });
    }

    // 全局重排 sortOrder（所有组的 id 拼成全局列表）
    const allIds: string[] = [];
    for (const gid of getGroupIds()) {
      allIds.push(...(localGroups[gid] ?? []));
    }
    await taskStore.persistTaskOrder(allIds);

    isDragging = false;
    draggingId.value = null;
    dragChanged = false;
    persisting = false;
  }

  /** dragend 兜底 */
  async function onTaskDragEnd(): Promise<void> {
    if (!draggingId.value) return;
    await persistDragResult();
  }

  return {
    /** 每组的本地顺序 */
    localGroups,
    /** 正在被拖动的任务 id */
    draggingId,
    /** 同步 store 数据（非拖拽期间调用） */
    syncFromStore,
    /** dragstart 处理器 */
    onTaskDragStart,
    /** 组容器 dragover 处理器 */
    onGroupDragOver,
    /** drop 处理器 */
    onGroupDrop,
    /** dragend 处理器 */
    onTaskDragEnd,
  };
}
