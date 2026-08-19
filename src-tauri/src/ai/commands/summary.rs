// AI 每日小结 / 周报命令
// 详见 discuss/2026-07-31-ai-daily-summary-design.md

use chrono::Datelike;
use tauri::ipc::Channel;
use tauri::State;

use super::{load_prompt, priority_label};
use crate::ai::types::StreamChunk;
use crate::ai::{build_from_settings, ChatMessage, ChatRequest};
use crate::commands::{row_to_task, CmdResult};
use crate::models::Task;

/// 计算「本周一 00:00」的本地时间字面量（周一为一周开始）。
/// chrono 的 Weekday::Mon，days_from_monday() 周一=0...周日=6。
fn start_of_week_local() -> chrono::NaiveDateTime {
    let now = chrono::Local::now().naive_local();
    let today = now.date();
    // 往前退到本周一：减去"今天距周一的天数"
    let monday = today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64);
    monday.and_hms_opt(0, 0, 0).unwrap()
}

/// 把 NaiveDateTime 格式化为本地字面量（与 DB 存储格式一致）
fn fmt_local(dt: chrono::NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// AI 总结默认提示词（用户可在设置页自定义，存 app_settings）。
/// smart 提示词支持 {mode} 占位符（运行时替换为「今日」/「本周」）。
pub const DEFAULT_PROMPT_SMART: &str = r#"你是一个温暖、专业的任务总结助手。请根据用户{mode}的任务数据，生成一份简洁的中文 Markdown 小结。

要求：
1. 用 Markdown 格式输出，包含以下部分（用二级标题）：
   - 「{mode}完成」：列出已完成的主要任务，肯定用户的努力
   - 「待办提醒」：列出需要关注的事项（如果有），按紧急程度排序
   - 「小结」：1-2 句鼓励性的总结
2. 语气积极、鼓励，让用户有成就感
3. 如果某部分没有数据，简要说明（例如：今天暂无逾期待办，很棒！）
4. 不要编造数据，只基于提供的任务
5. 语言简洁，控制在 300 字以内"#;

/// 每日小结 / 周报的 AI 总结命令。
///
/// 流程：算时间范围 → 查已完成 + 待办 → 组装 prompt → 调 AI → 返回 Markdown。
/// 返回 `{ ok, content }`（成功）或 `{ ok: false, message }`（失败，前端不走 catch）。
///
/// mode: "daily"（今天）| "weekly"（本周一到本周日）
#[tauri::command]
pub async fn ai_summary(
    pool: State<'_, sqlx::SqlitePool>,
    mode: String,
    on_event: Channel<StreamChunk>,
) -> CmdResult<serde_json::Value> {
    // 1. 构造 provider（内部校验 enabled / key / 地址 / 模型）
    let provider = match build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => {
            return Ok(serde_json::json!({
                "ok": false,
                "message": format!("{}", e),
            }));
        }
    };

    // 2. 计算时间范围（本地字面量）
    let now_dt = chrono::Local::now().naive_local();
    let (start, end, mode_label) = if mode == "weekly" {
        let monday = start_of_week_local();
        let next_monday = monday + chrono::Duration::days(7);
        (fmt_local(monday), fmt_local(next_monday), "本周")
    } else {
        let today_start = now_dt.date().and_hms_opt(0, 0, 0).unwrap();
        let tomorrow_start = today_start + chrono::Duration::days(1);
        (fmt_local(today_start), fmt_local(tomorrow_start), "今日")
    };
    let end_of_today =
        fmt_local(now_dt.date().and_hms_opt(0, 0, 0).unwrap() + chrono::Duration::days(1));

    // 3. 查数据：已完成任务（按 completed_at；deleted_at IS NULL 排除回收站任务）
    let completed_rows = match sqlx::query(
        "SELECT * FROM tasks
         WHERE done = 1 AND parent_id IS NULL AND kind = 'task'
           AND deleted_at IS NULL
           AND completed_at IS NOT NULL
           AND datetime(replace(completed_at, 'T', ' '), 'localtime') >= datetime($1, 'localtime')
           AND datetime(replace(completed_at, 'T', ' '), 'localtime') <  datetime($2, 'localtime')
         ORDER BY completed_at DESC",
    )
    .bind(&start)
    .bind(&end)
    .fetch_all(pool.inner())
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(serde_json::json!({
                "ok": false,
                "message": format!("查询已完成任务失败: {}", e),
            }));
        }
    };
    let completed: Vec<Task> = completed_rows.iter().map(row_to_task).collect();

    // 4. 查数据：今天截止 / 逾期的未完成任务（每日和周报都包含，作为"待办提醒"；
    //    deleted_at IS NULL 排除回收站任务）
    let todo_rows = match sqlx::query(
        "SELECT * FROM tasks
         WHERE parent_id IS NULL AND done = 0 AND kind = 'task'
           AND deleted_at IS NULL
           AND due_end_at IS NOT NULL
           AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($1, 'localtime')
         ORDER BY due_end_at ASC, priority DESC",
    )
    .bind(&end_of_today)
    .fetch_all(pool.inner())
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(serde_json::json!({
                "ok": false,
                "message": format!("查询待办任务失败: {}", e),
            }));
        }
    };
    let todos: Vec<Task> = todo_rows.iter().map(row_to_task).collect();

    // 5. 组装 prompt（精简字段，避免 token 浪费）
    let payload = serde_json::json!({
        "范围": mode_label,
        "已完成任务": completed.iter().map(|t| serde_json::json!({
            "标题": t.title,
            "优先级": priority_label(t.priority),
        })).collect::<Vec<_>>(),
        "已完成数量": completed.len(),
        "待办任务（今天截止或逾期）": todos.iter().map(|t| serde_json::json!({
            "标题": t.title,
            "优先级": priority_label(t.priority),
            "截止": t.due_end_at,
        })).collect::<Vec<_>>(),
        "待办数量": todos.len(),
    });

    // 提示词读设置（用户可自定义），{mode} 占位符替换为「今日」/「本周」。
    let prompt_tpl = load_prompt(pool.inner(), "ai_prompt_smart", DEFAULT_PROMPT_SMART).await;
    let system_prompt = prompt_tpl.replace("{mode}", mode_label);

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

    // 流式调用：每收到 delta 通过 Channel 推给前端。
    // 流结束时 invoke 自动 resolve（返回完整 content），前端据此切到完成态，无需单独 done 帧。
    let on_delta = Box::new(move |delta: &str| {
        let _ = on_event.send(StreamChunk {
            delta: Some(delta.to_string()),
            done: false,
        });
    });
    match provider.chat_stream(&req, on_delta).await {
        Ok(resp) => Ok(serde_json::json!({
            "ok": true,
            "content": resp.content,
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "message": format!("{}", e),
        })),
    }
}
