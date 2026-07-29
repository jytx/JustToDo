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
  /** 是否已归档（true = 已归档，首页侧边栏隐藏，归档区可见）。
   *  旧数据缺省视为 false（未归档），Rust 端 #[serde(default)] 提供兼容。 */
  archived?: boolean;
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
  /** 附件列表（独立于 note 富文本；文件实体存附件目录） */
  attachments: Attachment[];
}

/** 检查项（独立存储；后端 JSON 数组） */
export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  /** 排序权重（数字小 = 排前） */
  order: number;
}

/** 任务附件（独立存储；后端 JSON 数组，文件实体存附件目录） */
export interface Attachment {
  /** 附件唯一 ID（UUID，与文件名中的 UUID 一致） */
  id: string;
  /** 用户原始文件名（如 "需求文档.md"） */
  originalName: string;
  /** 落盘后的文件名（UUID.ext，如 "a3f5...c1.md"） */
  storedName: string;
  /** MIME 类型（如 "text/markdown"、"video/mp4"），未知则 "application/octet-stream" */
  mime: string;
  /** 文件大小（字节） */
  size: number;
  /** 添加时间（本地时间字面量，与任务 createdAt 同格式） */
  createdAt: string;
}

/** 附件预览分类（决定点击附件时的预览/打开行为） */
export type AttachmentCategory =
  | "image" // png/jpg/gif/webp/svg → 图片灯箱
  | "video" // mp4/mov/webm → 视频播放器弹窗
  | "audio" // mp3/wav/m4a → 音频播放器弹窗
  | "markdown" // md → 应用内 markdown 预览弹窗
  | "text" // txt/log/json → 应用内纯文本预览弹窗
  | "pdf" // pdf → iframe 预览弹窗
  | "other"; // 其他 → 不预览，直接系统默认程序打开

/** 被拦截的危险扩展名（可执行类，防误操作） */
export const BLOCKED_EXTENSIONS: readonly string[] = [
  "exe",
  "app",
  "bat",
  "sh",
  "cmd",
  "com",
  "msi",
  "scr",
  "vbs",
  "ps1",
];

/** 根据扩展名判定附件预览分类 */
export function categorizeAttachment(fileName: string): AttachmentCategory {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext))
    return "image";
  if (["mp4", "mov", "webm", "ogv", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) return "audio";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["txt", "log", "json", "yml", "yaml", "csv", "tsv"].includes(ext))
    return "text";
  if (ext === "pdf") return "pdf";
  return "other";
}

/**
 * 附件磁盘存储分类(目录名,英文)。
 * 与 AttachmentCategory(7 类,预览分流用)的区别:
 *   - 粒度更粗:markdown/text/pdf 合并到 docs(磁盘按"文档"一类即可)
 *   - 新增 archives:压缩包独立成桶
 * 用于 save_attachment 时落盘的子目录名,以及存量迁移时的归类。
 */
export type AttachmentType =
  | "images"
  | "videos"
  | "audios"
  | "docs"
  | "archives"
  | "others";

/** 合法的磁盘分类目录名(白名单,与 Rust 端 save_attachment 校验保持一致) */
export const ATTACHMENT_TYPE_DIRS: readonly AttachmentType[] = [
  "images",
  "videos",
  "audios",
  "docs",
  "archives",
  "others",
];

/** 根据文件名判定磁盘存储分类(决定落盘子目录) */
export function categorizeAttachmentType(fileName: string): AttachmentType {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext))
    return "images";
  if (["mp4", "mov", "webm", "ogv", "mkv"].includes(ext)) return "videos";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) return "audios";
  // 文档类:markdown/text/pdf 统一归 docs
  if (
    ["md", "markdown", "txt", "log", "json", "yml", "yaml", "csv", "tsv", "pdf"].includes(ext)
  )
    return "docs";
  // 压缩包
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext))
    return "archives";
  return "others";
}

/** 判断文件名是否被拦截（可执行类） */
export function isBlockedAttachment(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return BLOCKED_EXTENSIONS.includes(ext);
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
  /** JSON 字符串（后端 Vec<Attachment> 序列化） */
  attachments: string;
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
    attachments: parseAttachments(row.attachments),
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

/** 把 JSON 字符串解析为 Attachment 列表（解析失败则空列表） */
function parseAttachments(raw: string): Attachment[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr as Attachment[];
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

/** 任务模板 —— "任务参数预设"，独立于 tasks 表 */
export interface Template {
  id: string;
  name: string;
  /** 应用模板时作为新任务的 title */
  title: string;
  /** HTML 富文本（RichTextEditor 输出） */
  note: string;
  /** 是否内置预装（用户仍可改/删） */
  isBuiltin: boolean;
  /** 排序权重（MVP 不暴露 UI） */
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** 模板编辑表单（弹窗内 v-model 绑定用；id 为 null 表示新建模式） */
export interface TemplateForm {
  id: string | null;
  name: string;
  title: string;
  note: string;
}
