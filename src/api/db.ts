// 数据库访问层 —— 通过 invoke() 调用 Rust 命令
// 架构：所有数据库操作在 Rust 端用 sqlx 执行，前端通过 IPC 调用
// 这样绕过了 plugin-sql 前端 API 的 IPC 问题，走标准 invoke 通道

import { invoke } from "@tauri-apps/api/core";
import type { List, Task, Priority, RecurrenceFreq, ChecklistItem, Template, Attachment, AttachmentType, TaskKind, Group, RecurrenceHistoryEntry, UpcomingReminder, TrashItem } from "@/types";

// ─── 类型（与 Rust models.rs 对应）──────────────────────

export interface Tag {
  id: string;
  name: string;
  createdAt: string;
  /** 侧边栏手动排序 key（整数间隔；旧数据 = 0） */
  position: number;
  /** 标签颜色（十六进制，如 "#EF4444"；旧数据缺省为 "#EF4444"） */
  color: string;
}

/** 批量查询返回的任务-标签关联条目（与 Rust TaskTagLink 对应，snake_case） */
export interface TaskTagLink {
  task_id: string;
  tag_id: string;
  tag_name: string;
  tag_created_at: string;
  tag_position: number;
  tag_color: string;
}

interface TaskList {
  id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
  parent_id: string | null;
  is_folder: boolean;
  archived: number;
  /** 容器类型：'task' 清单/目录 | 'note' 笔记本/笔记本目录 */
  kind: TaskKind;
}

interface CreateTaskInput {
  title: string;
  listId: string;
  parentId?: string | null;
  priority?: Priority;
  dueStartAt?: string | null;
  dueEndAt?: string | null;
  recurrenceFreq?: RecurrenceFreq | null;
  recurrenceInterval?: number;
  recurrenceEndAt?: string | null;
  recurrenceCount?: number | null;
  remindOffsetMinutes?: number | null;
  /** 指定时刻提醒（与 remindOffsetMinutes 互斥；不传 = 未启用） */
  remindAt?: string | null;
  /** 实体类型：不传默认 'task'（待办）；'note' = 笔记 */
  kind?: TaskKind;
  /** 所属分组 ID（不传则用清单的默认分组） */
  groupId?: string;
}

interface UpdateTaskInput {
  title?: string;
  note?: string;
  priority?: Priority;
  dueStartAt?: string | null;
  dueEndAt?: string | null;
  listId?: string;
  /** 分组 ID（移动到分组时传） */
  groupId?: string | null;
  recurrenceFreq?: RecurrenceFreq | null;
  recurrenceInterval?: number;
  recurrenceEndAt?: string | null;
  recurrenceCount?: number | null;
  remindOffsetMinutes?: number | null;
  /** 指定时刻提醒（与 remindOffsetMinutes 互斥；null 清空） */
  remindAt?: string | null;
  /** 检查项列表（整组覆盖） */
  checklist?: ChecklistItem[];
  /** 附件列表（整组覆盖） */
  attachments?: Attachment[];
  /** 实体类型：不传则不更新。'task' 待办 / 'note' 笔记
   *  （用于「转换成笔记/任务」，转换时后端清空目标类型不用的字段） */
  kind?: TaskKind;
  /** 标题关联 URL（null 显式解除链接；不传不更新） */
  titleUrl?: string | null;
}

export type SmartViewId = "today" | "upcoming" | "all";

// ─── 清单操作 ────────────────────────────────────────────

export async function getLists(): Promise<List[]> {
  const rows = await invoke<TaskList[]>("list_get_all");
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    createdAt: r.created_at,
    parentId: r.parent_id,
    isFolder: r.is_folder,
    archived: !!r.archived,
    kind: r.kind,
  }));
}

export async function createList(params: {
  name: string;
  color: string;
  parentId?: string | null;
  isFolder?: boolean;
  /** 容器类型：不传默认 'task'（清单/目录）；'note' = 笔记本/笔记本目录 */
  kind?: TaskKind;
}): Promise<List> {
  const r = await invoke<TaskList>("list_create", {
    name: params.name,
    color: params.color,
    parentId: params.parentId ?? null,
    isFolder: params.isFolder ?? false,
    kind: params.kind ?? "task",
  });
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    createdAt: r.created_at,
    parentId: r.parent_id,
    isFolder: r.is_folder,
    archived: !!r.archived,
    kind: r.kind,
  };
}

export async function deleteList(id: string): Promise<void> {
  await invoke<void>("list_delete", { id });
}

export async function renameList(id: string, name: string, color: string): Promise<void> {
  await invoke<void>("list_rename", { id, name, color });
}

/** 仅修改清单/笔记本/目录颜色（不动名称；收件箱/默认笔记本也可用） */
export async function setListColor(id: string, color: string): Promise<void> {
  await invoke<void>("list_set_color", { id, color });
}

export async function moveList(id: string, parentId: string | null, position?: number): Promise<void> {
  await invoke<void>("list_move", { id, parentId, position: position ?? null });
}

/**
 * 归档整棵子树（自身 + 所有后代清单/子目录），隐藏到归档区
 * 任务本身不动（list_id 不变），仅随清单一起在首页隐藏
 */
export async function archiveListTree(id: string): Promise<void> {
  await invoke<void>("list_archive_tree", { id });
}

/**
 * 取消归档：后端自动顺带恢复祖先链上的已归档项，避免"父级仍归档、子项已恢复"的孤儿态
 * （详情见 Rust list_unarchive_tree 注释）
 */
export async function unarchiveListTree(id: string): Promise<void> {
  await invoke<void>("list_unarchive_tree", { id });
}

export async function reorderLists(items: [string, number][]): Promise<void> {
  await invoke<void>("list_reorder", { items });
}

// ─── 任务操作 ────────────────────────────────────────────

/** Rust 端返回的任务（snake_case） */
interface RustTask {
  id: string;
  title: string;
  note: string;
  list_id: string;
  parent_id: string | null;
  priority: number;
  due_start_at: string | null;
  due_end_at: string | null;
  done: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  recurrence_freq: string | null;
  recurrence_interval: number;
  recurrence_end_at: string | null;
  recurrence_count: number | null;
  recurrence_origin_id: string | null;
  recurrence_paused: number;
  remind_offset_minutes: number | null;
  remind_at: string | null;
  notified_at: string | null;
  checklist: ChecklistItem[];
  attachments: Attachment[];
  /** 实体类型：'task' 待办 | 'note' 笔记 */
  kind: TaskKind;
  group_id: string | null;
  title_url: string | null;
  /** 回收站软删除时间（null = 未删除） */
  deleted_at: string | null;
}

function mapTask(r: RustTask): Task {
  return {
    id: r.id,
    title: r.title,
    note: r.note,
    listId: r.list_id,
    parentId: r.parent_id,
    priority: r.priority as Priority,
    dueStartAt: r.due_start_at,
    dueEndAt: r.due_end_at,
    done: r.done,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    recurrenceFreq: r.recurrence_freq as Task["recurrenceFreq"],
    recurrenceInterval: r.recurrence_interval,
    recurrenceEndAt: r.recurrence_end_at,
    recurrenceCount: r.recurrence_count,
    recurrenceOriginId: r.recurrence_origin_id,
    recurrencePaused: !!r.recurrence_paused,
    remindOffsetMinutes: r.remind_offset_minutes,
    remindAt: r.remind_at,
    notifiedAt: r.notified_at,
    checklist: r.checklist,
    attachments: r.attachments,
    kind: r.kind,
    groupId: r.group_id,
    titleUrl: r.title_url,
    deletedAt: r.deleted_at,
  };
}

export async function getTasksByList(
  listId: string,
  sortField?: string,
  sortDir?: string,
): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("task_get_by_list", {
    listId,
    sortField,
    sortDir,
  });
  return rows.map(mapTask);
}

/** 设置清单的排序偏好（持久化到 SQLite） */
export async function setListSortPref(
  listId: string,
  sortField: string,
  sortDir: string,
): Promise<void> {
  await invoke("list_set_sort_pref", { listId, sortField, sortDir });
}

/** 查询清单的排序偏好 */
export async function getListSortPref(
  listId: string,
): Promise<[string, string]> {
  return invoke<[string, string]>("list_get_sort_pref", { listId });
}

/** 设置标签的排序偏好 */
export async function setTagSortPref(
  tagId: string,
  sortField: string,
  sortDir: string,
): Promise<void> {
  await invoke("tag_set_sort_pref", { tagId, sortField, sortDir });
}

/** 查询标签的排序偏好 */
export async function getTagSortPref(
  tagId: string,
): Promise<[string, string]> {
  return invoke<[string, string]>("tag_get_sort_pref", { tagId });
}

/** 统计各清单的未完成根任务数量 */
export async function getCountsByList(): Promise<Record<string, number>> {
  const rows = await invoke<[string, number][]>("task_count_by_list");
  const map: Record<string, number> = {};
  for (const [id, cnt] of rows) {
    map[id] = cnt;
  }
  return map;
}

/** 统计各标签的未完成根任务数量 */
export async function getCountsByTag(): Promise<Record<string, number>> {
  const rows = await invoke<[string, number][]>("task_count_by_tag");
  const map: Record<string, number> = {};
  for (const [id, cnt] of rows) {
    map[id] = cnt;
  }
  return map;
}

/** 统计智能视图的未完成根任务数量 */
export async function getSmartViewCount(view: SmartViewId): Promise<number> {
  return await invoke<number>("task_count_smart_view", { view });
}

/** 统计各笔记本的笔记条目数量（不区分 done，笔记无完成概念） */
export async function getNoteCountsByList(): Promise<Record<string, number>> {
  const rows = await invoke<[string, number][]>("note_count_by_list");
  const map: Record<string, number> = {};
  for (const [id, cnt] of rows) {
    map[id] = cnt;
  }
  return map;
}

export async function getSmartViewTasks(
  view: SmartViewId,
  sortField?: string,
  sortDir?: string,
): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("task_get_smart_view", {
    view,
    sortField,
    sortDir,
  });
  return rows.map(mapTask);
}

export async function getSubtasks(parentId: string): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("task_get_subtasks", { parentId });
  return rows.map(mapTask);
}

/** 查询可作为「关联主任务/主笔记」的候选：全部清单/笔记本的未完成一级条目
 *  （排除自身、排除归档清单；kind 过滤 'task' 或 'note'） */
export async function getRootCandidates(excludeId: string, kind: TaskKind): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("task_get_root_candidates", { excludeId, kind });
  return rows.map(mapTask);
}

/** 把任务挂为另一任务的子任务（关联主任务；跨清单时后端同步 list_id/group_id） */
export async function setTaskParent(taskId: string, parentId: string): Promise<void> {
  await invoke<void>("task_set_parent", { taskId, parentId });
}

/** 按 due 日期范围拉取任务（用于日历视图）
 * 命中条件：任务区间与 [start, end] 相交；包含根任务与子任务
 * @param start 范围起始（本地字面量 "YYYY-MM-DDTHH:mm:ss"）
 * @param end 范围结束（本地字面量）
 * @param includeDone 是否包含已完成（默认 false）
 */
export async function getTasksByDueRange(
  start: string,
  end: string,
  includeDone = false,
): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("task_get_by_due_range", {
    start,
    end,
    includeDone,
  });
  return rows.map(mapTask);
}

/** 查询某时间范围内「已完成」的根任务（按 completed_at 过滤）。
 *  与 getTasksByDueRange 区别：那个按截止日期，本方法按完成时间。 */
export async function getCompletedTasksInRange(
  start: string,
  end: string,
): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("task_get_completed_in_range", {
    start,
    end,
  });
  return rows.map(mapTask);
}

/** 按 ID 获取单个任务（用于详情面板解析父任务链） */
export async function getTaskById(id: string): Promise<Task | null> {
  const r = await invoke<RustTask | null>("task_get_by_id", { id });
  return r ? mapTask(r) : null;
}

/** 抓取网页标题（详情面板「解析 URL 标题」功能；失败抛异常，前端提示） */
export async function fetchUrlTitle(url: string): Promise<string> {
  return invoke<string>("fetch_url_title", { url });
}

// ─── 应用设置 ────────────────────────────────────────────

/** 查询应用设置 */
export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

/** 保存应用设置 */
export async function setSetting(key: string, value: string): Promise<void> {
  await invoke<void>("set_setting", { key, value });
}

export async function createTask(params: CreateTaskInput): Promise<Task> {
  const input = {
    title: params.title,
    list_id: params.listId,
    parent_id: params.parentId ?? null,
    priority: params.priority ?? 0,
    due_start_at: params.dueStartAt ?? null,
    due_end_at: params.dueEndAt ?? null,
    recurrence_freq: params.recurrenceFreq ?? null,
    recurrence_interval: params.recurrenceInterval ?? 1,
    recurrence_end_at: params.recurrenceEndAt ?? null,
    recurrence_count: params.recurrenceCount ?? null,
    remind_offset_minutes: params.remindOffsetMinutes ?? null,
    remind_at: params.remindAt ?? null,
    kind: params.kind ?? "task",
    group_id: params.groupId ?? null,
  };
  const r = await invoke<RustTask>("task_create", { input });
  return mapTask(r);
}

export async function updateTask(
  id: string,
  fields: UpdateTaskInput,
): Promise<void> {
  const input: Record<string, unknown> = {
    title: fields.title,
    note: fields.note,
    priority: fields.priority,
    due_start_at: fields.dueStartAt,
    due_end_at: fields.dueEndAt,
    list_id: fields.listId,
    group_id: fields.groupId,
    recurrence_freq: fields.recurrenceFreq,
    recurrence_interval: fields.recurrenceInterval,
    recurrence_end_at: fields.recurrenceEndAt,
    recurrence_count: fields.recurrenceCount,
    remind_offset_minutes: fields.remindOffsetMinutes,
    remind_at: fields.remindAt,
    checklist: fields.checklist,
    attachments: fields.attachments,
    kind: fields.kind,
    title_url: fields.titleUrl,
  };
  await invoke<void>("task_update", { id, input });
}

export async function toggleTask(id: string, done: boolean): Promise<void> {
  await invoke<void>("task_toggle", { id, done });
}

export async function deleteTask(id: string): Promise<void> {
  await invoke<void>("task_delete", { id });
}

// ─── 回收站 ──────────────────────────────────────────────
// 删除（deleteTask/deleteList）= 软删除整棵子树入回收站；
// 恢复/彻底删除/清空在此处。kind 为大类：'task'（任务/笔记）| 'list'（清单/笔记本/目录）。

/** 列出回收站顶层项（删除树的根），按删除时间倒序 */
export async function getTrashItems(): Promise<TrashItem[]> {
  return await invoke<TrashItem[]>("trash_list_items");
}

/** 恢复回收站条目（整棵子树恢复原位；容器异常时兜底到根级/默认容器） */
export async function restoreTrashItem(id: string, kind: "task" | "list"): Promise<void> {
  await invoke<void>("trash_restore", { id, kind });
}

/** 彻底删除单条（整棵子树物理删除，含关联标签/生成历史/分组/附件文件） */
export async function purgeTrashItem(id: string, kind: "task" | "list"): Promise<void> {
  await invoke<void>("trash_purge", { id, kind });
}

/** 清空回收站（全部已删除条目物理删除） */
export async function emptyTrash(): Promise<void> {
  await invoke<void>("trash_empty");
}

/** 回收站任务/笔记只读详情（含整棵后代子树与标签；子树不过滤 deleted_at） */
export async function getTrashTaskDetail(
  id: string,
): Promise<{ task: Task; children: Task[]; tags: Tag[] }> {
  const r = await invoke<{ task: RustTask; children: RustTask[]; tags: Tag[] }>(
    "trash_get_task_detail",
    { id },
  );
  return { task: mapTask(r.task), children: r.children.map(mapTask), tags: r.tags };
}

/** 批量更新任务排序 */
export async function reorderTasks(items: [string, number][]): Promise<void> {
  await invoke<void>("task_reorder", { items });
}

/** 移动任务（含整棵子任务树）到其他清单（后端事务内迁移并重置分组） */
export async function moveTaskToList(taskId: string, targetListId: string): Promise<void> {
  await invoke<void>("task_move_to_list", { taskId, targetListId });
}

// ─── 标签操作 ────────────────────────────────────────────

export async function getTags(): Promise<Tag[]> {
  return await invoke<Tag[]>("tag_get_all");
}

export async function createTag(name: string, color: string): Promise<Tag> {
  return await invoke<Tag>("tag_create", { name, color });
}

export async function deleteTag(id: string): Promise<void> {
  await invoke<void>("tag_delete", { id });
}

export async function renameTag(id: string, name: string, color?: string): Promise<void> {
  await invoke<void>("tag_rename", { id, name, color: color ?? null });
}

/** 批量更新标签位置（侧边栏拖拽排序后调用） */
export async function reorderTags(items: [string, number][]): Promise<void> {
  await invoke<void>("tag_reorder", { items });
}

// ─── 搜索 ────────────────────────────────────────────────

export async function searchTasks(query: string): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("search_tasks", { query });
  return rows.map(mapTask);
}

// ─── 习惯操作 ────────────────────────────────────────────

export interface Habit {
  id: string;
  name: string;
  color: string;
  repeatRule: string;
  targetCount: number;
  remindAt: string | null;
  createdAt: string;
  /** 侧边栏手动排序 key */
  position: number;
  /** 时段分组："morning" | "afternoon" | "evening" */
  timeOfDay: "morning" | "afternoon" | "evening";
  /** emoji 图标字符 */
  icon: string;
}

export interface HabitWithStats {
  habit: Habit;
  todayDone: boolean;
  streak: number;
  totalDays: number;
}

interface RustHabit {
  id: string;
  name: string;
  color: string;
  repeat_rule: string;
  target_count: number;
  remind_at: string | null;
  created_at: string;
  position: number;
  time_of_day: string;
  icon: string;
}

interface RustHabitWithStats {
  habit: RustHabit;
  today_done: boolean;
  streak: number;
  total_days: number;
}

function mapHabit(r: RustHabit): Habit {
  const tod = r.time_of_day as Habit["timeOfDay"];
  return {
    id: r.id, name: r.name, color: r.color,
    repeatRule: r.repeat_rule, targetCount: r.target_count,
    remindAt: r.remind_at, createdAt: r.created_at,
    position: r.position,
    timeOfDay: (tod === "morning" || tod === "afternoon") ? tod : "evening",
    icon: r.icon || "🏆",
  };
}

export async function getHabits(): Promise<HabitWithStats[]> {
  const rows = await invoke<RustHabitWithStats[]>("habit_get_all");
  return rows.map((r) => ({
    habit: mapHabit(r.habit),
    todayDone: r.today_done,
    streak: r.streak,
    totalDays: r.total_days,
  }));
}

export async function createHabit(params: {
  name: string;
  color?: string;
  repeatRule?: string;
  targetCount?: number;
  remindAt?: string | null;
  /** 时段：morning | afternoon | evening（默认 evening） */
  timeOfDay?: "morning" | "afternoon" | "evening";
  /** emoji 图标 */
  icon?: string;
}): Promise<Habit> {
  const r = await invoke<RustHabit>("habit_create", {
    input: {
      name: params.name,
      color: params.color,
      repeat_rule: params.repeatRule,
      target_count: params.targetCount,
      remind_at: params.remindAt,
      time_of_day: params.timeOfDay,
      icon: params.icon,
    },
  });
  return mapHabit(r);
}

export async function deleteHabit(id: string): Promise<void> {
  await invoke<void>("habit_delete", { id });
}

/** 更新习惯（名称/颜色/时段/图标/重复/目标/提醒） */
export async function updateHabit(params: {
  id: string;
  name?: string;
  color?: string;
  timeOfDay?: "morning" | "afternoon" | "evening";
  icon?: string;
  repeatRule?: string;
  targetCount?: number;
  remindAt?: string | null;
}): Promise<Habit> {
  const r = await invoke<RustHabit>("habit_update", {
    id: params.id,
    name: params.name,
    color: params.color,
    timeOfDay: params.timeOfDay,
    icon: params.icon,
    repeatRule: params.repeatRule,
    targetCount: params.targetCount,
    remindAt: params.remindAt,
  });
  return mapHabit(r);
}

export async function toggleHabitCheck(habitId: string, date?: string): Promise<boolean> {
  return await invoke<boolean>("habit_toggle_check", { habitId, date });
}

export async function getHabitLogs(habitId: string): Promise<Array<[string, number]>> {
  return await invoke<Array<[string, number]>>("habit_get_logs", { habitId });
}

/** 批量更新习惯位置（侧边栏拖拽排序后调用） */
export async function reorderHabits(items: [string, number][]): Promise<void> {
  await invoke<void>("habit_reorder", { items });
}

// ─── 任务-标签关联 ────────────────────────────────────────────

export async function getTaskTags(taskId: string): Promise<Tag[]> {
  return await invoke<Tag[]>("task_get_tags", { taskId });
}

/** 批量查询多个任务的标签关联（一条 SQL），返回扁平数组，前端自行按 task_id 分组 */
export async function getTaskTagsBatch(taskIds: string[]): Promise<TaskTagLink[]> {
  if (taskIds.length === 0) return [];
  return await invoke<TaskTagLink[]>("task_get_tags_batch", { taskIds });
}

export async function addTaskTag(taskId: string, tagId: string): Promise<void> {
  await invoke<void>("task_add_tag", { taskId, tagId });
}

export async function removeTaskTag(taskId: string, tagId: string): Promise<void> {
  await invoke<void>("task_remove_tag", { taskId, tagId });
}

/** 重排某任务内的标签顺序（每个任务独立的局部顺序） */
export async function reorderTaskTags(
  taskId: string,
  orderedTagIds: string[],
): Promise<void> {
  await invoke<void>("task_reorder_tags", { taskId, orderedTagIds });
}

export async function getTasksByTag(
  tagId: string,
  sortField?: string,
  sortDir?: string,
): Promise<Task[]> {
  const rows = await invoke<RustTask[]>("task_get_by_tag", {
    tagId,
    sortField,
    sortDir,
  });
  return rows.map(mapTask);
}

// ─── 附件管理 ────────────────────────────────────────────

export async function getAttachmentPath(): Promise<string> {
  return await invoke<string>("get_attachment_path");
}

export async function setAttachmentDir(path: string): Promise<string> {
  return await invoke<string>("set_attachment_dir", { path });
}

export async function saveImage(data: string, ext: string): Promise<string> {
  return await invoke<string>("save_image", { data, ext });
}

export async function getAttachmentFullpath(filename: string): Promise<string> {
  return await invoke<string>("get_attachment_fullpath", { filename });
}

/**
 * 保存任意类型附件（base64 数据），返回相对附件目录的子路径（YYYYMMDD/<type>/<uuid>.<ext>）。
 * category 由前端从文件名推导（categorizeAttachmentType），Rust 端会白名单校验。
 */
export async function saveAttachment(
  data: string,
  ext: string,
  category: AttachmentType,
): Promise<string> {
  return await invoke<string>("save_attachment", { data, ext, category });
}

/** 删除附件目录中的物理文件（幂等，文件不存在视为成功） */
export async function deleteAttachment(storedName: string): Promise<void> {
  await invoke<void>("delete_attachment", { storedName });
}

/** 读取文本类附件内容（md/txt 预览用；超过 2MB 会报错） */
export async function readAttachmentText(storedName: string): Promise<string> {
  return await invoke<string>("read_attachment_text", { storedName });
}

// ─── 笔记导入 ────────────────────────────────────────────

/** 待导入的本地文本文件（Rust 端已校验扩展名白名单与 2MB 上限） */
export interface ImportedTextFile {
  /** 文件名（已去扩展名），作笔记标题 */
  title: string;
  /** 文件原文（UTF-8 文本） */
  content: string;
}

/** 读取本地文本文件用于导入笔记（绝对路径，来自系统文件选择器） */
export async function readImportText(path: string): Promise<ImportedTextFile> {
  return await invoke<ImportedTextFile>("read_import_text", { path });
}

/** 把任务/笔记导出的 Markdown 写入用户选择的路径（来自系统保存对话框） */
export async function writeExportText(path: string, content: string): Promise<void> {
  await invoke<void>("write_export_text", { path, content });
}

/** 在系统文件管理器中定位（高亮选中）附件文件 */
export async function revealAttachment(storedName: string): Promise<void> {
  await invoke<void>("reveal_attachment", { storedName });
}

/** 把附件完整路径写入系统剪贴板 */
export async function copyAttachmentPath(storedName: string): Promise<void> {
  await invoke<void>("copy_attachment_path", { storedName });
}

/** 把任意文本写入系统剪贴板（供富文本「复制代码块」等场景使用） */
export async function copyText(text: string): Promise<void> {
  await invoke<void>("copy_text", { text });
}

// ─── 模板操作 ────────────────────────────────────────────
// 模板是"任务参数预设"，独立于 tasks 表。
// 应用模板由前端 store 编排：taskStore.createTask + db.updateTask(note)。

/** Rust 端返回的模板行（snake_case） */
interface RustTemplate {
  id: string;
  name: string;
  title: string;
  note: string;
  is_builtin: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  /** 实体类型：'task' 任务模板（默认）| 'note' 笔记模板 */
  kind: TaskKind;
}

/** Rust 行 → 前端 camelCase */
function mapTemplate(r: RustTemplate): Template {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    note: r.note,
    isBuiltin: r.is_builtin,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    kind: r.kind,
  };
}

export async function getTemplates(): Promise<Template[]> {
  const rows = await invoke<RustTemplate[]>("template_get_all");
  return rows.map(mapTemplate);
}

export async function createTemplate(params: {
  name: string;
  title: string;
  note: string;
  /** 实体类型：不传默认 'task'；'note' = 笔记模板 */
  kind?: TaskKind;
}): Promise<Template> {
  const input = {
    name: params.name,
    title: params.title,
    note: params.note,
    kind: params.kind ?? "task",
  };
  const r = await invoke<RustTemplate>("template_create", { input });
  return mapTemplate(r);
}

export async function updateTemplate(
  id: string,
  fields: { name?: string; title?: string; note?: string; kind?: TaskKind },
): Promise<void> {
  const input: Record<string, unknown> = {
    name: fields.name,
    title: fields.title,
    note: fields.note,
    kind: fields.kind,
  };
  await invoke<void>("template_update", { id, input });
}

export async function deleteTemplate(id: string): Promise<void> {
  await invoke<void>("template_delete", { id });
}

/** 批量重排模板顺序（拖拽后调用，传入完整新顺序的 [(id, position)] 数组） */
export async function reorderTemplates(items: [string, number][]): Promise<void> {
  await invoke<void>("template_reorder", { items });
}

// ─── 任务分组（Group）CRUD ───

/** 获取清单的所有分组（按 sort_order 排序） */
export async function getGroups(listId: string): Promise<Group[]> {
  const rows = await invoke<Record<string, unknown>[]>('group_list', { listId });
  return rows.map((r) => ({
    id: r.id as string,
    listId: r.list_id as string,
    name: r.name as string,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as string,
  }));
}

/** 获取全部分组（看板跨清单展示用，按 sort_order 排序） */
export async function getAllGroups(): Promise<Group[]> {
  const rows = await invoke<Record<string, unknown>[]>('group_list_all');
  return rows.map((r) => ({
    id: r.id as string,
    listId: r.list_id as string,
    name: r.name as string,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as string,
  }));
}

/** 创建分组
 * @param sortOrder 指定排序位置；不传则后端追加到末尾 */
export async function createGroup(
  listId: string,
  name: string,
  sortOrder?: number,
): Promise<Group> {
  const r = await invoke<Record<string, unknown>>('group_create', {
    input: { list_id: listId, name, sort_order: sortOrder ?? null },
  });
  return {
    id: r.id as string,
    listId: r.list_id as string,
    name: r.name as string,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as string,
  };
}

/** 更新分组（重命名 / 改排序） */
export async function updateGroup(
  id: string,
  fields: { name?: string; sortOrder?: number },
): Promise<void> {
  const input: Record<string, unknown> = {};
  if (fields.name !== undefined) input.name = fields.name;
  if (fields.sortOrder !== undefined) input.sort_order = fields.sortOrder;
  await invoke<void>('group_update', { id, input });
}

/** 删除分组（组内任务回填到默认分组） */
export async function deleteGroup(id: string): Promise<void> {
  await invoke<void>('group_delete', { id });
}

/** 批量重排分组顺序 */
export async function reorderGroups(orderedIds: string[]): Promise<void> {
  await invoke<void>('group_reorder', { orderedIds });
}

// ─── 重复任务管理（后台任务面板用） ───────────────────────────

/** 列出所有重复任务模板（含已暂停、已完成），供后台任务面板展示。
 *  Rust 返回 snake_case，需经 mapTask 转成前端 Task 接口（与其余任务查询一致） */
export async function listRecurrenceTemplates(): Promise<Task[]> {
  const rows = await invoke<RustTask[]>('recurrence_list_templates');
  return rows.map(mapTask);
}

/** 暂停/恢复某个重复模板的生成（paused=true 后台 tick 跳过；false 恢复） */
export async function pauseRecurrence(id: string, paused: boolean): Promise<void> {
  await invoke<void>('recurrence_pause', { id, paused });
}

/** 手动运行单个重复模板的生成（跳过 paused/done 过滤，返回是否生成了新实例） */
export async function runRecurrenceOne(id: string): Promise<number> {
  return await invoke<number>('recurrence_run_one', { id });
}

/** 查询某模板的生成历史（最近 20 条，按生成日期倒序） */
export async function getRecurrenceHistory(templateId: string): Promise<RecurrenceHistoryEntry[]> {
  return await invoke<RecurrenceHistoryEntry[]>('recurrence_history', { templateId });
}

// ─── 定时提醒列表（后台任务面板用） ───────────────────────────

/** 列出所有设置了提醒的未完成任务（含计算后的触发时刻，按触发时刻升序）。
 *  后端已排除「算不出触发时刻」的任务（如 offset 设了但无截止时间）。 */
export async function listUpcomingReminders(): Promise<UpcomingReminder[]> {
  return await invoke<UpcomingReminder[]>('reminder_upcoming_list');
}
