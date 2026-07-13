// 任务 store —— 管理任务的 CRUD 与完成状态
// 子任务独立加载（不依赖 currentTasks，避免智能视图查不到子任务）

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { Task, Priority, SortField, SortDir } from "@/types";
import * as db from "@/api/db";
import type { SmartViewId } from "@/api/db";

export const useTaskStore = defineStore("task", () => {
  const currentListId = ref<string>("inbox");
  const currentTagId = ref<string | null>(null);
  const currentSmartView = ref<SmartViewId | null>(null);

  const currentTasks = ref<Task[]>([]);
  const loading = ref(false);

  /** 当前视图的排序偏好 */
  const currentSort = ref<{ field: SortField; dir: SortDir }>({
    field: "manual",
    dir: "asc",
  });

  const selectedTaskId = ref<string | null>(null);
  /** 当前选中任务对象（独立 ref，不再依赖 subtasks/currentTasks） */
  const selectedTaskObj = ref<Task | null>(null);
  /** 当前选中任务的子任务（独立加载） */
  const subtasks = ref<Task[]>([]);
  /** 子任务缓存：parentId → Task[]，供树形列表按需懒加载子任务 */
  const subtaskCache = ref<Record<string, Task[]>>({});

  /** 侧边栏任务数量（清单 + 标签 + 智能视图） */
  const listCounts = ref<Record<string, number>>({});
  const tagCounts = ref<Record<string, number>>({});
  const smartCounts = ref<Record<string, number>>({});

  /** 刷新侧边栏任务数量 */
  async function refreshCounts() {
    try {
      const [listC, tagC, today, upcoming, all] = await Promise.all([
        db.getCountsByList(),
        db.getCountsByTag(),
        db.getSmartViewCount("today"),
        db.getSmartViewCount("upcoming"),
        db.getSmartViewCount("all"),
      ]);
      listCounts.value = listC;
      tagCounts.value = tagC;
      smartCounts.value = { today, upcoming, all };
    } catch {
      // 静默失败
    }
  }

  const openTasks = computed(() =>
    currentTasks.value.filter((t) => !t.done),
  );

  const doneTasks = computed(() =>
    currentTasks.value.filter((t) => t.done),
  );

  /** 选中任务对象 */
  const selectedTask = computed(() => selectedTaskObj.value);

  /** 详情面板是否展开 */
  const detailOpen = computed(() => selectedTaskId.value !== null);

  /** 预加载所有根任务的子任务计数到缓存（用于列表初始判断有无子任务） */
  async function preloadSubtaskCounts() {
    const newCache: Record<string, Task[]> = {};
    await Promise.all(
      currentTasks.value.map(async (t) => {
        try {
          newCache[t.id] = await db.getSubtasks(t.id);
        } catch {
          newCache[t.id] = [];
        }
      }),
    );
    subtaskCache.value = { ...subtaskCache.value, ...newCache };
  }

  async function loadTasks(listId: string, keepSelection = false) {
    loading.value = true;
    currentListId.value = listId;
    currentTagId.value = null;
    currentSmartView.value = null;
    if (!keepSelection) {
      selectedTaskId.value = null; selectedTaskObj.value = null; // 切换清单时关闭详情面板
    }
    try {
      currentTasks.value = await db.getTasksByList(
        listId,
        currentSort.value.field,
        currentSort.value.dir,
      );
      await preloadSubtaskCounts();
    } finally {
      loading.value = false;
    }
  }

  /** 加载指定标签下的任务（根任务） */
  async function loadTagTasks(tagId: string, keepSelection = false) {
    loading.value = true;
    currentListId.value = "";
    currentTagId.value = tagId;
    currentSmartView.value = null;
    if (!keepSelection) {
      selectedTaskId.value = null; selectedTaskObj.value = null; // 切换标签时关闭详情面板
    }
    try {
      currentTasks.value = await db.getTasksByTag(
        tagId,
        currentSort.value.field,
        currentSort.value.dir,
      );
      await preloadSubtaskCounts();
    } finally {
      loading.value = false;
    }
  }

  async function loadSmartView(view: SmartViewId, keepSelection = false) {
    loading.value = true;
    currentSmartView.value = view;
    currentListId.value = "";
    currentTagId.value = null;
    if (!keepSelection) {
      selectedTaskId.value = null; selectedTaskObj.value = null; // 切换智能视图时关闭详情面板
    }
    try {
      currentTasks.value = await db.getSmartViewTasks(
        view,
        currentSort.value.field,
        currentSort.value.dir,
      );
      await preloadSubtaskCounts();
    } finally {
      loading.value = false;
    }
  }

  /** 重新加载当前视图（保持视图类型不变） */
  async function reload(keepSelection = false) {
    if (currentSmartView.value) {
      await loadSmartView(currentSmartView.value, keepSelection);
    } else if (currentListId.value) {
      await loadTasks(currentListId.value, keepSelection);
    } else if (currentTagId.value) {
      await loadTagTasks(currentTagId.value, keepSelection);
    }
  }

  async function createTask(params: {
    title: string;
    listId: string;
    parentId?: string | null;
    priority?: Priority;
    dueStartAt?: string | null;
    dueEndAt?: string | null;
  }) {
    const task = await db.createTask(params);
    if (!params.parentId) {
      currentTasks.value.push(task);
    } else {
      subtasks.value.push(task);
    }
    refreshCounts();
    return task;
  }

  /** 在单个数组中更新任务属性，返回新数组引用以触发响应式 */
  function updateTaskInArray(arr: Task[], id: string, mutate: (t: Task) => void): Task[] {
    let changed = false;
    const newArr = arr.map((t) => {
      if (t.id === id) {
        changed = true;
        const clone = { ...t };
        mutate(clone);
        return clone;
      }
      return t;
    });
    return changed ? newArr : arr;
  }

  async function toggleTask(id: string, done: boolean) {
    await db.toggleTask(id, done);
    const completedAt = done ? new Date().toISOString() : null;
    // 更新 currentTasks
    currentTasks.value = updateTaskInArray(currentTasks.value, id, (t) => {
      t.done = done;
      t.completedAt = completedAt;
    });
    // 更新 subtasks
    subtasks.value = updateTaskInArray(subtasks.value, id, (t) => {
      t.done = done;
      t.completedAt = completedAt;
    });
    // 更新 subtaskCache 的每个数组
    const newCache: Record<string, Task[]> = {};
    for (const [pid, arr] of Object.entries(subtaskCache.value)) {
      newCache[pid] = updateTaskInArray(arr, id, (t) => {
        t.done = done;
        t.completedAt = completedAt;
      });
    }
    subtaskCache.value = newCache;
    // 同步 selectedTaskObj
    if (selectedTaskObj.value?.id === id) {
      selectedTaskObj.value = { ...selectedTaskObj.value, done, completedAt };
    }
    refreshCounts();
  }

  async function updateTask(
    id: string,
    fields: Parameters<typeof db.updateTask>[1],
  ) {
    await db.updateTask(id, fields);
    const updatedAt = new Date().toISOString();
    // 同步 selectedTaskObj
    if (selectedTaskObj.value?.id === id) {
      selectedTaskObj.value = { ...selectedTaskObj.value, ...fields, updatedAt };
    }
    currentTasks.value = updateTaskInArray(currentTasks.value, id, (t) => {
      Object.assign(t, fields);
      t.updatedAt = updatedAt;
    });
    subtasks.value = updateTaskInArray(subtasks.value, id, (t) => {
      Object.assign(t, fields);
      t.updatedAt = updatedAt;
    });
    const newCache: Record<string, Task[]> = {};
    for (const [pid, arr] of Object.entries(subtaskCache.value)) {
      newCache[pid] = updateTaskInArray(arr, id, (t) => {
        Object.assign(t, fields);
        t.updatedAt = updatedAt;
      });
    }
    subtaskCache.value = newCache;
    refreshCounts();
  }

  async function deleteTask(id: string) {
    await db.deleteTask(id);
    currentTasks.value = currentTasks.value.filter((t) => t.id !== id);
    subtasks.value = subtasks.value.filter((t) => t.id !== id);
    // 从缓存中移除该任务（作为某父任务的子任务）
    for (const pid of Object.keys(subtaskCache.value)) {
      subtaskCache.value[pid] = subtaskCache.value[pid].filter((t) => t.id !== id);
    }
    // 清除该任务自身的子任务缓存
    delete subtaskCache.value[id];
    if (selectedTaskId.value === id) {
      selectedTaskId.value = null;
    }
    refreshCounts();
  }

  /** 点击任务：切换选中（已选中则关闭面板） */
  async function selectTask(id: string | null) {
    if (id === null || selectedTaskId.value === id) {
      selectedTaskId.value = null;
      selectedTaskObj.value = null;
      return;
    }
    selectedTaskId.value = id;
    // 从所有数据源查找任务对象
    let task =
      currentTasks.value.find((t) => t.id === id) ??
      subtasks.value.find((t) => t.id === id) ??
      Object.values(subtaskCache.value).flat().find((t) => t.id === id) ??
      null;
    // 如果内存中找不到，从数据库加载
    if (!task) {
      task = await db.getTaskById(id);
    }
    selectedTaskObj.value = task;
    await loadSubtasks(id);
  }

  /** 加载某任务的子任务 */
  async function loadSubtasks(parentId: string) {
    try {
      subtasks.value = await db.getSubtasks(parentId);
    } catch {
      subtasks.value = [];
    }
  }

  /** 加载子任务到缓存（供树形列表按需懒加载） */
  async function loadSubtasksToCache(parentId: string) {
    try {
      const subs = await db.getSubtasks(parentId);
      subtaskCache.value = { ...subtaskCache.value, [parentId]: subs };
    } catch {
      subtaskCache.value = { ...subtaskCache.value, [parentId]: [] };
    }
  }

  /** 从缓存获取子任务 */
  function getCachedSubtasks(parentId: string): Task[] {
    return subtaskCache.value[parentId] ?? [];
  }

  /** 创建子任务 */
  async function createSubtask(parentTask: Task, title: string) {
    const sub = await db.createTask({
      title,
      listId: parentTask.listId,
      parentId: parentTask.id,
    });
    subtasks.value = [...subtasks.value, sub];
    // 同步更新缓存（无论是否已加载过，都确保缓存有最新数据）
    subtaskCache.value = {
      ...subtaskCache.value,
      [parentTask.id]: [...(subtaskCache.value[parentTask.id] ?? []), sub],
    };
    return sub;
  }

  function getSubtasks(parentId: string): Task[] {
    // 优先返回独立加载的子任务，否则从 currentTasks 过滤
    if (selectedTaskId.value === parentId) {
      return subtasks.value;
    }
    return currentTasks.value.filter((t) => t.parentId === parentId);
  }

  /** 切换当前视图的排序字段，并重新加载任务（保持详情面板打开） */
  async function setSort(field: SortField) {
    if (currentSort.value.field === field) return;
    currentSort.value = { field, dir: "asc" };
    // 持久化（清单/标签视图）
    try {
      if (currentListId.value) {
        await db.setListSortPref(currentListId.value, field, "asc");
      } else if (currentTagId.value) {
        await db.setTagSortPref(currentTagId.value, field, "asc");
      }
    } catch (e) {
      console.error("[TaskStore] 持久化排序偏好失败:", e);
    }
    // keepSelection=true：排序时不关闭详情面板
    await reload(true);
  }

  /** 拖拽排序：将 draggedId 移到 targetId 的前面或后面 */
  async function reorderTasks(draggedId: string, targetId: string, position: "before" | "after") {
    // 只操作未完成的根任务
    const open = openTasks.value;
    const dragged = open.find((t) => t.id === draggedId);
    const target = open.find((t) => t.id === targetId);
    if (!dragged || !target) return;

    // 在 currentTasks 中移动 dragged 到新位置
    const allTasks = [...currentTasks.value];
    const draggedIdx = allTasks.findIndex((t) => t.id === draggedId);
    const targetIdx = allTasks.findIndex((t) => t.id === targetId);
    if (draggedIdx === -1 || targetIdx === -1) return;

    // 移除被拖拽的任务
    const [moved] = allTasks.splice(draggedIdx, 1);
    // 重新找目标索引（移除后可能变了）
    const newTargetIdx = allTasks.findIndex((t) => t.id === targetId);
    const insertIdx = position === "before" ? newTargetIdx : newTargetIdx + 1;
    allTasks.splice(insertIdx, 0, moved);

    // 计算新的 sort_order（按 openTasks 在新顺序中的位置赋值，间隔 1000）
    const newOpenOrder = allTasks.filter((t) => !t.done);
    const updates: [string, number][] = newOpenOrder.map((t, i) => [t.id, i * 1000]);

    // 本地更新 sortOrder
    for (const [id, sortOrder] of updates) {
      const task = allTasks.find((t) => t.id === id);
      if (task) task.sortOrder = sortOrder;
    }
    currentTasks.value = allTasks;

    // 持久化
    try {
      await db.reorderTasks(updates);
    } catch (e) {
      console.error("[TaskStore] 排序失败:", e);
    }
  }

  return {
    currentListId,
    currentTagId,
    currentSmartView,
    currentTasks,
    currentSort,
    subtasks,
    subtaskCache,
    loading,
    selectedTaskId,
    openTasks,
    doneTasks,
    selectedTask,
    detailOpen,
    listCounts,
    tagCounts,
    smartCounts,
    refreshCounts,
    loadTasks,
    loadSmartView,
    loadTagTasks,
    reload,
    setSort,
    createTask,
    createSubtask,
    toggleTask,
    updateTask,
    deleteTask,
    reorderTasks,
    selectTask,
    loadSubtasks,
    loadSubtasksToCache,
    getCachedSubtasks,
    getSubtasks,
  };
});
