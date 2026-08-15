// AI Agent 写工具实现（建任务/建笔记/更新/完成）
//
// 安全约定：
// - 不提供删除类操作（第一版铁律）
// - 成功返回带 "mutated": true —— agent 循环据此置位，命令层统一 emit ai:data-changed
// - 名称 → ID 解析失败返回明确错误（模型自纠）；标签不存在时自动创建

use serde_json::{json, Value};
use sqlx::SqlitePool;

use super::resolve_list_id;
use crate::commands::{now, uuid};

/// 收件箱固定 id（与预置数据一致；未指定清单时任务落这里）
const INBOX_ID: &str = "inbox";
/// 默认笔记本固定 id
const DEFAULT_NOTEBOOK_ID: &str = "default-notebook";
/// 工具自动创建标签的默认颜色（靛蓝，主题强调色）
const TAG_DEFAULT_COLOR: &str = "#6366F1";

/// 写工具分发入口（由 tool_exec::execute 调用）
pub(crate) async fn dispatch(pool: &SqlitePool, name: &str, args: &Value) -> Value {
    match name {
        "create_task" => create_task(pool, args).await,
        "create_note" => create_note(pool, args).await,
        "update_task" => update_task(pool, args).await,
        "set_task_done" => set_task_done(pool, args).await,
        _ => json!({ "ok": false, "error": format!("未知写工具: {}", name) }),
    }
}

// ─── 日期解析：模型输出的 due 字符串 → (due_start_at, due_end_at) ──

/// 解析 due 参数。支持：
/// - 相对词：today / tomorrow
/// - 纯日期 YYYY-MM-DD → 全天（end 为当天 23:59:59，start 不设）
/// - 日期时间 YYYY-MM-DDTHH:mm(:ss) → start=end=该时刻
fn parse_due(v: &Value) -> Result<(Option<String>, Option<String>), String> {
    let s = v
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("due 格式应为字符串")?;
    let today = chrono::Local::now().naive_local().date();
    let day = match s {
        "today" => today,
        "tomorrow" => today + chrono::Duration::days(1),
        _ => {
            // 纯日期或日期时间两种
            let date_part = s.split('T').next().unwrap_or(s);
            let d = chrono::NaiveDate::parse_from_str(date_part, "%Y-%m-%d")
                .map_err(|_| format!("无法解析日期「{}」，应为 YYYY-MM-DD 或 today/tomorrow", s))?;
            if s.contains('T') {
                // 带时间：补齐秒，start=end
                let mut t = s.to_string();
                if t.len() == 16 {
                    t.push_str(":00");
                }
                return Ok((Some(t.clone()), Some(t)));
            }
            d
        }
    };
    let fmt = day.format("%Y-%m-%d").to_string();
    Ok((None, Some(format!("{}T23:59:59", fmt))))
}

/// 取清单 id：给了名字则解析（kind 区分清单/笔记本），否则用默认（收件箱/默认笔记本）
async fn resolve_target_list(
    pool: &SqlitePool,
    name: Option<&str>,
    kind: &str,
    fallback_id: &str,
) -> Result<String, String> {
    match name {
        Some(n) => match resolve_list_id(pool, n, kind).await? {
            Some(id) => Ok(id),
            None => Err(format!(
                "未找到名为「{}」的{}",
                n,
                if kind == "note" {
                    "笔记本"
                } else {
                    "清单"
                }
            )),
        },
        None => Ok(fallback_id.to_string()),
    }
}

/// 绑定标签：按名查（无则创建），写入 task_tags。返回标签名列表（summary 用）
async fn attach_tags(pool: &SqlitePool, task_id: &str, names: &[String]) -> Result<(), String> {
    for name in names {
        let n = name.trim();
        if n.is_empty() {
            continue;
        }
        // 查已有；没有则创建（默认色，与用户手动建标签同表结构）
        let tag_id: Option<String> = sqlx::query_scalar("SELECT id FROM tags WHERE name = $1")
            .bind(n)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("查询标签失败: {}", e))?;
        let tag_id = match tag_id {
            Some(id) => id,
            None => {
                let id = uuid();
                sqlx::query(
                    "INSERT INTO tags (id, name, created_at, color) VALUES ($1, $2, $3, $4)",
                )
                .bind(&id)
                .bind(n)
                .bind(now())
                .bind(TAG_DEFAULT_COLOR)
                .execute(pool)
                .await
                .map_err(|e| format!("创建标签失败: {}", e))?;
                id
            }
        };
        sqlx::query("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES ($1, $2)")
            .bind(task_id)
            .bind(&tag_id)
            .execute(pool)
            .await
            .map_err(|e| format!("绑定标签失败: {}", e))?;
    }
    Ok(())
}

/// 参数里取字符串数组（tag_names）
fn str_array(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// ─── create_task ──────────────────────────────────────────

async fn create_task(pool: &SqlitePool, args: &Value) -> Value {
    let title = match args
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(t) => t.to_string(),
        None => return json!({ "ok": false, "error": "缺少任务标题 title" }),
    };

    // 清单：未指定落收件箱；指定则按名解析
    let list_id = match resolve_target_list(
        pool,
        args.get("list_name").and_then(|v| v.as_str()),
        "task",
        INBOX_ID,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => return json!({ "ok": false, "error": e }),
    };

    // 子任务：指定 parent 时校验存在并继承其 list_id（子任务与父同清单）
    let (parent_id, list_id) = match args.get("parent_task_id").and_then(|v| v.as_str()) {
        Some(pid) => {
            match sqlx::query_scalar::<_, String>("SELECT list_id FROM tasks WHERE id = $1")
                .bind(pid)
                .fetch_optional(pool)
                .await
            {
                Ok(Some(parent_list)) => (Some(pid.to_string()), parent_list),
                Ok(None) => {
                    return json!({ "ok": false, "error": "parent_task_id 对应的任务不存在" })
                }
                Err(e) => return json!({ "ok": false, "error": format!("查询父任务失败: {}", e) }),
            }
        }
        None => (None, list_id),
    };

    let priority = args.get("priority").and_then(|v| v.as_i64()).unwrap_or(0);
    let (due_start, due_end) = match args.get("due") {
        Some(v) if !v.is_null() => match parse_due(v) {
            Ok(d) => d,
            Err(e) => return json!({ "ok": false, "error": e }),
        },
        _ => (None, None),
    };

    let id = uuid();
    let ts = now();
    // 排到清单末尾（同清单根任务最大 sort_order + 1000）
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), 0) FROM tasks WHERE list_id = $1 AND parent_id IS NULL",
    )
    .bind(&list_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
        + 1000;

    let note = args.get("note_html").and_then(|v| v.as_str()).unwrap_or("");
    let ins = sqlx::query(
        "INSERT INTO tasks (id, title, note, list_id, parent_id, priority, due_start_at, due_end_at, done, sort_order, created_at, updated_at, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, 'task')",
    )
    .bind(&id)
    .bind(&title)
    .bind(note)
    .bind(&list_id)
    .bind(&parent_id)
    .bind(priority)
    .bind(&due_start)
    .bind(&due_end)
    .bind(sort_order)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await;

    match ins {
        Ok(_) => {
            let tag_names = str_array(args, "tag_names");
            if let Err(e) = attach_tags(pool, &id, &tag_names).await {
                return json!({ "ok": false, "error": format!("任务已创建但绑定标签失败: {}", e) });
            }
            json!({
                "ok": true, "mutated": true,
                "summary": format!("已创建任务「{}」", title),
                "data": { "id": id, "title": title, "list_id": list_id }
            })
        }
        Err(e) => json!({ "ok": false, "error": format!("创建任务失败: {}", e) }),
    }
}

// ─── create_note ──────────────────────────────────────────

async fn create_note(pool: &SqlitePool, args: &Value) -> Value {
    let title = match args
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(t) => t.to_string(),
        None => return json!({ "ok": false, "error": "缺少笔记标题 title" }),
    };
    let list_id = match resolve_target_list(
        pool,
        args.get("notebook_name").and_then(|v| v.as_str()),
        "note",
        DEFAULT_NOTEBOOK_ID,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => return json!({ "ok": false, "error": e }),
    };

    let id = uuid();
    let ts = now();
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), 0) FROM tasks WHERE list_id = $1 AND parent_id IS NULL",
    )
    .bind(&list_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
        + 1000;

    let content = args
        .get("content_html")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let ins = sqlx::query(
        "INSERT INTO tasks (id, title, note, list_id, priority, done, sort_order, created_at, updated_at, kind)
         VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7, 'note')",
    )
    .bind(&id)
    .bind(&title)
    .bind(content)
    .bind(&list_id)
    .bind(sort_order)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await;

    match ins {
        Ok(_) => {
            let tag_names = str_array(args, "tag_names");
            if let Err(e) = attach_tags(pool, &id, &tag_names).await {
                return json!({ "ok": false, "error": format!("笔记已创建但绑定标签失败: {}", e) });
            }
            json!({
                "ok": true, "mutated": true,
                "summary": format!("已创建笔记「{}」", title),
                "data": { "id": id, "title": title }
            })
        }
        Err(e) => json!({ "ok": false, "error": format!("创建笔记失败: {}", e) }),
    }
}

// ─── update_task ──────────────────────────────────────────

async fn update_task_impl(pool: &SqlitePool, args: &Value) -> Result<Value, String> {
    let task_id = match args.get("task_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Ok(json!({ "ok": false, "error": "缺少 task_id" })),
    };
    // 任务存在性校验（顺带取标题用于 summary）
    let title: Option<String> = match sqlx::query_scalar("SELECT title FROM tasks WHERE id = $1")
        .bind(&task_id)
        .fetch_optional(pool)
        .await
    {
        Ok(t) => t,
        Err(e) => return Err(format!("查询任务失败: {}", e)),
    };
    let old_title = match title {
        Some(t) => t,
        None => return Ok(json!({ "ok": false, "error": "task_id 对应的任务不存在" })),
    };

    let ts = now();
    // 逐字段更新（Some 才更新；due 显式传 null 表示清空日期）。
    // 单字段失败立即返回（错误回传模型自纠），成功的字段名收集进 summary
    let mut updated: Vec<String> = Vec::new();
    let set_sql = "UPDATE tasks SET {col} = $1, updated_at = $2 WHERE id = $3";

    if let Some(t) = args
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|t| !t.trim().is_empty())
    {
        let sql = set_sql.replace("{col}", "title");
        sqlx::query(&sql)
            .bind(t.trim())
            .bind(&ts)
            .bind(&task_id)
            .execute(pool)
            .await
            .map_err(|e| format!("更新标题失败: {}", e))?;
        updated.push("标题".into());
    }
    if let Some(p) = args.get("priority").and_then(|v| v.as_i64()) {
        let sql = set_sql.replace("{col}", "priority");
        sqlx::query(&sql)
            .bind(p)
            .bind(&ts)
            .bind(&task_id)
            .execute(pool)
            .await
            .map_err(|e| format!("更新优先级失败: {}", e))?;
        updated.push("优先级".into());
    }
    if let Some(n) = args.get("note_html").and_then(|v| v.as_str()) {
        let sql = set_sql.replace("{col}", "note");
        sqlx::query(&sql)
            .bind(n)
            .bind(&ts)
            .bind(&task_id)
            .execute(pool)
            .await
            .map_err(|e| format!("更新备注失败: {}", e))?;
        updated.push("备注".into());
    }
    if let Some(v) = args.get("due") {
        let (ds, de) = if v.is_null() {
            (None, None)
        } else {
            parse_due(v)?
        };
        sqlx::query(
            "UPDATE tasks SET due_start_at = $1, due_end_at = $2, updated_at = $3 WHERE id = $4",
        )
        .bind(&ds)
        .bind(&de)
        .bind(&ts)
        .bind(&task_id)
        .execute(pool)
        .await
        .map_err(|e| format!("更新截止时间失败: {}", e))?;
        updated.push("截止时间".into());
    }
    // 移动清单（名称解析 + 校验）
    if let Some(list_name) = args.get("list_name").and_then(|v| v.as_str()) {
        // 跟随任务 kind 决定目标类型
        let kind: String = sqlx::query_scalar("SELECT kind FROM tasks WHERE id = $1")
            .bind(&task_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|_| "task".into());
        match resolve_target_list(pool, Some(list_name), &kind, INBOX_ID).await {
            Ok(lid) => {
                let sql = set_sql.replace("{col}", "list_id");
                sqlx::query(&sql)
                    .bind(&lid)
                    .bind(&ts)
                    .bind(&task_id)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("移动清单失败: {}", e))?;
                updated.push("所属清单".into());
            }
            Err(e) => return Err(e),
        }
    }
    // 标签整体替换（先删后绑）
    if args.get("tag_names").and_then(|v| v.as_array()).is_some() {
        sqlx::query("DELETE FROM task_tags WHERE task_id = $1")
            .bind(&task_id)
            .execute(pool)
            .await
            .map_err(|e| format!("清空标签失败: {}", e))?;
        let names = str_array(args, "tag_names");
        attach_tags(pool, &task_id, &names)
            .await
            .map_err(|e| format!("更新标签失败: {}", e))?;
        updated.push("标签".into());
    }

    if updated.is_empty() {
        return Ok(json!({ "ok": false, "error": "没有提供任何要更新的字段" }));
    }
    Ok(json!({
        "ok": true, "mutated": true,
        "summary": format!("已更新「{}」的{}", old_title, updated.join("、")),
        "data": { "id": task_id, "updated": updated }
    }))
}

/// update_task 入口：内部以 Result 传播错误，这里统一转失败 JSON
async fn update_task(pool: &SqlitePool, args: &Value) -> Value {
    match update_task_impl(pool, args).await {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// ─── set_task_done ────────────────────────────────────────

async fn set_task_done(pool: &SqlitePool, args: &Value) -> Value {
    let task_id = match args.get("task_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return json!({ "ok": false, "error": "缺少 task_id" }),
    };
    let done = args.get("done").and_then(|v| v.as_bool()).unwrap_or(true);

    // 完成时记录 completed_at；重开时清空（与 task_toggle 行为一致）。两分支占位序不同，分开绑定
    let result = if done {
        sqlx::query("UPDATE tasks SET done = 1, completed_at = $1, updated_at = $2 WHERE id = $3")
            .bind(now())
            .bind(now())
            .bind(&task_id)
            .execute(pool)
            .await
    } else {
        sqlx::query("UPDATE tasks SET done = 0, completed_at = NULL, updated_at = $1 WHERE id = $2")
            .bind(now())
            .bind(&task_id)
            .execute(pool)
            .await
    };
    match result {
        Ok(r) if r.rows_affected() > 0 => {
            let title: String = sqlx::query_scalar("SELECT title FROM tasks WHERE id = $1")
                .bind(&task_id)
                .fetch_one(pool)
                .await
                .unwrap_or_default();
            json!({
                "ok": true, "mutated": true,
                "summary": format!("已{}任务「{}」", if done { "完成" } else { "重开" }, title),
                "data": { "id": task_id, "done": done }
            })
        }
        Ok(_) => json!({ "ok": false, "error": "task_id 对应的任务不存在" }),
        Err(e) => json!({ "ok": false, "error": format!("更新完成状态失败: {}", e) }),
    }
}
