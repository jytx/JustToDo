// AI 文本润色（支持流式）—— 用于任务备注/笔记正文的表达优化

use tauri::ipc::Channel;
use tauri::State;

use super::load_prompt;
use crate::ai::types::StreamChunk;
use crate::ai::{build_from_settings, ChatMessage, ChatRequest, ToolChoice};
use crate::commands::CmdResult;

/// AI 文本润色的默认系统提示词。
/// 指导模型优化中文表达：修正语病、理顺逻辑、提升可读性，同时保留原意和 HTML 标签结构。
pub const DEFAULT_PROMPT_POLISH: &str = r#"你是一个专业的中文文本润色助手。用户会给你一段文本（可能含 HTML 标签），你需要润色后返回。

润色规则：
1. 修正语病、错别字、标点错误
2. 理顺句子逻辑，优化表达，使文字更流畅、更专业
3. 保持原文的核心意思和风格不变，不要增删实质内容
4. **必须保留原有的 HTML 标签结构**（如 <p>、<strong>、<ul>、<li>、<h2> 等），只润色标签内的文字
5. 如果原文是纯文本（无 HTML 标签），返回纯文本
6. 直接输出润色后的完整文本，不要加任何解释说明"#;

/// AI 文本润色命令（支持流式）。
/// 参数 text: 要润色的文本（纯文本或 HTML）。
/// 返回 { ok, content }（content 为润色后的文本）。
#[tauri::command]
pub async fn ai_polish_text(
    pool: State<'_, sqlx::SqlitePool>,
    text: String,
    on_event: Channel<StreamChunk>,
) -> CmdResult<serde_json::Value> {
    let provider = match build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    };

    let prompt_tpl = load_prompt(pool.inner(), "ai_prompt_polish", DEFAULT_PROMPT_POLISH).await;

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system {
                content: prompt_tpl,
            },
            ChatMessage::user { content: text },
        ],
        // 纯文本润色不需要工具调用
        tool_choice: ToolChoice::None,
        ..Default::default()
    };

    // 流式调用：每收到 delta 通过 Channel 推给前端
    let on_delta = Box::new(move |delta: &str| {
        let _ = on_event.send(StreamChunk {
            delta: Some(delta.to_string()),
            done: false,
        });
    });
    match provider.chat_stream(&req, on_delta).await {
        Ok(resp) => Ok(serde_json::json!({ "ok": true, "content": resp.content })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    }
}
