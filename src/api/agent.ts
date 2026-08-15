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

/** 历史会话摘要（列表项） */
export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** 历史会话列表结果 */
export interface SessionListResult {
  ok: boolean;
  sessions?: AgentSessionSummary[];
  message?: string;
}

/** 历史消息中的工具步骤（与 types/agent.ts 的 ToolStep 同构） */
export interface HistoryToolStep {
  callId: string;
  name: string;
  args: unknown;
  ok: boolean;
  summary: string;
}

/** 历史消息（展示格式；assistant 消息携带工具步骤） */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  tools: HistoryToolStep[];
}

/** 单个会话的完整历史 */
export interface HistoryResult {
  ok: boolean;
  title?: string;
  messages?: HistoryMessage[];
  message?: string;
}

/** 历史会话列表（按最后活动倒序，最多 50 条） */
export async function listAgentSessions(): Promise<SessionListResult> {
  return invoke<SessionListResult>("ai_agent_list_sessions");
}

/** 加载单个会话的完整消息（展示格式，含工具步骤） */
export async function getAgentHistory(sessionId: string): Promise<HistoryResult> {
  return invoke<HistoryResult>("ai_agent_history", { sessionId });
}

/** 删除会话（消息级联删除） */
export async function deleteAgentSession(sessionId: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("ai_agent_delete_session", { sessionId });
}
