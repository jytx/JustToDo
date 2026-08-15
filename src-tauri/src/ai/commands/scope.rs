// AI 总结（清单/目录/多选，通用 scope）
// 详见 discuss/2026-07-31-ai-summary-scope-design.md

use tauri::ipc::Channel;
use tauri::State;

use super::{load_prompt, priority_label};
use crate::ai::types::StreamChunk;
use crate::ai::{build_from_settings, ChatMessage, ChatRequest};
use crate::commands::{get_setting_inner, row_to_task, CmdResult};
use crate::models::Task;

pub const DEFAULT_PROMPT_LIST: &str = r#"你是一个温暖、专业的任务总结助手。请根据用户提供的任务列表，生成一份简洁的中文 Markdown 总结。

要求：
1. 用 Markdown 格式输出，包含以下部分（用二级标题）：
   - 「概览」：任务总数、完成情况
   - 「重点任务」：挑出最重要的几项（高优先级、即将截止的）
   - 「小结」：1-2 句总结性、鼓励性的话
2. 语气积极、专业
3. 不要编造数据，只基于提供的任务
4. 语言简洁，控制在 300 字以内"#;

/// 多选总结默认提示词（与清单/目录相同，但用户可独立定制）
pub const DEFAULT_PROMPT_TASKS: &str = DEFAULT_PROMPT_LIST;

pub const DEFAULT_PROMPT_NOTE: &str = r#"你是一个专业的笔记摘要助手。请根据用户提供的笔记列表，生成一份简洁的中文 Markdown 摘要。

要求：
1. 用 Markdown 格式输出，包含以下部分（用二级标题）：
   - 「笔记概览」：笔记数量、整体主题
   - 「要点提炼」：每篇笔记的核心要点（1-2 句）
   - 「小结」：这些笔记之间的关联或整体价值
2. 语气客观、专业
3. 不要编造内容，只基于提供的笔记
4. 语言简洁，控制在 400 字以内"#;

struct ScopeData {
    tasks: Vec<Task>,
    kind: String,
}

/// 按 scope 查询任务数据。scope: {type:"list",id} | {type:"folder",id} | {type:"tasks",ids}
async fn query_scope_data(
    pool: &sqlx::SqlitePool,
    scope: &serde_json::Value,
) -> Result<ScopeData, String> {
    let scope_type = scope.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match scope_type {
        "list" => {
            let id = scope.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind: String = sqlx::query_scalar("SELECT kind FROM lists WHERE id = $1")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("查询清单类型失败: {}", e))?
                .unwrap_or_else(|| "task".into());
            let rows = sqlx::query(
                "SELECT * FROM tasks WHERE list_id = $1 AND parent_id IS NULL ORDER BY done ASC, sort_order ASC",
            ).bind(id).fetch_all(pool).await
                .map_err(|e| format!("查询清单任务失败: {}", e))?;
            Ok(ScopeData {
                tasks: rows.iter().map(row_to_task).collect(),
                kind,
            })
        }
        "folder" => {
            let id = scope.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind: String = sqlx::query_scalar("SELECT kind FROM lists WHERE id = $1")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("查询目录类型失败: {}", e))?
                .unwrap_or_else(|| "task".into());
            let rows = sqlx::query(
                "WITH RECURSIVE subtree(id, is_folder) AS (
                     SELECT id, is_folder FROM lists WHERE id = $1
                     UNION ALL
                     SELECT l.id, l.is_folder FROM lists l JOIN subtree s ON l.parent_id = s.id
                 )
                 SELECT t.* FROM tasks t
                 WHERE t.parent_id IS NULL
                   AND t.list_id IN (SELECT id FROM subtree WHERE is_folder = 0)
                 ORDER BY t.done ASC, t.sort_order ASC",
            )
            .bind(id)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询目录任务失败: {}", e))?;
            Ok(ScopeData {
                tasks: rows.iter().map(row_to_task).collect(),
                kind,
            })
        }
        "tasks" => {
            let ids: Vec<String> = scope
                .get("ids")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if ids.is_empty() {
                return Ok(ScopeData {
                    tasks: vec![],
                    kind: "task".into(),
                });
            }
            let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("${}", i)).collect();
            let sql = format!(
                "SELECT * FROM tasks WHERE id IN ({}) ORDER BY done ASC, priority DESC",
                placeholders.join(", ")
            );
            let mut q = sqlx::query(&sql);
            for id in &ids {
                q = q.bind(id);
            }
            let rows = q
                .fetch_all(pool)
                .await
                .map_err(|e| format!("查询选中任务失败: {}", e))?;
            let tasks: Vec<Task> = rows.iter().map(row_to_task).collect();
            let kind = tasks
                .first()
                .map(|t| t.kind.clone())
                .unwrap_or_else(|| "task".into());
            Ok(ScopeData { tasks, kind })
        }
        _ => Err(format!("未知的 scope 类型: {}", scope_type)),
    }
}

/// 智能裁剪：任务数超过阈值时，保留「未完成优先 + 高优先级优先」的前 N 个。
fn truncate_tasks(tasks: Vec<Task>, limit: usize) -> (Vec<Task>, bool) {
    if tasks.len() <= limit {
        return (tasks, false);
    }
    let mut sorted = tasks;
    sorted.sort_by(|a, b| b.done.cmp(&a.done).then(b.priority.cmp(&a.priority)));
    sorted.truncate(limit);
    (sorted, true)
}

/// 通用 AI 总结命令（清单/目录/多选）。返回 { ok, content, count, kind, truncated }。
#[tauri::command]
pub async fn ai_summary_scope(
    pool: State<'_, sqlx::SqlitePool>,
    scope: serde_json::Value,
    truncate: Option<bool>,
    on_event: Channel<StreamChunk>,
) -> CmdResult<serde_json::Value> {
    let provider = match build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    };

    let data = match query_scope_data(pool.inner(), &scope).await {
        Ok(d) => d,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": e })),
    };
    let original_count = data.tasks.len();

    // 空范围短路：没有任务/笔记时不调 AI，直接返回提示（省 token、反馈快）
    if original_count == 0 {
        let hint = if data.kind == "note" {
            "该范围暂无笔记，无需生成摘要"
        } else {
            "该范围暂无任务，无需生成总结"
        };
        return Ok(serde_json::json!({ "ok": false, "message": hint, "empty": true }));
    }

    let (tasks, truncated) = if truncate == Some(true) {
        let threshold = get_setting_inner(pool.inner(), "ai_summary_truncate_threshold".into())
            .await
            .ok()
            .and_then(|v| v.and_then(|s| s.parse::<usize>().ok()))
            .filter(|n| *n > 0)
            .unwrap_or(50);
        truncate_tasks(data.tasks, threshold)
    } else {
        (data.tasks, false)
    };

    // 读提示词：note 用笔记摘要提示词；task 按 scope.type 区分清单/多选提示词
    let scope_type = scope.get("type").and_then(|v| v.as_str()).unwrap_or("list");
    let (system_prompt, payload) = if data.kind == "note" {
        let p = load_prompt(pool.inner(), "ai_prompt_note", DEFAULT_PROMPT_NOTE).await;
        build_note_prompt(&tasks, p)
    } else if scope_type == "tasks" {
        let p = load_prompt(pool.inner(), "ai_prompt_tasks", DEFAULT_PROMPT_TASKS).await;
        build_task_summary_prompt(&tasks, p)
    } else {
        let p = load_prompt(pool.inner(), "ai_prompt_list", DEFAULT_PROMPT_LIST).await;
        build_task_summary_prompt(&tasks, p)
    };

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system {
                content: system_prompt,
            },
            ChatMessage::user {
                content: payload.to_string(),
            },
        ],
        ..Default::default()
    };

    // 流式调用：每收到 delta 通过 Channel 推给前端，结束后返回完整 content
    let on_delta = Box::new(move |delta: &str| {
        let _ = on_event.send(StreamChunk {
            delta: Some(delta.to_string()),
            done: false,
        });
    });
    match provider.chat_stream(&req, on_delta).await {
        Ok(resp) => Ok(serde_json::json!({
            "ok": true, "content": resp.content,
            "count": original_count, "kind": data.kind, "truncated": truncated,
        })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    }
}

/// 组装「任务总结」prompt。system_prompt 由调用方读设置传入（支持自定义）。
fn build_task_summary_prompt(tasks: &[Task], system_prompt: String) -> (String, serde_json::Value) {
    let payload = serde_json::json!({
        "任务列表": tasks.iter().map(|t| serde_json::json!({
            "标题": t.title,
            "状态": if t.done { "已完成" } else { "未完成" },
            "优先级": priority_label(t.priority),
            "截止": t.due_end_at,
        })).collect::<Vec<_>>(),
        "任务总数": tasks.len(),
    });
    (system_prompt, payload)
}

/// 组装「笔记摘要」prompt。system_prompt 由调用方读设置传入。
fn build_note_prompt(tasks: &[Task], system_prompt: String) -> (String, serde_json::Value) {
    let payload = serde_json::json!({
        "笔记列表": tasks.iter().map(|t| serde_json::json!({
            "标题": t.title,
            "正文摘要": strip_html(&t.note).chars().take(200).collect::<String>(),
        })).collect::<Vec<_>>(),
        "笔记总数": tasks.len(),
    });
    (system_prompt, payload)
}

/// 粗略去除 HTML 标签得到纯文本（供笔记摘要省 token）。
pub(crate) fn strip_html(html: &str) -> String {
    if !html.contains('<') {
        return html.to_string();
    }
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
