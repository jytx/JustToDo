// AI Agent 工具循环引擎
//
// 核心流程（详见 discuss/2026-08-15-ai-agent-design.md §4.1）：
//   构造消息（system + 历史 + 用户输入）
//   → chat_stream（文本 delta 实时推送）
//   → 有 tool_calls → 执行工具 → 结果作为 tool 消息回传 → 下一轮
//   → 无 tool_calls → 保存历史，结束
//
// 安全阀：
// - 最多 MAX_ROUNDS 轮；最后一轮禁用工具强制文本收尾
// - 每轮最多执行 MAX_CALLS_PER_ROUND 个工具（超出忽略并在结果中说明）
// - 工具执行失败不中断会话：错误回传给模型自行纠正

use sqlx::SqlitePool;

use crate::ai::provider::{AiError, AiProvider};
use crate::ai::tool_exec;
use crate::ai::tools;
use crate::ai::types::{AgentEvent, ChatMessage, ChatRequest, ToolChoice};

/// 最大循环轮数（一轮 = 一次模型调用 + 若干工具执行）
pub const MAX_ROUNDS: u32 = 12;
/// 每轮最多执行的工具调用数
const MAX_CALLS_PER_ROUND: usize = 5;

/// 单次 agent 会话执行结果统计
pub struct AgentOutcome {
    pub rounds: u32,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// 执行一次完整的 agent 循环。
///
/// - `history`：会话历史（含本轮 user 输入之前的全部消息），函数会向其追加
///   本轮的 user/assistant/tool 消息，调用方负责持久化
/// - `on_event`：向前端 Channel 推送全过程事件
pub async fn run_agent_loop(
    pool: &SqlitePool,
    provider: &dyn AiProvider,
    system_prompt: String,
    history: &mut Vec<ChatMessage>,
    user_input: String,
    on_event: std::sync::Arc<dyn Fn(AgentEvent) + Send + Sync>,
) -> Result<AgentOutcome, AiError> {
    history.push(ChatMessage::user {
        content: user_input,
    });

    let mut prompt_tokens: u32 = 0;
    let mut completion_tokens: u32 = 0;

    for round in 1..=MAX_ROUNDS {
        // 最后一轮禁用工具，强制模型基于已有信息直接作答收尾
        let force_final = round == MAX_ROUNDS;
        let req = ChatRequest {
            messages: build_messages(&system_prompt, history),
            tools: if force_final {
                vec![]
            } else {
                tools::tool_defs()
            },
            tool_choice: if force_final {
                ToolChoice::None
            } else {
                ToolChoice::Auto
            },
            ..Default::default()
        };

        // 文本增量实时推给前端（工具轮 content 通常为空，推了也无害）。
        // DeltaFn 要求 'static，每轮 clone 一份 Arc 回调进去。
        let sender = std::sync::Arc::clone(&on_event);
        let resp = provider
            .chat_stream(
                &req,
                Box::new(move |d: &str| {
                    sender(AgentEvent::delta {
                        text: d.to_string(),
                    })
                }),
            )
            .await?;

        if let Some(u) = &resp.usage {
            prompt_tokens += u.prompt_tokens;
            completion_tokens += u.completion_tokens;
        }

        // 无工具调用 → 模型已给出最终答复，本轮结束
        if resp.tool_calls.is_empty() {
            history.push(ChatMessage::assistant {
                content: resp.content,
                tool_calls: vec![],
            });
            return Ok(AgentOutcome {
                rounds: round,
                prompt_tokens,
                completion_tokens,
            });
        }

        // 记录模型的工具调用请求，再逐个执行并把结果回传
        history.push(ChatMessage::assistant {
            content: resp.content,
            tool_calls: resp.tool_calls.clone(),
        });

        for (i, call) in resp.tool_calls.iter().enumerate() {
            if i >= MAX_CALLS_PER_ROUND {
                // 超出单轮上限：不执行，直接告知模型（避免它以为调用成功）
                history.push(ChatMessage::tool {
                    tool_call_id: call.id.clone(),
                    content: r#"{"ok":false,"error":"单轮工具调用数超上限，已忽略本次调用"}"#
                        .into(),
                });
                continue;
            }
            on_event(AgentEvent::tool_start {
                call_id: call.id.clone(),
                name: call.name.clone(),
                args: call.arguments.clone(),
            });
            let result = tool_exec::execute(pool, &call.name, &call.arguments).await;
            on_event(AgentEvent::tool_end {
                call_id: call.id.clone(),
                ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                summary: result
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
            history.push(ChatMessage::tool {
                tool_call_id: call.id.clone(),
                content: result.to_string(),
            });
        }
    }

    // 理论上不可达（最后一轮已禁用工具，必然走无 tool_calls 分支返回），仅作类型兜底
    Ok(AgentOutcome {
        rounds: MAX_ROUNDS,
        prompt_tokens,
        completion_tokens,
    })
}

/// 拼装完整消息列表：system + 裁剪后的历史。
/// 历史超过 HISTORY_LIMIT 条时只保留最近的（防 token 无限膨胀）。
fn build_messages(system_prompt: &str, history: &[ChatMessage]) -> Vec<ChatMessage> {
    const HISTORY_LIMIT: usize = 40;
    let mut msgs = vec![ChatMessage::system {
        content: system_prompt.to_string(),
    }];
    let start = history.len().saturating_sub(HISTORY_LIMIT);
    msgs.extend(history[start..].iter().cloned());
    msgs
}
