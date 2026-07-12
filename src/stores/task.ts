// 任务 store —— 管理任务的 CRUD 与完成状态
// 子任务独立加载（不依赖 currentTasks，避免智能视图查不到子任务）

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { Task, Priority } from "@/types";
import * as db from "@/api/db";
import type { SmartViewId } from "@/api/db";

export const useTaskStore = defineStore("task", () => {
  const currentListId = ref<string>("inbox");
  const currentSmartView = ref<SmartViewId | null>(null);

  const currentTasks = ref<Task[]>([]);
  const loading = ref(false);

  const selectedTaskId = ref<string | null>(null);
  /** 当前选中任务对象（独立 ref，不再依赖 subtasks/currentTasks） */
  const selectedTaskObj = ref<Task | null>(null);
  /** 当前选中任务的子任务（独立加载） */
  const subtasks = ref<Task[]>([]);
  /** 子任务缓存：parentId → Task[]，供树形列表按需懒加载子任务 */
  const subtaskCache = ref<Record<string, Task[]>>({});

  /** 侧边栏任务数量（清单 + 智能视图） */
  const listCounts = ref<Record<string, number>>({});
  const smartCounts = ref<Record<string, number>>({});

  /** 刷新侧边栏任务数量 */
  async function refreshCounts() {
    try {
      listCounts.value = await db.getCountsByList();
      const [today, upcoming, all] = await Promise.all([
        db.getSmartViewCount("today"),
        db.getSmartViewCount("upcoming"),
        db.getSmartViewCount("all"),
      ]);
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

  async function loadTasks(listId: string) {
    loading.value = true;
    currentListId.value = listId;
    currentSmartView.value = null;
    selectedTaskId.value = null; selectedTaskObj.value = null; // 切换清单时关闭详情面板
    try {
      currentTasks.value = await db.getTasksByList(listId);
      await preloadSubtaskCounts();
    } finally {
      loading.value = false;
    }
  }

  /** 加载指定标签下的任务（根任务） */
  async function loadTagTasks(tagId: string) {
    loading.value = true;
    currentListId.value = "";
    currentSmartView.value = null;
    selectedTaskId.value = null; selectedTaskObj.value = null; // 切换标签时关闭详情面板
    try {
      currentTasks.value = await db.getTasksByTag(tagId);
      await preloadSubtaskCounts();
    } finally {
      loading.value = false;
    }
  }

  async function loadSmartView(view: SmartViewId) {
    loading.value = true;
    currentSmartView.value = view;
    currentListId.value = "";
    selectedTaskId.value = null; selectedTaskObj.value = null; // 切换智能视图时关闭详情面板
    try {
      currentTasks.value = await db.getSmartViewTasks(view);
      await preloadSubtaskCounts();
    } finally {
      loading.value = false;
    }
  }

  /** 重新加载当前视图（保持视图类型不变） */
  async function reload() {
    if (currentSmartView.value) {
      await loadSmartView(currentSmartView.value);
    } else if (currentListId.value) {
      await loadTasks(currentListId.value);
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

  return {
    currentListId,
    currentSmartView,
    currentTasks,
    subtasks,
    subtaskCache,
    loading,
    selectedTaskId,
    openTasks,
    doneTasks,
    selectedTask,
    detailOpen,
    listCounts,
    smartCounts,
    refreshCounts,
    loadTasks,
    loadSmartView,
    loadTagTasks,
    reload,
    createTask,
    createSubtask,
    toggleTask,
    updateTask,
    deleteTask,
    selectTask,
    loadSubtasks,
    loadSubtasksToCache,
    getCachedSubtasks,
    getSubtasks,
  };
});
