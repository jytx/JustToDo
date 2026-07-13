// JustToDo 共享数据类型
// 与 Rust 端 / SQLite schema 保持字段对应（snake_case ↔ camelCase 自动转换）

/** 优先级：0 无 / 1 低 / 2 中 / 3 高 */
export type Priority = 0 | 1 | 2 | 3;

/** 优先级常量，便于 UI 引用 */
export const PRIORITY_NONE: Priority = 0;
export const PRIORITY_LOW: Priority = 1;
export const PRIORITY_MEDIUM: Priority = 2;
export const PRIORITY_HIGH: Priority = 3;

/** 优先级 → 主题色 token（对应 Vuetify 主题 colors） */
export const PRIORITY_COLORS: Record<Priority, string> = {
  0: "priority-none",
  1: "info", // 低 = 蓝
  2: "warning", // 中 = 橙
  3: "error", // 高 = 红
};

/** 优先级 → 中文标签 */
export const PRIORITY_LABELS: Record<Priority, string> = {
  0: "无",
  1: "低",
  2: "中",
  3: "高",
};

/** 排序字段 */
export type SortField = "manual" | "priority" | "due" | "title";
export type SortDir = "asc" | "desc";

/** 排序字段 → 中文标签（用于下拉菜单） */
export const SORT_FIELD_LABELS: Record<SortField, string> = {
  manual: "手动（拖拽）",
  priority: "优先级",
  due: "截止日期",
  title: "标题",
};

/** 排序字段选项数组（供 v-for 使用） */
export const SORT_FIELDS: Array<{ value: SortField; label: string }> = [
  { value: "manual", label: SORT_FIELD_LABELS.manual },
  { value: "priority", label: SORT_FIELD_LABELS.priority },
  { value: "due", label: SORT_FIELD_LABELS.due },
  { value: "title", label: SORT_FIELD_LABELS.title },
];

/** 清单 —— 任务的基础容器 */
export interface List {
  id: string;
  name: string;
  color: string;
  position: number;
  createdAt: string;
  /** 父目录 ID（null = 根级） */
  parentId: string | null;
  /** 是否为目录（文件夹） */
  isFolder: boolean;
}

/** 任务 —— 支持子任务嵌套（parentId 自引用） */
export interface Task {
  id: string;
  title: string;
  note: string;
  listId: string;
  parentId: string | null;
  priority: Priority;
  /** ISO 8601 时间字符串或 null */
  dueStartAt: string | null;
  /** ISO 8601 时间字符串或 null */
  dueEndAt: string | null;
  done: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/**
 * 数据库返回的原始行（snake_case + 整数 done/priority）。
 * 前端通过 mapTaskRow 转换为 Task 接口。
 */
export interface TaskRow {
  id: string;
  title: string;
  note: string;
  list_id: string;
  parent_id: string | null;
  priority: number;
  due_start_at: string | null;
  due_end_at: string | null;
  done: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** 清单数据库原始行 */
export interface ListRow {
  id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
  parent_id: string | null;
  is_folder: number;
}

/** 将数据库行转换为前端 Task 接口 */
export function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    listId: row.list_id,
    parentId: row.parent_id,
    priority: row.priority as Priority,
    dueStartAt: row.due_start_at,
    dueEndAt: row.due_end_at,
    done: row.done === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** 将数据库行转换为前端 List 接口 */
export function mapListRow(row: ListRow): List {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
    parentId: row.parent_id,
    isFolder: row.is_folder === 1,
  };
}
