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
