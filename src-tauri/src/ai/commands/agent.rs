// AI 智能体对话命令 —— 多轮工具循环的 IPC 入口
//
// 会话持久化（P3）：agent_sessions/agent_messages 表，重启可续聊。
// 历史查看/续聊/删除由 ai_agent_list_sessions / ai_agent_history /
// ai_agent_delete_session 提供（存储逻辑在 ai/agent_store.rs）。
//
// 详见 discuss/2026-08-15-ai-agent-design.md

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::Emitter;
use tauri::State;

use super::load_prompt;
use crate::ai::agent::{self, AgentOutcome};
use crate::ai::agent_store::{self, DisplayMessage};
use crate::ai::build_from_settings;
use crate::ai::types::{AgentEvent, ChatMessage};
use crate::commands::{now, uuid, CmdResult};

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
/// - `session_id`：None = 开新会话；有值 = 续聊（从表加载历史）
/// - `context`：可选注入的当前上下文，如 { current_list_name: "工作" }
/// - 过程事件经 Channel 推送（delta/tool_start/tool_end/done/error）
/// - 返回 { ok, session_id, message? }
#[tauri::command]
pub async fn ai_agent_chat(
    app: tauri::AppHandle,
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

    // 取（或建）会话：新会话落库（标题取首条消息）；续聊先校验存在
    let is_new_session = session_id.is_none();
    let sid = session_id.unwrap_or_else(uuid);
    let mut is_new = false;
    match agent_store::session_exists(pool.inner(), &sid).await {
        Ok(true) => {}
        Ok(false) if is_new_session => {
            if let Err(e) = agent_store::create_session(pool.inner(), &sid, &message).await {
                return Ok(serde_json::json!({ "ok": false, "message": e }));
            }
            is_new = true;
        }
        Ok(false) => {
            return Ok(serde_json::json!({ "ok": false, "message": "会话不存在或已删除" }));
        }
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": e })),
    }

    // 续聊：从库加载历史（新会话为空）
    let mut history: Vec<ChatMessage> = if is_new {
        Vec::new()
    } else {
        match agent_store::load_history(pool.inner(), &sid).await {
            Ok(h) => h,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "message": e })),
        }
    };
    let baseline = history.len();

    // 组装 system：自定义提示词 + 当前时间锚点 + 上下文注入
    let prompt_tpl = load_prompt(pool.inner(), "ai_prompt_agent", DEFAULT_PROMPT_AGENT).await;
    let system_prompt = build_system_prompt(prompt_tpl, &context);

    // 事件回调：Arc 包裹送进 agent 循环（每轮 clone 进流式闭包）
    let on_event_cb: Arc<dyn Fn(AgentEvent) + Send + Sync> = Arc::new(move |ev: AgentEvent| {
        let _ = on_event.send(ev);
    });

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
            // 发生写操作时通知前端刷新 stores（Pinia 是前端唯一数据源，
            // Rust 直写库后靠此事件同步；与提示音功能的 emit 模式一致）
            if o.mutated {
                let _ = app.emit("ai:data-changed", ());
            }
            // 本轮新增消息落库（失败不阻断返回，仅记录）
            let persist =
                agent_store::append_messages(pool.inner(), &sid, &history[baseline..]).await;
            let _ = agent_store::touch_session(pool.inner(), &sid).await;
            on_event_cb(AgentEvent::done {
                rounds: o.rounds,
                prompt_tokens: o.prompt_tokens,
                completion_tokens: o.completion_tokens,
            });
            let persist_err = persist.err();
            Ok(serde_json::json!({ "ok": true, "session_id": sid, "persist_error": persist_err }))
        }
        Err(e) => {
            // 失败也把已产生的消息落库（用户输入已入列，便于追问重试）
            let _ = agent_store::append_messages(pool.inner(), &sid, &history[baseline..]).await;
            let _ = agent_store::touch_session(pool.inner(), &sid).await;
            on_event_cb(AgentEvent::error {
                message: format!("{}", e),
            });
            Ok(serde_json::json!({ "ok": false, "session_id": sid, "message": format!("{}", e) }))
        }
    }
}

/// 历史会话列表（按最后活动倒序，最多 50 条）。
/// 返回 { ok, sessions: [{ id, title, updated_at, message_count }] }。
#[tauri::command]
pub async fn ai_agent_list_sessions(
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<serde_json::Value> {
    match agent_store::list_sessions(pool.inner()).await {
        Ok(list) => Ok(serde_json::json!({ "ok": true, "sessions": list })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": e })),
    }
}

/// 单个会话的完整消息（展示格式，含工具步骤）。返回 { ok, title, messages }。
#[tauri::command]
pub async fn ai_agent_history(
    pool: State<'_, sqlx::SqlitePool>,
    session_id: String,
) -> CmdResult<serde_json::Value> {
    let title = match agent_store::session_title(pool.inner(), &session_id).await {
        Ok(Some(t)) => t,
        Ok(None) => return Ok(serde_json::json!({ "ok": false, "message": "会话不存在" })),
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": e })),
    };
    let msgs: Vec<DisplayMessage> =
        match agent_store::load_display_messages(pool.inner(), &session_id).await {
            Ok(m) => m,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "message": e })),
        };
    Ok(serde_json::json!({ "ok": true, "title": title, "messages": msgs }))
}

/// 删除会话（消息级联删除）。返回 { ok }。
#[tauri::command]
pub async fn ai_agent_delete_session(
    pool: State<'_, sqlx::SqlitePool>,
    session_id: String,
) -> CmdResult<serde_json::Value> {
    match agent_store::delete_session(pool.inner(), &session_id).await {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": e })),
    }
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
