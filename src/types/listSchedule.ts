// 清单生成计划 —— 前端类型定义
// 与 Rust src-tauri/src/list_schedule/models.rs 的 ListSchedule 对应

/** 清单生成计划频率 */
export type ListScheduleFreq = "daily" | "weekly" | "monthly" | "yearly" | "workday";

/** 频率选项（下拉用） */
export const LIST_SCHEDULE_FREQS: ReadonlyArray<{
  value: ListScheduleFreq;
  label: string;
}> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周（周一）" },
  { value: "monthly", label: "每月（1 号）" },
  { value: "yearly", label: "每年（1 月 1 日）" },
  { value: "workday", label: "工作日（跳过法定节假日）" },
];

/** 频率值 → 中文标签（卡片展示用） */
export const FREQ_LABELS: Record<ListScheduleFreq, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
  workday: "工作日",
};

/** 生成项类型：folder=目录 / list=清单（与频率解耦，由用户显式指定） */
export type ListScheduleLeafType = "folder" | "list";

/** 生成项类型选项（下拉用） */
export const LIST_SCHEDULE_LEAF_TYPES: ReadonlyArray<{
  value: ListScheduleLeafType;
  label: string;
}> = [
  { value: "folder", label: "目录" },
  { value: "list", label: "清单" },
];

/** 清单生成计划 */
export interface ListSchedule {
  id: string;
  /** 计划名称 */
  name: string;
  /** 路径模板，如 工作/日志/{{YYYY}}/{{MM}}/{{YYYY-MM-DD}} */
  pathTemplate: string;
  /** 频率 */
  freq: ListScheduleFreq;
  /** 生成项类型：folder=目录 / list=清单 */
  leafType: ListScheduleLeafType;
  /** 生成清单的颜色 */
  color: string;
  /** 是否启用 */
  enabled: boolean;
  /** 显示排序 */
  position: number;
  /** 创建时间字面量 */
  createdAt: string;
}

/** Rust 行（snake_case，invoke 返回） */
export interface ListScheduleRow {
  id: string;
  name: string;
  path_template: string;
  freq: string;
  leaf_type: string;
  color: string;
  enabled: boolean;
  position: number;
  created_at: string;
}

/** 行 → 前端接口 */
export function mapListScheduleRow(row: ListScheduleRow): ListSchedule {
  return {
    id: row.id,
    name: row.name,
    pathTemplate: row.path_template,
    freq: row.freq as ListScheduleFreq,
    leafType: row.leaf_type as ListScheduleLeafType,
    color: row.color,
    enabled: row.enabled,
    position: row.position,
    createdAt: row.created_at,
  };
}

/** 路径模板占位符说明表（UI 悬浮提示用） */
export const PATH_PLACEHOLDERS: ReadonlyArray<{
  token: string;
  desc: string;
  example: string;
}> = [
  { token: "{{YYYY}}", desc: "4 位年", example: "2026" },
  { token: "{{YY}}", desc: "2 位年", example: "26" },
  { token: "{{MM}}", desc: "2 位月（补零）", example: "08" },
  { token: "{{M}}", desc: "月（不补零）", example: "8" },
  { token: "{{DD}}", desc: "2 位日（补零）", example: "01" },
  { token: "{{D}}", desc: "日（不补零）", example: "1" },
  { token: "{{YYYY-MM-DD}}", desc: "完整日期", example: "2026-08-01" },
  { token: "{{YYYY-MM}}", desc: "年月", example: "2026-08" },
];
