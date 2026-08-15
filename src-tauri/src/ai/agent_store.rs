// AI Agent 会话持久化层 —— agent_sessions / agent_messages 表读写
//
// 职责（详见 discuss/2026-08-15-ai-agent-design.md P3）：
// - 会话 CRUD（列表/建/删；标题自动取首条用户消息前 30 字）
// - ChatMessage 落库 / 还原（system 不存，每轮动态拼）
// - 展示格式转换：assistant 消息的 tool_calls 与 tool 结果行配对成工具步骤
//   （前端历史渲染直接可用，不依赖事件流）

use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use sqlx::SqlitePool;

use crate::ai::types::{ChatMessage, ToolCall};
use crate::commands::{now, uuid};

/// 会话摘要（历史列表用）。字段 camelCase 与前端 TS 类型对齐
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub message_count: i64,
}

/// 工具步骤（展示格式；与前端 types/agent.ts 的 ToolStep 对应）。
/// call_id 序列化为 callId，与前端 ToolStep 对齐
#[derive(Serialize)]
pub struct DisplayToolStep {
    #[serde(rename = "callId")]
    pub call_id: String,
    pub name: String,
    pub args: Value,
    pub ok: bool,
    pub summary: String,
}

/// 展示消息（历史渲染用；assistant 消息携带工具步骤序列）
#[derive(Serialize)]
pub struct DisplayMessage {
    pub role: String,
    pub content: String,
    pub tools: Vec<DisplayToolStep>,
}

// ─── 会话 CRUD ────────────────────────────────────────────

/// 新建会话（标题 = 首条用户消息前 30 字，超长截断加省略号）
pub async fn create_session(
    pool: &SqlitePool,
    id: &str,
    first_message: &str,
) -> Result<(), String> {
    let title: String = first_message.chars().take(30).collect();
    let title = if first_message.chars().count() > 30 {
        format!("{}…", title)
    } else {
        title
    };
    let ts = now();
    sqlx::query(
        "INSERT INTO agent_sessions (id, title, created_at, updated_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(&title)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await
    .map_err(|e| format!("创建会话失败: {}", e))?;
    Ok(())
}

/// 会话是否存在（续聊前校验，FK 保护）
pub async fn session_exists(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_sessions WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .map(|n| n > 0)
        .map_err(|e| format!("查询会话失败: {}", e))
}

/// 更新会话最后活动时间（每轮对话后调用，列表按此排序）
pub async fn touch_session(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("UPDATE agent_sessions SET updated_at = $1 WHERE id = $2")
        .bind(now())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("更新会话时间失败: {}", e))?;
    Ok(())
}

/// 删除会话（消息经 CASCADE 级联删除）
pub async fn delete_session(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM agent_sessions WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("删除会话失败: {}", e))?;
    Ok(())
}

/// 会话列表（按最后活动倒序，默认 50 条）
pub async fn list_sessions(pool: &SqlitePool) -> Result<Vec<SessionSummary>, String> {
    let rows = sqlx::query(
        "SELECT s.id, s.title, s.updated_at,
                (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id) AS message_count
         FROM agent_sessions s
         ORDER BY s.updated_at DESC
         LIMIT 50",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询会话列表失败: {}", e))?;
    Ok(rows
        .iter()
        .map(|r| SessionSummary {
            id: r.get("id"),
            title: r.get("title"),
            updated_at: r.get("updated_at"),
            message_count: r.get("message_count"),
        })
        .collect())
}

// ─── 消息落库 / 还原 ──────────────────────────────────────

/// 把一批 ChatMessage 追加到会话（system 跳过；assistant 的 tool_calls 序列化为 JSON 列）
pub async fn append_messages(
    pool: &SqlitePool,
    session_id: &str,
    msgs: &[ChatMessage],
) -> Result<(), String> {
    // 会话内 seq 递增（同秒写入的多条消息靠它保序）
    let mut seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) FROM agent_messages WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("查询消息序号失败: {}", e))?;
    for m in msgs {
        seq += 1;
        let (role, content, tool_calls, tool_call_id) = match m {
            ChatMessage::system { .. } => continue, // system 每轮动态拼，不落库
            ChatMessage::user { content } => ("user", content.clone(), None, None),
            ChatMessage::assistant {
                content,
                tool_calls,
            } => {
                let tc = if tool_calls.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(tool_calls).unwrap_or_else(|_| "[]".into()))
                };
                ("assistant", content.clone(), tc, None)
            }
            ChatMessage::tool {
                tool_call_id,
                content,
            } => ("tool", content.clone(), None, Some(tool_call_id.clone())),
        };
        sqlx::query(
            "INSERT INTO agent_messages (id, session_id, seq, role, content, tool_calls, tool_call_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(uuid())
        .bind(session_id)
        .bind(seq)
        .bind(role)
        .bind(&content)
        .bind(&tool_calls)
        .bind(&tool_call_id)
        .bind(now())
        .execute(pool)
        .await
        .map_err(|e| format!("保存会话消息失败: {}", e))?;
    }
    Ok(())
}

/// 读会话消息行（按会话内 seq 排序——同秒写入的消息 created_at 相同秒精度，
/// 按 id（uuid 随机）排序会导致工具轮与最终答复随机互换，续聊上下文损坏）
async fn load_rows(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, String> {
    sqlx::query(
        "SELECT role, content, tool_calls, tool_call_id FROM agent_messages
         WHERE session_id = $1 ORDER BY seq ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取会话消息失败: {}", e))
}

/// 还原会话历史为 ChatMessage 列表（喂给 agent 循环续聊）
pub async fn load_history(pool: &SqlitePool, session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let rows = load_rows(pool, session_id).await?;
    let mut msgs: Vec<ChatMessage> = Vec::new();
    for r in &rows {
        let role: String = r.get("role");
        let content: String = r.get("content");
        match role.as_str() {
            "user" => msgs.push(ChatMessage::user { content }),
            "assistant" => {
                let tc_json: Option<String> = r.get("tool_calls");
                let tool_calls: Vec<ToolCall> = tc_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
                msgs.push(ChatMessage::assistant {
                    content,
                    tool_calls,
                });
            }
            "tool" => {
                let tool_call_id: String = r
                    .get::<Option<String>, _>("tool_call_id")
                    .unwrap_or_default();
                msgs.push(ChatMessage::tool {
                    tool_call_id,
                    content,
                });
            }
            _ => {}
        }
    }
    Ok(msgs)
}

/// 读会话消息为展示格式（前端历史渲染用）。
/// assistant 行的 tool_calls 与其后的 tool 结果行（按 tool_call_id 配对）
/// 合并为一条消息的工具步骤；tool 行本身不再单独输出。
pub async fn load_display_messages(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<DisplayMessage>, String> {
    let rows = load_rows(pool, session_id).await?;
    // 先收集 tool 结果：call_id → (ok, summary)
    let mut tool_results: std::collections::HashMap<String, (bool, String)> =
        std::collections::HashMap::new();
    for r in &rows {
        if r.get::<String, _>("role") != "tool" {
            continue;
        }
        let call_id: String = r
            .get::<Option<String>, _>("tool_call_id")
            .unwrap_or_default();
        let content: String = r.get("content");
        if let Ok(v) = serde_json::from_str::<Value>(&content) {
            tool_results.insert(
                call_id,
                (
                    v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
                    v.get("summary")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                ),
            );
        }
    }
    // 组装展示消息
    let mut out: Vec<DisplayMessage> = Vec::new();
    for r in &rows {
        let role: String = r.get("role");
        let content: String = r.get("content");
        match role.as_str() {
            "user" => out.push(DisplayMessage {
                role: "user".into(),
                content,
                tools: vec![],
            }),
            "assistant" => {
                let tc_json: Option<String> = r.get("tool_calls");
                let calls: Vec<ToolCall> = tc_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
                let tools = calls
                    .iter()
                    .map(|c| {
                        let (ok, summary) = tool_results
                            .get(&c.id)
                            .cloned()
                            .unwrap_or((false, "（结果缺失）".into()));
                        DisplayToolStep {
                            call_id: c.id.clone(),
                            name: c.name.clone(),
                            args: c.arguments.clone(),
                            ok,
                            summary,
                        }
                    })
                    .collect();
                out.push(DisplayMessage {
                    role: "assistant".into(),
                    content,
                    tools,
                });
            }
            _ => {} // tool 行已并入上一条 assistant 的步骤
        }
    }
    Ok(out)
}

/// 会话标题（切换会话时前端展示用）
pub async fn session_title(pool: &SqlitePool, session_id: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar::<_, String>("SELECT title FROM agent_sessions WHERE id = $1")
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询会话标题失败: {}", e))
}
