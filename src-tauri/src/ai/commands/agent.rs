// AI 智能体对话命令 —— 多轮工具循环的 IPC 入口
//
// 会话管理（P1 为内存态）：全局 HashMap<sessionId, Vec<ChatMessage>>，
// 弹窗关闭即弃（P3 迁移到 agent_sessions/agent_messages 表持久化）。
//
// 详见 discuss/2026-08-15-ai-agent-design.md

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;

use super::load_prompt;
use crate::ai::agent::{self, AgentOutcome};
use crate::ai::build_from_settings;
use crate::ai::types::{AgentEvent, ChatMessage};
use crate::commands::{now, uuid, CmdResult};

/// 内存会话表（重启即清空）。Lazy 初始化，进程级单例。
static SESSIONS: std::sync::OnceLock<Mutex<HashMap<String, Vec<ChatMessage>>>> =
    std::sync::OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Vec<ChatMessage>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Agent 默认系统提示词（可自定义，读 ai_prompt_agent 设置；P2 暴露到设置页）
pub const DEFAULT_PROMPT_AGENT: &str = r#"你是 JustToDo 待办应用内的 AI 助手，可以通过调用工具查询和操作用户的任务与笔记。

工作准则：
1. 回答问题前先用工具查询真实数据，不要凭空猜测或编造任务内容
2. 涉及具体任务时，引用真实的标题、清单名、截止时间
3. 用户提到「这个清单」等上下文指代时，参考系统提示末尾注入的当前上下文
4. 时间一律用当前时间锚点换算成绝对日期再表达
5. 回答用简体中文，简洁友好，适合直接阅读；列表用 Markdown
6. 查不到数据就如实说明，不要虚构"#;

/// 智能体对话命令。
///
/// - `session_id`：None = 开新会话；有值 = 续聊（沿用历史消息）
/// - `context`：可选注入的当前上下文，如 { current_list_name: "工作" }
/// - 过程事件经 Channel 推送（delta/tool_start/tool_end/done/error）
/// - 返回 { ok, session_id, rounds, message? }
#[tauri::command]
pub async fn ai_agent_chat(
    pool: State<'_, sqlx::SqlitePool>,
    session_id: Option<String>,
    message: String,
    context: Option<serde_json::Value>,
    on_event: Channel<AgentEvent>,
) -> CmdResult<serde_json::Value> {
    // 输入校验（空消息直接拒绝，不浪费请求）
    if message.trim().is_empty() {
        return Ok(serde_json::json!({ "ok": false, "message": "请输入内容" }));
    }

    let provider = match build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    };

    // 取（或建）会话，先把历史快照出来，缩短锁持有时间
    let sid = session_id.unwrap_or_else(uuid);
    let history_snapshot = {
        let mut map = sessions().lock().unwrap();
        map.entry(sid.clone()).or_default().clone()
    };

    // 组装 system：自定义提示词 + 当前时间锚点 + 上下文注入
    let prompt_tpl = load_prompt(pool.inner(), "ai_prompt_agent", DEFAULT_PROMPT_AGENT).await;
    let system_prompt = build_system_prompt(prompt_tpl, &context);

    // 事件回调：Arc 包裹送进 agent 循环（每轮 clone 进流式闭包）
    let on_event_cb: Arc<dyn Fn(AgentEvent) + Send + Sync> = Arc::new(move |ev: AgentEvent| {
        let _ = on_event.send(ev);
    });

    let mut history = history_snapshot;
    let outcome: Result<AgentOutcome, crate::ai::AiError> = agent::run_agent_loop(
        pool.inner(),
        provider.as_ref(),
        system_prompt,
        &mut history,
        message,
        std::sync::Arc::clone(&on_event_cb),
    )
    .await;

    match outcome {
        Ok(o) => {
            // 写回会话历史（丢弃本轮用户输入为空的会话不变）
            sessions().lock().unwrap().insert(sid.clone(), history);
            on_event_cb(AgentEvent::done {
                rounds: o.rounds,
                prompt_tokens: o.prompt_tokens,
                completion_tokens: o.completion_tokens,
            });
            Ok(serde_json::json!({ "ok": true, "session_id": sid }))
        }
        Err(e) => {
            // 失败也保留历史（用户输入已入列，便于追问重试），但推出 error 事件
            sessions().lock().unwrap().insert(sid.clone(), history);
            on_event_cb(AgentEvent::error {
                message: format!("{}", e),
            });
            Ok(serde_json::json!({ "ok": false, "session_id": sid, "message": format!("{}", e) }))
        }
    }
}

/// 重置（清空）指定会话的历史。
#[tauri::command]
pub async fn ai_agent_reset(session_id: String) -> CmdResult<serde_json::Value> {
    sessions().lock().unwrap().remove(&session_id);
    Ok(serde_json::json!({ "ok": true }))
}

/// 组装 agent system 提示词：基础提示词 + 时间锚点 + 当前上下文
fn build_system_prompt(base: String, context: &Option<serde_json::Value>) -> String {
    let mut prompt = format!("{}\n\n当前时间：{}", base, now());
    if let Some(ctx) = context {
        let current_list = ctx.get("current_list_name").and_then(|v| v.as_str());
        let selected = ctx.get("selected_titles").and_then(|v| v.as_array());
        let mut lines: Vec<String> = Vec::new();
        if let Some(name) = current_list {
            lines.push(format!("用户当前所在清单：{}", name));
        }
        if let Some(titles) = selected {
            let names: Vec<String> = titles
                .iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect();
            if !names.is_empty() {
                lines.push(format!("用户选中的任务：{}", names.join("、")));
            }
        }
        if !lines.is_empty() {
            prompt.push_str("\n\n当前上下文：\n");
            prompt.push_str(&lines.join("\n"));
        }
    }
    prompt
}
