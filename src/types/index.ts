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
  /** 本地时间字面量（"YYYY-MM-DDTHH:mm:ss"，无时区标记）或 null */
  dueStartAt: string | null;
  /** 本地时间字面量（"YYYY-MM-DDTHH:mm:ss"，无时区标记）或 null */
  dueEndAt: string | null;
  done: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** 重复频率（null = 不重复） */
  recurrenceFreq: RecurrenceFreq | null;
  /** 重复间隔（每 N 天/周/月/年） */
  recurrenceInterval: number;
  /** 重复结束日期（null = 永不结束） */
  recurrenceEndAt: string | null;
  /** 剩余重复次数（null = 不限） */
  recurrenceCount: number | null;
  /** 重复实例的来源模板 id（null = 普通任务或自身即模板） */
  recurrenceOriginId: string | null;
  /** 提前多少分钟提醒（null = 不提醒；0 = 准点；N = 提前 N 分钟） */
  remindOffsetMinutes: number | null;
  /** 通知触发时间戳（null = 还没通知过） */
  notifiedAt: string | null;
  /** 检查项列表（独立于 note 富文本；滴答清单风格） */
  checklist: ChecklistItem[];
}

/** 检查项（独立存储；后端 JSON 数组） */
export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  /** 排序权重（数字小 = 排前） */
  order: number;
}

/** 提醒预设项（分钟）。value 表示 remindOffsetMinutes，传 null = 不提醒 */
export interface RemindPreset {
  /** 显示标签 */
  label: string;
  /** 提前分钟数（null = 不提醒；0 = 准点） */
  value: number | null;
  /** 是否为预设；false 表示"自定义" */
  preset: boolean;
}

/** 提醒预设选项（详情面板下拉用） */
export const REMIND_PRESETS: RemindPreset[] = [
  { label: "不提醒", value: null, preset: true },
  { label: "准点", value: 0, preset: true },
  { label: "提前 5 分钟", value: 5, preset: true },
  { label: "提前 10 分钟", value: 10, preset: true },
  { label: "提前 15 分钟", value: 15, preset: true },
  { label: "提前 30 分钟", value: 30, preset: true },
  { label: "提前 1 小时", value: 60, preset: true },
  { label: "自定义…", value: -1, preset: false },
];

/** 把 remindOffsetMinutes 映射回预设索引（找不到非"自定义"） */
export function matchRemindPreset(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0; // 不提醒
  const idx = REMIND_PRESETS.findIndex(
    (p) => p.preset && p.value === value,
  );
  if (idx >= 0) return idx;
  return REMIND_PRESETS.length - 1; // 自定义
}

/** 任务重复频率 */
export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

/** 频率 → 中文标签 */
export const RECURRENCE_FREQ_LABELS: Record<RecurrenceFreq, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};

/** 频率选项数组（供 v-for 使用） */
export const RECURRENCE_FREQS: Array<{ value: RecurrenceFreq; label: string }> = [
  { value: "daily", label: RECURRENCE_FREQ_LABELS.daily },
  { value: "weekly", label: RECURRENCE_FREQ_LABELS.weekly },
  { value: "monthly", label: RECURRENCE_FREQ_LABELS.monthly },
  { value: "yearly", label: RECURRENCE_FREQ_LABELS.yearly },
];

/**
 * 格式化重复规则为中文描述。
 * label 自带"每"前缀（如"每天"），这里统一去掉后重新拼接，避免"每每天"。
 * - freq 为 null → 空串
 * - interval = 1 → "每天" / "每周" ...
 * - interval > 1 → "每 3 天" / "每 2 周" ...
 */
export function formatRecurrence(
  freq: RecurrenceFreq | null,
  interval: number,
): string {
  if (!freq) return "";
  const unit = RECURRENCE_FREQ_LABELS[freq].replace(/^每/, "");
  const n = interval || 1;
  return n === 1 ? `每${unit}` : `每 ${n} ${unit}`;
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
  recurrence_freq: string | null;
  recurrence_interval: number;
  recurrence_end_at: string | null;
  recurrence_count: number | null;
  recurrence_origin_id: string | null;
  remind_offset_minutes: number | null;
  notified_at: string | null;
  /** JSON 字符串（后端 Vec<ChecklistItem> 序列化） */
  checklist: string;
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
    recurrenceFreq: row.recurrence_freq as RecurrenceFreq | null,
    recurrenceInterval: row.recurrence_interval,
    recurrenceEndAt: row.recurrence_end_at,
    recurrenceCount: row.recurrence_count,
    recurrenceOriginId: row.recurrence_origin_id,
    remindOffsetMinutes: row.remind_offset_minutes,
    notifiedAt: row.notified_at,
    checklist: parseChecklist(row.checklist),
  };
}

/** 把 JSON 字符串解析为 ChecklistItem 列表（解析失败则空列表） */
function parseChecklist(raw: string): ChecklistItem[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr as ChecklistItem[];
  } catch {
    return [];
  }
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
