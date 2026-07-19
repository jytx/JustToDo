// 任务 store —— 管理任务的 CRUD 与完成状态
// 子任务独立加载（不依赖 currentTasks，避免智能视图查不到子任务）

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { Task, Priority, SortField, SortDir, ChecklistItem } from "@/types";
import * as db from "@/api/db";
import type { SmartViewId } from "@/api/db";
import { useSettingsStore } from "@/stores/settings";
import { nowLocalIso, clampDateRange } from "@/utils/date";
import { notifyTaskChanged } from "@/composables/useCalendarView";

/**
 * 在非 setup 上下文（如 createTask 的内部调用）安全获取 settings store。
 * Pinia 在 store 内部嵌套调用 useStore 是允许的，但若尚未初始化则返回 null，
 * 此时跳过自动今天兜底（使用调用方传入的原始参数）。
 */
function useSettingsMaybe() {
  try {
    return useSettingsStore();
  } catch {
    return null;
  }
}

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

  /** 键盘导航焦点任务 ID（与 selectedTaskId 解耦，仅视觉高亮，不打开详情面板） */
  const focusedTaskId = ref<string | null>(null);

  /** 待删除任务的 ID（用于确认对话框） */
  const pendingDeleteId = ref<string | null>(null);

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
    focusedTaskId.value = null; // 切换视图时清空键盘焦点
    if (!keepSelection) {
      selectedTaskId.value = null; selectedTaskObj.value = null; // 切换清单时关闭详情面板
    }
    try {
      // 先从 DB 同步该清单的排序偏好（避免 currentSort 与后端不一致）
      try {
        const [f, d] = await db.getListSortPref(listId);
        currentSort.value = { field: f as SortField, dir: d as SortDir };
      } catch {
        // 查询失败用默认值
      }
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
    focusedTaskId.value = null; // 切换视图时清空键盘焦点
    if (!keepSelection) {
      selectedTaskId.value = null; selectedTaskObj.value = null; // 切换标签时关闭详情面板
    }
    try {
      // 先从 DB 同步该标签的排序偏好
      try {
        const [f, d] = await db.getTagSortPref(tagId);
        currentSort.value = { field: f as SortField, dir: d as SortDir };
      } catch {
        // 查询失败用默认值
      }
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
    focusedTaskId.value = null; // 切换视图时清空键盘焦点
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
    // 检查并迁移旧 taskList 数据（一次性）
    void migrateOldTaskListsInNote();
  }

  // 标记是否跑过迁移（避免重复）
  const migrationDone = ref(false);

  /**
   * 一次性迁移：旧版本 Tiptap 编辑器把检查项存进 task.note 的 taskList 节点。
   * 新版用独立 task.checklist 字段。启动时扫一次：
   * 1) note 里的 <ul data-type="taskList"><li data-checked>...<p>title</p>...</li></ul>
   * 2) 把每个 li 转为 ChecklistItem 追加进 task.checklist
   * 3) 从 note 中删除 taskList 节点
   * 4) 写回 DB（只在该任务的 checklist 实际有变化时）
   */
  async function migrateOldTaskListsInNote() {
    if (migrationDone.value) return;
    migrationDone.value = true;
    // 收集所有任务（跨当前列表/视图合并）
    const all = collectAllLoadedTasks();
    for (const t of all) {
      const extracted = extractTaskListsFromNote(t.note);
      if (extracted.items.length === 0) continue;
      const merged = mergeChecklist(t.checklist, extracted.items);
      const cleanedNote = extracted.cleaned;
      try {
        await db.updateTask(t.id, { checklist: merged, note: cleanedNote });
      } catch (e) {
        console.warn("[migrate] 任务", t.id, "迁移失败:", e);
      }
    }
  }

  /** 收集所有 store 里已加载的 task（去重） */
  function collectAllLoadedTasks(): Task[] {
    const seen = new Set<string>();
    const out: Task[] = [];
    const push = (t: Task) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      out.push(t);
    };
    currentTasks.value.forEach(push);
    subtasks.value.forEach(push);
    for (const arr of Object.values(subtaskCache.value)) arr.forEach(push);
    return out;
  }

  /** 把 checklist 数组按 id 去重合并（新提取的优先） */
  function mergeChecklist(existing: ChecklistItem[], extracted: ChecklistItem[]): ChecklistItem[] {
    const map = new Map<string, ChecklistItem>();
    for (const it of existing) map.set(it.id, it);
    for (const it of extracted) {
      if (!map.has(it.id)) map.set(it.id, it);
    }
    return Array.from(map.values()).sort((a, b) => a.order - b.order);
  }

  /**
   * 从 task.note HTML 提取 taskList 节点，转换为 ChecklistItem 数组
   * 同时返回清理后的 note（移除 taskList 节点）
   * 解析失败则返回空 items 和原 note
   */
  function extractTaskListsFromNote(html: string): {
    items: ChecklistItem[];
    cleaned: string;
  } {
    if (!html || !html.includes("taskList")) return { items: [], cleaned: html };
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const taskLists = doc.querySelectorAll('ul[data-type="taskList"]');
      if (taskLists.length === 0) return { items: [], cleaned: html };
      const items: ChecklistItem[] = [];
      let orderBase = 1000;
      for (const ul of Array.from(taskLists)) {
        const lis = ul.querySelectorAll(':scope > li');
        for (const li of Array.from(lis)) {
          const title = (li.textContent || "").trim() || "未命名";
          const checked = li.getAttribute("data-checked") === "true";
          items.push({
            id: crypto.randomUUID(),
            title,
            done: checked,
            order: orderBase++,
          });
        }
        ul.remove();
      }
      return { items, cleaned: doc.body.innerHTML };
    } catch {
      return { items: [], cleaned: html };
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
    // 自动今天兜底：
    // - 开关开启
    // - 顶层任务（非子任务）
    // - 调用方未提供任何日期（两个字段都为 null/undefined）
    // 满足全部条件时，把 dueStartAt/dueEndAt 都填为本地"今天 00:00" ~ "今天 23:59:59"。
    // 注意：父任务的子任务不参与此逻辑，避免无意中改变子任务语义。
    let { dueStartAt, dueEndAt } = params;
    if (
      !params.parentId &&
      dueStartAt == null &&
      dueEndAt == null &&
      useSettingsMaybe()?.newTasksDueToday
    ) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 0);
      // 本地字面量，无时区标记，与 picker 路径保持一致
      dueStartAt = nowLocalIso(start);
      dueEndAt = nowLocalIso(end);
    }
    // 钳制：保证 end 不早于 start。倒挂数据会让 FullCalendar 丢弃 end，
    // 导致日历事件无 end、拖拽失效、显示异常。
    [dueStartAt, dueEndAt] = clampDateRange(dueStartAt, dueEndAt);
    const task = await db.createTask({ ...params, dueStartAt, dueEndAt });
    if (!params.parentId) {
      currentTasks.value.push(task);
    } else {
      subtasks.value.push(task);
    }
    refreshCounts();
    // 通知日历视图刷新（create 不区分是否带日期，全通知；视图自己按当前 range 决定是否可见）
    notifyTaskChanged();
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
      // 任务被完成时关闭详情面板（保持未完成可继续编辑）
      if (done) {
        selectedTaskId.value = null;
        selectedTaskObj.value = null;
      } else {
        selectedTaskObj.value = { ...selectedTaskObj.value, done, completedAt };
      }
    }
    refreshCounts();
    notifyTaskChanged();
  }

  async function updateTask(
    id: string,
    fields: Parameters<typeof db.updateTask>[1],
  ) {
    // 钳制 end >= start：updateTask 是字段级更新，可能只传 start 或只传 end，
    // 需结合任务当前值做联合校验。
    const existing = findTaskById(id);
    const startCandidate =
      fields.dueStartAt !== undefined ? fields.dueStartAt : (existing?.dueStartAt ?? null);
    const endCandidate =
      fields.dueEndAt !== undefined ? fields.dueEndAt : (existing?.dueEndAt ?? null);
    const [clampedStart, clampedEnd] = clampDateRange(startCandidate, endCandidate);
    // 仅处理调用方显式传入的字段，避免误清空未传字段（undefined → null）
    const merged: typeof fields = { ...fields };
    if (fields.dueStartAt !== undefined) merged.dueStartAt = clampedStart;
    if (fields.dueEndAt !== undefined) merged.dueEndAt = clampedEnd;
    // 特殊情况：调用方只传了 start（没传 end），但 start 被钳制后需要同步拉高 end
    // （否则 DB 里旧 end 仍小于新 start）。此时补传 dueEndAt 固化钳制结果。
    if (
      fields.dueStartAt !== undefined &&
      fields.dueEndAt === undefined &&
      existing &&
      clampedEnd !== (existing.dueEndAt ?? null)
    ) {
      merged.dueEndAt = clampedEnd;
    }
    await db.updateTask(id, merged);
    const updatedAt = new Date().toISOString();
    // 同步本地状态（用 merged 而非 fields，确保钳制结果同步到 UI）
    if (selectedTaskObj.value?.id === id) {
      selectedTaskObj.value = { ...selectedTaskObj.value, ...merged, updatedAt };
    }
    currentTasks.value = updateTaskInArray(currentTasks.value, id, (t) => {
      Object.assign(t, merged);
      t.updatedAt = updatedAt;
    });
    subtasks.value = updateTaskInArray(subtasks.value, id, (t) => {
      Object.assign(t, merged);
      t.updatedAt = updatedAt;
    });
    const newCache: Record<string, Task[]> = {};
    for (const [pid, arr] of Object.entries(subtaskCache.value)) {
      newCache[pid] = updateTaskInArray(arr, id, (t) => {
        Object.assign(t, merged);
        t.updatedAt = updatedAt;
      });
    }
    subtaskCache.value = newCache;
    refreshCounts();
    notifyTaskChanged();
  }

  // ─── 检查项操作（独立于 note 富文本）────────────────────

  /** 给指定任务追加一个检查项 */
  async function addChecklistItem(taskId: string, title: string) {
    const task = findTaskById(taskId);
    if (!task) return;
    const maxOrder = task.checklist.reduce((m, it) => Math.max(m, it.order), -1);
    const newItem: ChecklistItem = {
      id: crypto.randomUUID(),
      title: title.trim(),
      done: false,
      order: maxOrder + 1,
    };
    const next = [...task.checklist, newItem];
    await updateTask(taskId, { checklist: next });
    return newItem.id;
  }

  /**
   * 在指定检查项之后插入一个新空项（用于"回车新建下一行"）。
   * order 策略：优先取前后相邻项的整数中点（step=10 留出空间，避免频繁重排）；
   * 当相邻项之间没有整数空位时（间距 ≤1），对整张表按 step=10 重新分配整数 order。
   * 返回新项 id，便于调用方聚焦输入框。
   * 注意：后端 ChecklistItem.order 是 i32，这里必须产出整数，否则 task_update 会被 serde 拒绝。
   */
  const CHECKLIST_ORDER_STEP = 10;

  /** 给一组检查项按当前顺序重新分配整数 order（0, 10, 20…），返回新数组 */
  function reassignChecklistOrders(items: ChecklistItem[]): ChecklistItem[] {
    return items.map((it, i) => ({ ...it, order: i * CHECKLIST_ORDER_STEP }));
  }

  async function insertChecklistItemAfter(
    taskId: string,
    afterItemId: string,
    title: string,
  ): Promise<string | null> {
    const task = findTaskById(taskId);
    if (!task) return null;
    const sorted = [...task.checklist].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((it) => it.id === afterItemId);
    if (idx === -1) return null;
    const prevOrder = sorted[idx].order;
    const nextNeighbor = sorted[idx + 1];
    const newItem: ChecklistItem = {
      id: crypto.randomUUID(),
      title: title.trim(),
      done: false,
      order: 0, // 占位，下面按情况赋值
    };
    // 把新项插入到正确位置
    const inserted = [...sorted.slice(0, idx + 1), newItem, ...sorted.slice(idx + 1)];
    let finalList: ChecklistItem[];
    if (!nextNeighbor) {
      // 末项后追加：直接取末项 order + step
      newItem.order = prevOrder + CHECKLIST_ORDER_STEP;
      finalList = inserted;
    } else {
      const gap = nextNeighbor.order - prevOrder;
      if (gap > 1) {
        // 有整数空位：取中点（向下取整）
        newItem.order = prevOrder + Math.floor(gap / 2);
        finalList = inserted;
      } else {
        // 间距耗尽：全表重排整数 order
        newItem.order = (idx + 1) * CHECKLIST_ORDER_STEP;
        finalList = reassignChecklistOrders(inserted);
      }
    }
    await updateTask(taskId, { checklist: finalList });
    return newItem.id;
  }

  /** 更新一个检查项的 title / done / order */
  async function updateChecklistItem(
    taskId: string,
    itemId: string,
    patch: Partial<{ title: string; done: boolean; order: number }>,
  ) {
    const task = findTaskById(taskId);
    if (!task) return;
    const next = task.checklist.map((it) =>
      it.id === itemId ? { ...it, ...patch } : it,
    );
    await updateTask(taskId, { checklist: next });
  }

  /** 切换检查项的完成状态 */
  async function toggleChecklistItem(taskId: string, itemId: string) {
    const task = findTaskById(taskId);
    if (!task) return;
    const item = task.checklist.find((it) => it.id === itemId);
    if (!item) return;
    await updateChecklistItem(taskId, itemId, { done: !item.done });
  }

  /** 删除一个检查项 */
  async function removeChecklistItem(taskId: string, itemId: string) {
    const task = findTaskById(taskId);
    if (!task) return;
    const next = task.checklist.filter((it) => it.id !== itemId);
    await updateTask(taskId, { checklist: next });
  }

  /** 拖拽重排 checklist：从 fromIndex 移到 toIndex
   *  —— 取现有 checklist 数组 → 数组 splice → 重新按 10 步长分配 order → 整体写库 */
  async function reorderChecklist(taskId: string, fromIndex: number, toIndex: number) {
    const task = findTaskById(taskId);
    if (!task) return;
    const list = [...task.checklist];
    if (fromIndex < 0 || fromIndex >= list.length) return;
    const clampedTo = Math.max(0, Math.min(toIndex, list.length));
    if (fromIndex === clampedTo) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(clampedTo, 0, moved);
    const reordered = reassignChecklistOrders(list);
    await updateTask(taskId, { checklist: reordered });
  }

  /** 在任务的所有数据副本中找 task（currentTasks / subtasks / subtaskCache / selectedTaskObj） */
  function findTaskById(id: string): Task | null {
    if (selectedTaskObj.value?.id === id) return selectedTaskObj.value;
    const fromCur = currentTasks.value.find((t) => t.id === id);
    if (fromCur) return fromCur;
    const fromSub = subtasks.value.find((t) => t.id === id);
    if (fromSub) return fromSub;
    for (const arr of Object.values(subtaskCache.value)) {
      const found = arr.find((t) => t.id === id);
      if (found) return found;
    }
    return null;
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
      selectedTaskObj.value = null; // 同步清空选中对象，关闭详情面板
    }
    refreshCounts();
    notifyTaskChanged();
  }

  /** 请求删除任务（弹出确认对话框） */
  function requestDelete(id: string) {
    pendingDeleteId.value = id;
  }

  /** 取消删除（关闭确认对话框） */
  function cancelDelete() {
    pendingDeleteId.value = null;
  }

  /** 确认删除（实际执行） */
  async function confirmDelete() {
    if (!pendingDeleteId.value) return;
    const id = pendingDeleteId.value;
    pendingDeleteId.value = null;
    // 焦点移到下一个任务（避免删除后焦点丢失）
    moveFocus("down");
    await deleteTask(id);
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

  /** 键盘导航：移动焦点到上/下一个未完成根任务 */
  function moveFocus(direction: "up" | "down") {
    const tasks = openTasks.value;
    if (tasks.length === 0) return;
    // 没有焦点时，down 从第一个开始，up 从最后一个开始
    if (!focusedTaskId.value) {
      focusedTaskId.value = direction === "down" ? tasks[0].id : tasks[tasks.length - 1].id;
      return;
    }
    const idx = tasks.findIndex((t) => t.id === focusedTaskId.value);
    if (idx === -1) {
      // 当前焦点不在列表里（可能被删除），从头开始
      focusedTaskId.value = tasks[0].id;
      return;
    }
    const newIdx =
      direction === "down" ? Math.min(idx + 1, tasks.length - 1) : Math.max(idx - 1, 0);
    focusedTaskId.value = tasks[newIdx].id;
  }

  /** 清空键盘焦点 */
  function clearFocus() {
    focusedTaskId.value = null;
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
    notifyTaskChanged();
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
    focusedTaskId,
    pendingDeleteId,
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
    moveFocus,
    clearFocus,
    createTask,
    createSubtask,
    toggleTask,
    updateTask,
    deleteTask,
    requestDelete,
    cancelDelete,
    confirmDelete,
    reorderTasks,
    selectTask,
    loadSubtasks,
    loadSubtasksToCache,
    getCachedSubtasks,
    getSubtasks,
    // 检查项操作
    addChecklistItem,
    insertChecklistItemAfter,
    updateChecklistItem,
    toggleChecklistItem,
    removeChecklistItem,
    reorderChecklist,
  };
});
