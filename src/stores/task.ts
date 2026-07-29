// 任务 store —— 管理任务的 CRUD 与完成状态
// 子任务独立加载（不依赖 currentTasks，避免智能视图查不到子任务）

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { Task, Priority, SortField, SortDir, ChecklistItem, Attachment } from "@/types";
import { categorizeAttachmentType } from "@/types";
import * as db from "@/api/db";
import type { SmartViewId, Tag } from "@/api/db";
import { useSettingsStore } from "@/stores/settings";
import { todayRange, clampDateRange } from "@/utils/date";
import { notifyTaskChanged } from "@/composables/useCalendarView";

export const useTaskStore = defineStore("task", () => {
  // 在 setup 顶层获取 settings store，确保一定拿到 active pinia。
  // 跨 store 引用写在 setup 函数体内是 Pinia 官方推荐做法，
  // 这样在 createTask 等 action 闭包里复用 settings，不依赖调用时机的 active instance。
  const settings = useSettingsStore();
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

  /** 任务标签缓存：taskId → Tag[]，供任务列表项显示标签。
   *  由 preloadTaskTags（列表加载时批量预取）和 refreshTaskTags（详情面板编辑后精确刷新）维护。 */
  const taskTagMap = ref<Record<string, Tag[]>>({});

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

  /** 批量预加载当前视图所有根任务的标签到 taskTagMap（一条 SQL，用于任务项显示标签） */
  async function preloadTaskTags(): Promise<void> {
    const ids = currentTasks.value.map((t) => t.id);
    if (ids.length === 0) {
      taskTagMap.value = {};
      return;
    }
    try {
      const links = await db.getTaskTagsBatch(ids);
      // 把扁平的 TaskTagLink 数组按 task_id 分组成 taskId → Tag[]
      const map: Record<string, Tag[]> = {};
      // 先给所有任务初始化空数组，确保无标签的任务也有缓存条目（UI 判定 hasTag 时一致）
      for (const id of ids) map[id] = [];
      for (const link of links) {
        const tag: Tag = {
          id: link.tag_id,
          name: link.tag_name,
          createdAt: link.tag_created_at,
          position: link.tag_position,
        };
        if (!map[link.task_id]) map[link.task_id] = [];
        map[link.task_id].push(tag);
      }
      taskTagMap.value = map;
    } catch (e) {
      console.error("[TaskStore] 批量预加载任务标签失败:", e);
      // 失败时初始化为空，避免 UI 显示陈旧数据
      const map: Record<string, Tag[]> = {};
      for (const id of ids) map[id] = [];
      taskTagMap.value = map;
    }
  }

  /** 精确刷新单个任务的标签缓存（详情面板增删标签后调用） */
  async function refreshTaskTags(taskId: string): Promise<void> {
    try {
      const tags = await db.getTaskTags(taskId);
      taskTagMap.value = { ...taskTagMap.value, [taskId]: tags };
    } catch (e) {
      console.error("[TaskStore] 刷新任务标签失败:", e);
    }
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
      await preloadTaskTags();
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
      await preloadTaskTags();
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
      await preloadTaskTags();
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
      settings.newTasksDueToday
    ) {
      [dueStartAt, dueEndAt] = todayRange();
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
    // 新建任务默认无标签，补一个空数组到缓存，保持 taskTagMap 与 currentTasks 同步
    taskTagMap.value = { ...taskTagMap.value, [task.id]: [] };
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

  // ─── 附件操作（独立于 note 富文本）────────────────────
  // 附件元信息存 tasks.attachments（JSON 数组），文件实体存附件目录。
  // 添加流程：前端读 File → base64 → db.saveAttachment 落盘 → 追加到 attachments 数组 → updateTask
  // 删除流程：从数组移除 → updateTask → db.deleteAttachment 清理磁盘文件

  /** 把 File 转为 base64 字符串（不含 data: 前缀） */
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // readAsDataURL 返回 "data:<mime>;base64,<data>"，去掉前缀
        const commaIdx = result.indexOf(",");
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** 生成附件 ID（UUID v4，与文件名中的 UUID 一致） */
  function generateAttachmentId(): string {
    // 优先用 crypto.randomUUID（Tauri webview 支持）
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // 兜底：基于时间戳 + 随机数
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 当前本地时间字面量（"YYYY-MM-DDTHH:mm:ss"，与任务 createdAt 同格式） */
  function nowLocalIso(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * 为任务添加附件（文件实体落盘 + 元信息入库）
   * @returns 新增的 Attachment（含 storedName），调用方可用于 UI 反馈
   */
  async function addAttachment(taskId: string, file: File): Promise<Attachment> {
    // 扩展名小写化（无扩展名则空串，Rust 端会用 bin 兜底）
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    // 磁盘分类（决定落盘子目录，Rust 白名单校验）
    const category = categorizeAttachmentType(file.name);
    const base64 = await fileToBase64(file);
    const storedName = await db.saveAttachment(base64, ext, category);

    const attachment: Attachment = {
      id: generateAttachmentId(),
      originalName: file.name,
      storedName,
      mime: file.type || "application/octet-stream",
      size: file.size,
      createdAt: nowLocalIso(),
    };

    const task = findTaskById(taskId);
    const next = [...(task?.attachments ?? []), attachment];
    await updateTask(taskId, { attachments: next });
    return attachment;
  }

  /** 批量添加附件（逐个落盘，避免并发 IPC 冲突） */
  async function addAttachments(taskId: string, files: File[]): Promise<Attachment[]> {
    const added: Attachment[] = [];
    for (const file of files) {
      const att = await addAttachment(taskId, file);
      added.push(att);
    }
    return added;
  }

  /** 删除附件（从数组移除 + 清理磁盘文件） */
  async function removeAttachment(taskId: string, attachmentId: string): Promise<void> {
    const task = findTaskById(taskId);
    if (!task) return;
    const target = task.attachments.find((a) => a.id === attachmentId);
    if (!target) return;

    const next = task.attachments.filter((a) => a.id !== attachmentId);
    await updateTask(taskId, { attachments: next });
    // 元信息删除成功后再清理磁盘文件（失败不阻断 UI，仅记日志）
    try {
      await db.deleteAttachment(target.storedName);
    } catch (e) {
      console.warn("[task] 清理附件磁盘文件失败:", e);
    }
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
    // 清除该任务的标签缓存
    const newTagMap = { ...taskTagMap.value };
    delete newTagMap[id];
    taskTagMap.value = newTagMap;
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
    // 新建子任务默认无标签，补空数组到缓存
    taskTagMap.value = { ...taskTagMap.value, [sub.id]: [] };
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

  /**
   * 按指定 id 顺序持久化未完成任务的排序（拖拽 FLIP 实时让位的终态持久化）。
   *
   * 与 reorderTasks 的区别：
   * - reorderTasks 接收 draggedId/targetId/position，内部计算新顺序（旧流程，drop 触发）
   * - persistTaskOrder 接收最终 id 顺序，直接按此顺序重排（新流程，dragover 实时让位 + dragend 持久化）
   *
   * 流程：
   * 1. 按 orderedIds 重排 currentTasks 中的未完成任务（已完成任务保持原位）
   * 2. 重算 sort_order（间隔 1000）
   * 3. 写库
   *
   * @param orderedIds 未完成任务的最终顺序（id 数组）
   * @returns 持久化是否成功（失败时调用方负责回滚 localOrder）
   */
  async function persistTaskOrder(orderedIds: string[]): Promise<boolean> {
    const idToTask = new Map(currentTasks.value.map((t) => [t.id, t]));
    // 按 orderedIds 重排未完成项；已完成项追加在末尾保持原相对顺序
    const reorderedOpen: Task[] = [];
    for (const id of orderedIds) {
      const t = idToTask.get(id);
      if (t && !t.done) reorderedOpen.push(t);
    }
    const doneTasks = currentTasks.value.filter((t) => t.done);

    // 重算 sort_order（间隔 1000）
    const updates: [string, number][] = reorderedOpen.map((t, i) => [t.id, i * 1000]);
    for (const [id, sortOrder] of updates) {
      const task = idToTask.get(id);
      if (task) task.sortOrder = sortOrder;
    }
    currentTasks.value = [...reorderedOpen, ...doneTasks];

    try {
      await db.reorderTasks(updates);
      return true;
    } catch (e) {
      console.error("[TaskStore] 排序持久化失败:", e);
      return false;
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
    taskTagMap,
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
    persistTaskOrder,
    selectTask,
    loadSubtasks,
    loadSubtasksToCache,
    getCachedSubtasks,
    getSubtasks,
    refreshTaskTags,
    // 检查项操作
    addChecklistItem,
    insertChecklistItemAfter,
    updateChecklistItem,
    toggleChecklistItem,
    removeChecklistItem,
    reorderChecklist,
    addAttachment,
    addAttachments,
    removeAttachment,
  };
});
