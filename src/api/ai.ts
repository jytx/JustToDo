// AI 相关 IPC 封装
// 详见 discuss/2026-07-31-ai-config-design.md + 2026-07-31-ai-daily-summary-design.md

import { invoke } from "@tauri-apps/api/core";

/** AI 操作结果（与 Rust 端 serde_json::json!({ ok, ... }) 对应） */
export interface AiResult {
  ok: boolean;
  /** 成功时的提示或失败时的错误信息 */
  message?: string;
}

/** 测试连接结果 */
export interface AiTestResult extends AiResult {
  /** 无（message 即结果文案） */
}

/** 调用 ai_test_connection 命令，验证配置可用性 */
export async function testConnection(): Promise<AiTestResult> {
  return invoke<AiTestResult>("ai_test_connection");
}

/** 小结生成结果 */
export interface AiSummaryResult {
  ok: boolean;
  /** 成功时为生成的 Markdown 文本；失败时无 */
  content?: string;
  /** 失败时的错误信息 */
  message?: string;
}

/** 生成每日小结 / 周报。
 *  mode: "daily"（今天）| "weekly"（本周） */
export async function generateSummary(mode: "daily" | "weekly"): Promise<AiSummaryResult> {
  return invoke<AiSummaryResult>("ai_summary", { mode });
}

/** AI 总结范围：清单 / 目录 / 多选任务 */
export type SummaryScope =
  | { type: "list" | "folder"; id: string; name: string; kind: "task" | "note" }
  | { type: "tasks"; ids: string[] };

/** 范围总结结果（比 AiSummaryResult 多 count/kind/truncated，用于超阈值提示） */
export interface ScopeSummaryResult {
  ok: boolean;
  content?: string;
  message?: string;
  /** 原始任务总数（裁剪前） */
  count?: number;
  /** 实体类型 task/note */
  kind?: string;
  /** 是否已裁剪 */
  truncated?: boolean;
  /** 范围为空（无任务/笔记），无需总结 —— 前端显示友好提示而非错误 */
  empty?: boolean;
}

/** 按范围生成 AI 总结（清单/目录/多选）。
 *  truncate: true 时按设置阈值裁剪（前端超阈值弹确认后传 true） */
export async function generateScopeSummary(
  scope: SummaryScope,
  truncate: boolean,
): Promise<ScopeSummaryResult> {
  return invoke<ScopeSummaryResult>("ai_summary_scope", { scope, truncate });
}

/** AI 解析出的任务结构（自然语言建任务的草稿） */
export interface ParsedTask {
  title: string;
  priority: number;
  dueStartAt: string | null;
  dueEndAt: string | null;
  tagNames: string[];
  /** AI 生成的任务详情正文（HTML） */
  note: string;
}

/** 自然语言解析结果（支持多意图路由） */
export interface ParseTaskResult {
  ok: boolean;
  /** 意图：create_task | summarize_list | smart_summary | create_note | unsupported */
  intent?: "create_task" | "summarize_list" | "smart_summary" | "create_note" | "unsupported";
  /** smart_summary 模式：daily/weekly */
  mode?: "daily" | "weekly";
  /** 成功时的解析草稿（intent=create_task/create_note 时） */
  parsed?: ParsedTask;
  /** 失败时的错误/提示信息 */
  message?: string;
  /** fallback：模型未调工具时，原样返回标题让用户直接建 */
  fallbackTitle?: string;
}

/** 用 AI 解析自然语言输入，提取任务的结构化字段（tools/function calling）。
 *  输入如「明天3点和老板开会 #工作 高优」，返回 {title, priority, dueStartAt, dueEndAt, tagNames}。 */
export async function parseTask(input: string): Promise<ParseTaskResult> {
  return invoke<ParseTaskResult>("ai_parse_task", { input });
}

/** AI 拆解出的单个子任务草稿 */
export interface ParsedSubtask {
  title: string;
  /** 优先级：0=无 1=低 2=中 3=高 */
  priority: number;
  /** 截止开始时间（本地格式 YYYY-MM-DDTHH:mm:ss），无则 null */
  dueStartAt: string | null;
  /** 截止结束时间，无则 null */
  dueEndAt: string | null;
  /** AI 生成的执行说明（HTML 的 <p> 标签） */
  note: string;
}

/** AI 任务拆解结果 */
export interface BreakdownResult {
  ok: boolean;
  /** 成功时的子任务草稿列表 */
  subtasks?: ParsedSubtask[];
  /** 失败时的错误信息 */
  message?: string;
}

/** 用 AI 把一个大任务拆解成多个子任务。
 *  传入大任务 ID，后端查出标题/备注作为输入，返回子任务草稿列表（预览后由前端确认落库）。 */
export async function breakdownTask(taskId: string): Promise<BreakdownResult> {
  return invoke<BreakdownResult>("ai_breakdown_task", { taskId });
}
