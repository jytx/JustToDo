// 数据库访问层 —— 通过 invoke() 调用 Rust 命令
// 架构：所有数据库操作在 Rust 端用 sqlx 执行，前端通过 IPC 调用
// 这样绕过了 plugin-sql 前端 API 的 IPC 问题，走标准 invoke 通道

import { invoke } from "@tauri-apps/api/core";
import type { List, Task, Priority, RecurrenceFreq, ChecklistItem } from "@/types";

// ─── 类型（与 Rust models.rs 对应）──────────────────────

export interface Tag {
  id: string;
  name: string;
  createdAt: string;
}

interface TaskList {
  id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
  parent_id: string | null;
  is_folder: boolean;
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
}

interface UpdateTaskInput {
  title?: string;
  note?: string;
  priority?: Priority;
  dueStartAt?: string | null;
  dueEndAt?: string | null;
  listId?: string;
  recurrenceFreq?: RecurrenceFreq | null;
  recurrenceInterval?: number;
  recurrenceEndAt?: string | null;
  recurrenceCount?: number | null;
  remindOffsetMinutes?: number | null;
  /** 检查项列表（整组覆盖） */
  checklist?: ChecklistItem[];
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
  }));
}

export async function createList(params: {
  name: string;
  color: string;
  parentId?: string | null;
  isFolder?: boolean;
}): Promise<List> {
  const r = await invoke<TaskList>("list_create", {
    name: params.name,
    color: params.color,
    parentId: params.parentId ?? null,
    isFolder: params.isFolder ?? false,
  });
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    createdAt: r.created_at,
    parentId: r.parent_id,
    isFolder: r.is_folder,
  };
}

export async function deleteList(id: string): Promise<void> {
  await invoke<void>("list_delete", { id });
}

export async function renameList(id: string, name: string, color: string): Promise<void> {
  await invoke<void>("list_rename", { id, name, color });
}

export async function moveList(id: string, parentId: string | null, position?: number): Promise<void> {
  await invoke<void>("list_move", { id, parentId, position: position ?? null });
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
  remind_offset_minutes: number | null;
  notified_at: string | null;
  checklist: ChecklistItem[];
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
    remindOffsetMinutes: r.remind_offset_minutes,
    notifiedAt: r.notified_at,
    checklist: r.checklist,
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

/** 按 ID 获取单个任务（用于详情面板解析父任务链） */
export async function getTaskById(id: string): Promise<Task | null> {
  const r = await invoke<RustTask | null>("task_get_by_id", { id });
  return r ? mapTask(r) : null;
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
    recurrence_freq: fields.recurrenceFreq,
    recurrence_interval: fields.recurrenceInterval,
    recurrence_end_at: fields.recurrenceEndAt,
    recurrence_count: fields.recurrenceCount,
    remind_offset_minutes: fields.remindOffsetMinutes,
    checklist: fields.checklist,
  };
  await invoke<void>("task_update", { id, input });
}

export async function toggleTask(id: string, done: boolean): Promise<void> {
  await invoke<void>("task_toggle", { id, done });
}

export async function deleteTask(id: string): Promise<void> {
  await invoke<void>("task_delete", { id });
}

/** 批量更新任务排序 */
export async function reorderTasks(items: [string, number][]): Promise<void> {
  await invoke<void>("task_reorder", { items });
}

// ─── 标签操作 ────────────────────────────────────────────

export async function getTags(): Promise<Tag[]> {
  return await invoke<Tag[]>("tag_get_all");
}

export async function createTag(name: string): Promise<Tag> {
  return await invoke<Tag>("tag_create", { name });
}

export async function deleteTag(id: string): Promise<void> {
  await invoke<void>("tag_delete", { id });
}

export async function renameTag(id: string, name: string): Promise<void> {
  await invoke<void>("tag_rename", { id, name });
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
}

interface RustHabitWithStats {
  habit: RustHabit;
  today_done: boolean;
  streak: number;
  total_days: number;
}

function mapHabit(r: RustHabit): Habit {
  return {
    id: r.id, name: r.name, color: r.color,
    repeatRule: r.repeat_rule, targetCount: r.target_count,
    remindAt: r.remind_at, createdAt: r.created_at,
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
}): Promise<Habit> {
  const r = await invoke<RustHabit>("habit_create", {
    input: {
      name: params.name,
      color: params.color,
      repeat_rule: params.repeatRule,
      target_count: params.targetCount,
      remind_at: params.remindAt,
    },
  });
  return mapHabit(r);
}

export async function deleteHabit(id: string): Promise<void> {
  await invoke<void>("habit_delete", { id });
}

export async function toggleHabitCheck(habitId: string, date?: string): Promise<boolean> {
  return await invoke<boolean>("habit_toggle_check", { habitId, date });
}

export async function getHabitLogs(habitId: string): Promise<Array<[string, number]>> {
  return await invoke<Array<[string, number]>>("habit_get_logs", { habitId });
}

// ─── 任务-标签关联 ────────────────────────────────────────────

export async function getTaskTags(taskId: string): Promise<Tag[]> {
  return await invoke<Tag[]>("task_get_tags", { taskId });
}

export async function addTaskTag(taskId: string, tagId: string): Promise<void> {
  await invoke<void>("task_add_tag", { taskId, tagId });
}

export async function removeTaskTag(taskId: string, tagId: string): Promise<void> {
  await invoke<void>("task_remove_tag", { taskId, tagId });
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
