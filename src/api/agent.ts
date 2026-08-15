// AI 智能体（Agent）IPC 封装
// 详见 discuss/2026-08-15-ai-agent-design.md

import { invoke, Channel } from "@tauri-apps/api/core";

/** agent 会话事件（Rust Channel → 前端；与 ai/types.rs 的 AgentEvent 一一对应） */
export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown }
  | { type: "tool_end"; callId: string; ok: boolean; summary: string }
  | { type: "done"; rounds: number; promptTokens: number; completionTokens: number }
  | { type: "error"; message: string };

/** agent 对话返回值（ok=false 时 message 为错误信息） */
export interface AgentChatResult {
  ok: boolean;
  /** 会话 id（续聊时回传；新会话由后端生成） */
  sessionId?: string;
  message?: string;
}

/** 注入给 agent 的当前上下文（Rust 端拼进 system 提示词） */
export interface AgentContext {
  /** 当前所在清单/笔记本名 */
  currentListName?: string;
  /** 多选任务标题 */
  selectedTitles?: string[];
}

/** 发起一轮智能体对话（多轮工具循环）。
 *  sessionId 不传 = 开新会话；传 = 续聊。
 *  过程事件（文本增量/工具步骤）经 onEvent 实时回调。 */
export async function agentChat(
  message: string,
  sessionId: string | null,
  context: AgentContext,
  onEvent: (ev: AgentEvent) => void,
): Promise<AgentChatResult> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<AgentChatResult>("ai_agent_chat", {
    message,
    sessionId: sessionId ?? undefined,
    context,
    onEvent: channel,
  });
}

/** 清空指定会话的历史（开始新话题） */
export async function agentReset(sessionId: string): Promise<void> {
  await invoke("ai_agent_reset", { sessionId });
}
