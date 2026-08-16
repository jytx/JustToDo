// AI Agent 只读工具实现（查询任务/搜索/详情/清单树/统计）
//
// 时间过滤沿用项目的 SQLite 惯例：datetime(replace(col,'T',' '),'localtime')

use chrono::Datelike;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

use super::{resolve_list_id, row_to_brief, Param, WhereBuilder};
use crate::ai::commands::priority_label;

/// 只读工具分发入口（由 tool_exec::execute 调用）
pub(crate) async fn dispatch(pool: &SqlitePool, name: &str, args: &Value) -> Value {
    match name {
        "query_tasks" => query_tasks(pool, args).await,
        "search_items" => search_items(pool, args).await,
        "get_task" => get_task(pool, args).await,
        "list_folders" => list_folders(pool, args).await,
        "get_stats" => get_stats(pool, args).await,
        _ => json!({ "ok": false, "error": format!("未知只读工具: {}", name) }),
    }
}

// ─── query_tasks：结构化条件查询 ────────────────────────────

async fn query_tasks(pool: &SqlitePool, args: &Value) -> Value {
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("task");
    // kind 值受 schema enum 限定（task/note），二选一手动拼接无注入风险
    let kind = if kind == "note" { "note" } else { "task" };
    let mut w = WhereBuilder::new();
    w.add_raw("t.parent_id IS NULL");
    w.add_raw("t.deleted_at IS NULL");
    w.add_raw(&format!("t.kind = '{}'", kind));

    // 完成状态
    match args.get("status").and_then(|v| v.as_str()) {
        Some("done") => w.add_raw("t.done = 1"),
        Some("all") => {}
        _ => w.add_raw("t.done = 0"),
    }

    // 清单过滤（名称 → id）
    if let Some(list_name) = args.get("list_name").and_then(|v| v.as_str()) {
        match resolve_list_id(pool, list_name, kind).await {
            Ok(Some(id)) => {
                w.add("t.list_id = {}", Param::Text(id));
            }
            Ok(None) => {
                return json!({ "ok": false, "error": format!("未找到名为「{}」的{}", list_name, if kind == "note" { "笔记本" } else { "清单" }) });
            }
            Err(e) => return json!({ "ok": false, "error": e }),
        }
    }

    // 优先级
    if let Some(p) = args.get("priority").and_then(|v| v.as_i64()) {
        w.add("t.priority = {}", Param::Int(p));
    }

    // 截止时间过滤（today/this_week/overdue 等，边界按本地时区）
    let now = chrono::Local::now().naive_local();
    let today0 = now.date().and_hms_opt(0, 0, 0).unwrap();
    let fmt = |d: chrono::NaiveDateTime| d.format("%Y-%m-%dT%H:%M:%S").to_string();
    let due_col = "datetime(replace(t.due_end_at, 'T', ' '), 'localtime')";
    match args.get("due").and_then(|v| v.as_str()) {
        Some("today") => {
            let e = today0 + chrono::Duration::days(1);
            w.add(
                &format!("{} >= datetime({{}}, 'localtime')", due_col),
                Param::Text(fmt(today0)),
            );
            w.add(
                &format!("{} < datetime({{}}, 'localtime')", due_col),
                Param::Text(fmt(e)),
            );
        }
        Some("tomorrow") => {
            let (s, e) = (
                today0 + chrono::Duration::days(1),
                today0 + chrono::Duration::days(2),
            );
            w.add(
                &format!("{} >= datetime({{}}, 'localtime')", due_col),
                Param::Text(fmt(s)),
            );
            w.add(
                &format!("{} < datetime({{}}, 'localtime')", due_col),
                Param::Text(fmt(e)),
            );
        }
        Some("this_week") => {
            let monday =
                today0 - chrono::Duration::days(now.date().weekday().num_days_from_monday() as i64);
            let next_monday = monday + chrono::Duration::days(7);
            w.add(
                &format!("{} >= datetime({{}}, 'localtime')", due_col),
                Param::Text(fmt(monday)),
            );
            w.add(
                &format!("{} < datetime({{}}, 'localtime')", due_col),
                Param::Text(fmt(next_monday)),
            );
        }
        Some("overdue") => {
            w.add_raw("t.due_end_at IS NOT NULL");
            w.add(
                &format!("{} < datetime({{}}, 'localtime')", due_col),
                Param::Text(fmt(now)),
            );
        }
        Some("no_date") => w.add_raw("t.due_end_at IS NULL"),
        Some("has_date") => w.add_raw("t.due_end_at IS NOT NULL"),
        _ => {}
    }

    // 标签过滤（EXISTS 子查询，避免 JOIN 改变行数）
    if let Some(tag) = args.get("tag_name").and_then(|v| v.as_str()) {
        let clause = "EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON tt.tag_id = g.id WHERE tt.task_id = t.id AND g.name = {})".to_string();
        w.add(&clause, Param::Text(tag.to_string()));
    }

    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50)
        .clamp(1, 100);
    let base =
        "SELECT t.*, (SELECT l.name FROM lists l WHERE l.id = t.list_id) AS list_name FROM tasks t";
    match w.fetch(pool, base).await {
        Ok(rows) => {
            let items: Vec<Value> = rows.iter().take(limit as usize).map(row_to_brief).collect();
            let total = rows.len();
            json!({ "ok": true, "summary": format!("查到 {} 条{}", total, if kind == "note" { "笔记" } else { "任务" }), "data": { "items": items, "total": total, "truncated": total > limit as usize } })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// ─── search_items：标题关键词搜索 ───────────────────────────

async fn search_items(pool: &SqlitePool, args: &Value) -> Value {
    let query = match args.get("query").and_then(|v| v.as_str()) {
        Some(q) if !q.trim().is_empty() => q.trim().to_string(),
        _ => return json!({ "ok": false, "error": "缺少搜索关键词 query" }),
    };
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("task");
    let kind = if kind == "note" { "note" } else { "task" };
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(20)
        .clamp(1, 50);

    let rows = sqlx::query(
        "SELECT t.*, (SELECT l.name FROM lists l WHERE l.id = t.list_id) AS list_name
         FROM tasks t
         WHERE t.title LIKE $1 AND t.kind = $2 AND t.parent_id IS NULL AND t.deleted_at IS NULL
         ORDER BY t.done ASC, t.updated_at DESC
         LIMIT $3",
    )
    .bind(format!("%{}%", query))
    .bind(kind)
    .bind(limit)
    .fetch_all(pool)
    .await;

    match rows {
        Ok(rows) => {
            let items: Vec<Value> = rows.iter().map(row_to_brief).collect();
            let n = items.len();
            json!({ "ok": true, "summary": format!("搜到 {} 条结果", n), "data": { "items": items } })
        }
        Err(e) => json!({ "ok": false, "error": format!("搜索失败: {}", e) }),
    }
}

// ─── get_task：单条详情（含全部后代子任务与标签）────────────────

async fn get_task(pool: &SqlitePool, args: &Value) -> Value {
    // task_id 或 title 二选一定位任务
    let row = if let Some(id) = args.get("task_id").and_then(|v| v.as_str()) {
        sqlx::query("SELECT * FROM tasks WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
    } else if let Some(title) = args.get("title").and_then(|v| v.as_str()) {
        sqlx::query("SELECT * FROM tasks WHERE title = $1 LIMIT 1")
            .bind(title)
            .fetch_optional(pool)
            .await
    } else {
        return json!({ "ok": false, "error": "请提供 task_id 或 title" });
    };
    let row = match row {
        Ok(Some(r)) => r,
        Ok(None) => return json!({ "ok": false, "error": "未找到该任务" }),
        Err(e) => return json!({ "ok": false, "error": format!("查询失败: {}", e) }),
    };
    let id: String = row.get("id");
    let title: String = row.get("title");

    // 递归取全部后代（平铺 + parent_id，模型可自行理解层级）
    let children = sqlx::query(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM tasks WHERE parent_id = $1
             UNION ALL
             SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
         )
         SELECT c.* FROM tasks c WHERE c.id IN (SELECT id FROM subtree)
         ORDER BY c.sort_order ASC",
    )
    .bind(&id)
    .fetch_all(pool)
    .await;

    // 标签名列表
    let tags = sqlx::query_scalar::<_, String>(
        "SELECT g.name FROM task_tags tt JOIN tags g ON tt.tag_id = g.id WHERE tt.task_id = $1",
    )
    .bind(&id)
    .fetch_all(pool)
    .await;

    match (children, tags) {
        (Ok(children), Ok(tags)) => {
            let child_items: Vec<Value> = children.iter().map(row_to_brief).collect();
            json!({
                "ok": true,
                "summary": format!("已查询「{}」详情", title),
                "data": {
                    "id": id,
                    "标题": title,
                    "状态": if row.try_get::<i64, _>("done").unwrap_or(0) == 1 { "已完成" } else { "未完成" },
                    "优先级": priority_label(row.try_get::<i64, _>("priority").unwrap_or(0) as i32),
                    "截止": row.try_get::<Option<String>, _>("due_end_at").ok().flatten(),
                    "标签": tags,
                    "正文": row.try_get::<String, _>("note").unwrap_or_default(),
                    "子任务": child_items,
                }
            })
        }
        (Err(e), _) | (_, Err(e)) => {
            json!({ "ok": false, "error": format!("查询详情失败: {}", e) })
        }
    }
}

// ─── list_folders：清单/笔记本树 ───────────────────────────

async fn list_folders(pool: &SqlitePool, args: &Value) -> Value {
    let kind_filter = match args.get("kind").and_then(|v| v.as_str()) {
        Some("task") => " WHERE l.kind = 'task' AND l.deleted_at IS NULL".to_string(),
        Some("note") => " WHERE l.kind = 'note' AND l.deleted_at IS NULL".to_string(),
        _ => " WHERE l.deleted_at IS NULL".to_string(),
    };
    let rows = sqlx::query(&format!(
        "SELECT l.id, l.name, l.kind, l.is_folder, l.parent_id,
                (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.parent_id IS NULL AND t.done = 0 AND t.deleted_at IS NULL) AS open_count
         FROM lists l{} ORDER BY l.position ASC",
        kind_filter
    ))
    .fetch_all(pool)
    .await;

    match rows {
        Ok(rows) => {
            let items: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let is_folder = r.try_get::<i64, _>("is_folder").unwrap_or(0) == 1;
                    json!({
                        "名称": r.try_get::<String, _>("name").unwrap_or_default(),
                        "类型": if is_folder { "目录" } else if r.try_get::<String, _>("kind").unwrap_or_default() == "note" { "笔记本" } else { "清单" },
                        "未完成数": r.try_get::<i64, _>("open_count").unwrap_or(0),
                        "父目录": r.try_get::<Option<String>, _>("parent_id").ok().flatten(),
                    })
                })
                .collect();
            let n = items.len();
            json!({ "ok": true, "summary": format!("共 {} 个清单/目录", n), "data": { "items": items } })
        }
        Err(e) => json!({ "ok": false, "error": format!("查询清单失败: {}", e) }),
    }
}

// ─── get_stats：完成统计 ───────────────────────────────────

async fn get_stats(pool: &SqlitePool, args: &Value) -> Value {
    let now = chrono::Local::now().naive_local();
    let today0 = now.date().and_hms_opt(0, 0, 0).unwrap();
    let fmt = |d: chrono::NaiveDateTime| d.format("%Y-%m-%dT%H:%M:%S").to_string();
    let (start, label) = match args.get("range").and_then(|v| v.as_str()) {
        Some("this_week") => {
            let monday =
                today0 - chrono::Duration::days(now.date().weekday().num_days_from_monday() as i64);
            (monday, "本周")
        }
        Some("last_7_days") => (today0 - chrono::Duration::days(7), "最近 7 天"),
        _ => (today0, "今天"),
    };

    // 完成数（按 completed_at 落在范围内；回收站条目不计）
    let completed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tasks
         WHERE done = 1 AND parent_id IS NULL AND kind = 'task' AND completed_at IS NOT NULL
           AND deleted_at IS NULL
           AND datetime(replace(completed_at, 'T', ' '), 'localtime') >= datetime($1, 'localtime')",
    )
    .bind(fmt(start))
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    // 未完成总数 + 逾期数（逾期不受 range 限制，反映当前状态）
    let open_total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tasks WHERE done = 0 AND parent_id IS NULL AND kind = 'task' AND deleted_at IS NULL",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    let overdue: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tasks
         WHERE done = 0 AND parent_id IS NULL AND kind = 'task' AND due_end_at IS NOT NULL
           AND deleted_at IS NULL
           AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($1, 'localtime')",
    )
    .bind(fmt(now))
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    json!({
        "ok": true,
        "summary": format!("{}完成 {} 项，当前未完成 {} 项（逾期 {} 项）", label, completed, open_total, overdue),
        "data": { "完成数": completed, "未完成数": open_total, "逾期数": overdue, "范围": label }
    })
}
