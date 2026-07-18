// Tauri 命令 —— 前端通过 invoke() 调用这些函数
// 所有命令返回 Result<T, String>，错误信息清晰传到前端

use chrono::{Datelike, Timelike};
use sqlx::Row;
use tauri::State;

use crate::models::*;

type CmdResult<T> = Result<T, String>;

// ─── 工具函数 ────────────────────────────────────────────

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 当前本地时间字面量（"YYYY-MM-DDTHH:mm:ss"），与前端 toLocalIso 输出格式一致
fn now() -> String {
    format_local_naive(chrono::Local::now().naive_local())
}

/// 根据 sort_field + sort_dir 生成 ORDER BY 子句（不含前缀 "ORDER BY "）
/// 总是先按 done 排（未完成在前），再按用户指定字段
fn order_by_clause(sort_field: &str, sort_dir: &str) -> String {
    let dir = if sort_dir.eq_ignore_ascii_case("desc") {
        "DESC"
    } else {
        "ASC"
    };
    match sort_field {
        "priority" => format!(
            "priority {}, sort_order ASC",
            if dir == "ASC" { "DESC" } else { "ASC" }
        ), // 默认 desc
        "due" => format!(
            "(CASE WHEN due_end_at IS NULL THEN 1 ELSE 0 END), due_end_at {}, sort_order ASC",
            dir
        ),
        "title" => format!("title COLLATE NOCASE {}, sort_order ASC", dir),
        _ => "sort_order ASC, created_at ASC".to_string(), // manual 默认
    }
}

/// 从行数据提取 Task（done 是 0/1 整数）
fn row_to_task(row: &sqlx::sqlite::SqliteRow) -> Task {
    Task {
        id: row.get("id"),
        title: row.get("title"),
        note: row.get("note"),
        list_id: row.get("list_id"),
        parent_id: row.get("parent_id"),
        priority: row.get("priority"),
        due_start_at: row.get("due_start_at"),
        due_end_at: row.get("due_end_at"),
        done: row.get::<i32, _>("done") != 0,
        sort_order: row.get("sort_order"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        completed_at: row.get("completed_at"),
        recurrence_freq: row.get("recurrence_freq"),
        recurrence_interval: row.get("recurrence_interval"),
        recurrence_end_at: row.get("recurrence_end_at"),
        recurrence_count: row.get("recurrence_count"),
        recurrence_origin_id: row.try_get("recurrence_origin_id").ok().flatten(),
        remind_offset_minutes: row.try_get("remind_offset_minutes").ok().flatten(),
        notified_at: row.try_get("notified_at").ok().flatten(),
        // checklist 存的是 JSON 字符串，反序列化为 Vec
        // 字段 NOT NULL DEFAULT '[]'，所以一定存在；解析失败则为空列表
        checklist: row
            .try_get::<String, _>("checklist")
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<ChecklistItem>>(&s).ok())
            .unwrap_or_default(),
    }
}

// ─── 清单操作 ────────────────────────────────────────────

#[tauri::command]
pub async fn list_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<TaskList>> {
    let rows = sqlx::query(
        "SELECT id, name, color, position, created_at, parent_id, is_folder FROM lists ORDER BY position ASC, created_at ASC"
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询清单失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| TaskList {
            id: r.get("id"),
            name: r.get("name"),
            color: r.get("color"),
            position: r.get("position"),
            created_at: r.get("created_at"),
            parent_id: r.get("parent_id"),
            is_folder: r.get::<i32, _>("is_folder") != 0,
        })
        .collect())
}

#[tauri::command]
pub async fn list_create(
    pool: State<'_, sqlx::SqlitePool>,
    name: String,
    color: String,
    parent_id: Option<String>,
    is_folder: Option<bool>,
) -> CmdResult<TaskList> {
    let id = uuid();
    let ts = now();
    let position = chrono::Utc::now().timestamp_millis();
    let is_folder_val = if is_folder.unwrap_or(false) { 1 } else { 0 };

    sqlx::query(
        "INSERT INTO lists (id, name, color, position, created_at, parent_id, is_folder) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&color)
    .bind(position)
    .bind(&ts)
    .bind(&parent_id)
    .bind(is_folder_val)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建清单失败: {}", e))?;

    Ok(TaskList {
        id,
        name,
        color,
        position,
        created_at: ts,
        parent_id,
        is_folder: is_folder_val != 0,
    })
}

#[tauri::command]
pub async fn list_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    if id == "inbox" {
        return Err("收件箱不能删除".to_string());
    }

    // 查询被删项的 parent_id（用于提升子项）
    let row = sqlx::query("SELECT parent_id, is_folder FROM lists WHERE id = $1")
        .bind(&id)
        .fetch_optional(pool.inner())
        .await
        .map_err(|e| format!("查询失败: {}", e))?;

    if let Some(row) = row {
        let parent_id: Option<String> = row.get("parent_id");
        let is_folder: bool = row.get::<i32, _>("is_folder") != 0;

        if is_folder {
            // 删除目录：把子项的 parent_id 提升到被删目录的 parent_id
            sqlx::query("UPDATE lists SET parent_id = $1 WHERE parent_id = $2")
                .bind(&parent_id)
                .bind(&id)
                .execute(pool.inner())
                .await
                .map_err(|e| format!("迁移子项失败: {}", e))?;
        } else {
            // 删除清单：把任务迁移到收件箱
            sqlx::query("UPDATE tasks SET list_id = 'inbox', updated_at = $1 WHERE list_id = $2")
                .bind(now())
                .bind(&id)
                .execute(pool.inner())
                .await
                .map_err(|e| format!("迁移任务失败: {}", e))?;
        }
    }

    sqlx::query("DELETE FROM lists WHERE id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除清单失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn list_rename(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    name: String,
    color: String,
) -> CmdResult<()> {
    if id == "inbox" {
        return Err("收件箱不能重命名".to_string());
    }
    sqlx::query("UPDATE lists SET name = $1, color = $2 WHERE id = $3")
        .bind(&name)
        .bind(&color)
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("更新清单失败: {}", e))?;
    Ok(())
}

/// 移动清单/目录到另一个父级（null = 根级），可同时更新 position
#[tauri::command]
pub async fn list_move(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> CmdResult<()> {
    if id == "inbox" {
        return Err("收件箱不能移动".to_string());
    }
    match position {
        Some(pos) => {
            sqlx::query("UPDATE lists SET parent_id = $1, position = $2 WHERE id = $3")
                .bind(&parent_id)
                .bind(pos)
                .bind(&id)
                .execute(pool.inner())
                .await
                .map_err(|e| format!("移动清单失败: {}", e))?;
        }
        None => {
            sqlx::query("UPDATE lists SET parent_id = $1 WHERE id = $2")
                .bind(&parent_id)
                .bind(&id)
                .execute(pool.inner())
                .await
                .map_err(|e| format!("移动清单失败: {}", e))?;
        }
    }
    Ok(())
}

/// 批量更新清单位置（拖拽排序后）
#[tauri::command]
pub async fn list_reorder(
    pool: State<'_, sqlx::SqlitePool>,
    items: Vec<(String, i64)>,
) -> CmdResult<()> {
    for (id, position) in &items {
        sqlx::query("UPDATE lists SET position = $1 WHERE id = $2")
            .bind(position)
            .bind(id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新位置失败: {}", e))?;
    }
    Ok(())
}

// ─── 任务操作 ────────────────────────────────────────────

/// 统计各清单的未完成根任务数量（供侧边栏显示）
#[tauri::command]
pub async fn task_count_by_list(
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<Vec<(String, i64)>> {
    let rows = sqlx::query(
        "SELECT list_id, COUNT(*) as cnt FROM tasks WHERE parent_id IS NULL AND done = 0 GROUP BY list_id"
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("统计任务数量失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| (r.get::<String, _>("list_id"), r.get::<i64, _>("cnt")))
        .collect())
}

/// 统计各标签的未完成根任务数量（供侧边栏显示）
#[tauri::command]
pub async fn task_count_by_tag(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<(String, i64)>> {
    let rows = sqlx::query(
        "SELECT tt.tag_id, COUNT(*) as cnt
         FROM task_tags tt
         JOIN tasks t ON t.id = tt.task_id
         WHERE t.parent_id IS NULL AND t.done = 0
         GROUP BY tt.tag_id",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("统计标签任务数量失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| (r.get::<String, _>("tag_id"), r.get::<i64, _>("cnt")))
        .collect())
}

/// 统计智能视图的未完成根任务数量
#[tauri::command]
pub async fn task_count_smart_view(
    pool: State<'_, sqlx::SqlitePool>,
    view: String,
) -> CmdResult<i64> {
    // 本地时间字面量（与前端/DB 格式一致：YYYY-MM-DDTHH:mm:ss）
    // SQLite 的 datetime() 函数对 T 或空格分隔都能解析
    let now = chrono::Local::now().naive_local();
    let end_of_today = (now.date() + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let end_of_week = (now.date() + chrono::Duration::days(7))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();

    let count: i64 = if view == "today" {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0 AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($1, 'localtime')"
        )
        .bind(&end_of_today)
        .fetch_one(pool.inner())
        .await
    } else if view == "upcoming" {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0 AND datetime(replace(due_end_at, 'T', ' '), 'localtime') >= datetime($1, 'localtime') AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($2, 'localtime')"
        )
        .bind(&end_of_today)
        .bind(&end_of_week)
        .fetch_one(pool.inner())
        .await
    } else {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0"
        )
        .fetch_one(pool.inner())
        .await
    }
    .map_err(|e| format!("统计智能视图任务失败: {}", e))?;

    Ok(count)
}

#[tauri::command]
pub async fn task_get_by_list(
    pool: State<'_, sqlx::SqlitePool>,
    list_id: String,
    sort_field: Option<String>,
    sort_dir: Option<String>,
) -> CmdResult<Vec<Task>> {
    // 解析排序字段（参数 > 数据库持久化 > 默认 manual）
    let (sf, sd) = resolve_sort_pref(
        pool.inner(),
        "list",
        &list_id,
        sort_field.as_deref(),
        sort_dir.as_deref(),
    )
    .await?;

    let sql = format!(
        "SELECT * FROM tasks WHERE list_id = $1 AND parent_id IS NULL ORDER BY done ASC, {}",
        order_by_clause(&sf, &sd)
    );

    let rows = sqlx::query(&sql)
        .bind(&list_id)
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("查询任务失败: {}", e))?;

    Ok(rows.iter().map(row_to_task).collect())
}

/// 解析排序偏好：参数 > 数据库持久化 > 默认 manual/asc
async fn resolve_sort_pref(
    pool: &sqlx::SqlitePool,
    pref_type: &str,
    pref_id: &str,
    param_field: Option<&str>,
    param_dir: Option<&str>,
) -> CmdResult<(String, String)> {
    if let (Some(f), Some(d)) = (param_field, param_dir) {
        return Ok((f.to_string(), d.to_string()));
    }
    let row_opt = match pref_type {
        "list" => sqlx::query("SELECT sort_field, sort_dir FROM lists WHERE id = $1")
            .bind(pref_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten(),
        "tag" => sqlx::query("SELECT sort_field, sort_dir FROM tag_sort_prefs WHERE tag_id = $1")
            .bind(pref_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten(),
        _ => None,
    };
    if let Some(row) = row_opt {
        let f: Option<String> = row.try_get("sort_field").ok();
        let d: Option<String> = row.try_get("sort_dir").ok();
        if let (Some(f), Some(d)) = (f, d) {
            return Ok((f, d));
        }
    }
    Ok(("manual".to_string(), "asc".to_string()))
}

/// 查询与某个日期范围相交的"已完成 or 未完成"任务（前端用于日历视图）
///
/// 命中条件：任务的开始时刻 ≤ rangeEnd 且结束时刻 ≥ rangeStart
/// 这样跨天任务 / 部分在窗口内的任务都能出现；不区分根/子任务。
///
/// 参数：
/// - `start` / `end`：本地时间字面量 "YYYY-MM-DDTHH:mm:ss"，含端点
/// - `include_done`：是否包含已完成任务；true 时含 done=1，false 时仅 done=0
#[tauri::command]
pub async fn task_get_by_due_range(
    pool: State<'_, sqlx::SqlitePool>,
    start: String,
    end: String,
    include_done: bool,
) -> CmdResult<Vec<Task>> {
    let done_clause = if include_done { "" } else { "AND done = 0" };
    let sql = format!(
        "SELECT * FROM tasks
         WHERE due_start_at IS NOT NULL
           AND due_end_at IS NOT NULL
           AND due_start_at <= $2
           AND due_end_at   >= $1
           {}
         ORDER BY done ASC, due_start_at ASC, sort_order ASC",
        done_clause
    );
    let rows = sqlx::query(&sql)
        .bind(&start)
        .bind(&end)
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("按日期范围查询任务失败: {}", e))?;
    Ok(rows.iter().map(row_to_task).collect())
}

#[tauri::command]
pub async fn task_get_smart_view(
    pool: State<'_, sqlx::SqlitePool>,
    view: String,
    sort_field: Option<String>,
    sort_dir: Option<String>,
) -> CmdResult<Vec<Task>> {
    let now = chrono::Local::now().naive_local();
    let end_of_today = (now.date() + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let end_of_week = (now.date() + chrono::Duration::days(7))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();

    // today / upcoming 固定按日期+优先级；all 支持可选排序
    // SQLite datetime() 默认按 UTC 解释无时区字符串；显式加 'localtime' 与
    // 我们存的本地字面量语义匹配
    let sql = if view == "today" {
        "SELECT * FROM tasks WHERE parent_id IS NULL AND done = 0 AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($1, 'localtime') ORDER BY due_end_at ASC, priority DESC, sort_order ASC".to_string()
    } else if view == "upcoming" {
        "SELECT * FROM tasks WHERE parent_id IS NULL AND done = 0 AND datetime(replace(due_end_at, 'T', ' '), 'localtime') >= datetime($1, 'localtime') AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($2, 'localtime') ORDER BY due_end_at ASC, priority DESC, sort_order ASC".to_string()
    } else {
        // all 视图支持 sort
        let (sf, sd) = match (sort_field.as_deref(), sort_dir.as_deref()) {
            (Some(f), Some(d)) => (f.to_string(), d.to_string()),
            _ => ("manual".to_string(), "asc".to_string()),
        };
        format!(
            "SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY done ASC, {}",
            order_by_clause(&sf, &sd)
        )
    };

    let rows = if view == "upcoming" {
        sqlx::query(&sql)
            .bind(&end_of_today)
            .bind(&end_of_week)
            .fetch_all(pool.inner())
            .await
            .map_err(|e| format!("查询未来任务失败: {}", e))?
    } else if view == "today" {
        sqlx::query(&sql)
            .bind(&end_of_today)
            .fetch_all(pool.inner())
            .await
            .map_err(|e| format!("查询今日任务失败: {}", e))?
    } else {
        sqlx::query(&sql)
            .fetch_all(pool.inner())
            .await
            .map_err(|e| format!("查询全部任务失败: {}", e))?
    };

    Ok(rows.iter().map(row_to_task).collect())
}

#[tauri::command]
pub async fn task_create(
    pool: State<'_, sqlx::SqlitePool>,
    input: CreateTaskInput,
) -> CmdResult<Task> {
    let id = uuid();
    let ts = now();
    let priority = input.priority.unwrap_or(0);
    let sort_order = chrono::Utc::now().timestamp_millis();
    let parent_id = input.parent_id.clone();
    let due_start_at = input.due_start_at.clone();
    let due_end_at = input.due_end_at.clone();
    let recurrence_freq = input.recurrence_freq.clone();
    let recurrence_interval = input.recurrence_interval.unwrap_or(1);
    let recurrence_end_at = input.recurrence_end_at.clone();
    let recurrence_count = input.recurrence_count;
    let remind_offset_minutes = input.remind_offset_minutes;

    sqlx::query(
        "INSERT INTO tasks (id, title, note, list_id, parent_id, priority, due_start_at, due_end_at, done, sort_order, created_at, updated_at, completed_at, recurrence_freq, recurrence_interval, recurrence_end_at, recurrence_count, remind_offset_minutes)
         VALUES ($1, $2, '', $3, $4, $5, $6, $7, 0, $8, $9, $10, NULL, $11, $12, $13, $14, $15)",
    )
    .bind(&id)
    .bind(&input.title)
    .bind(&input.list_id)
    .bind(&parent_id)
    .bind(priority)
    .bind(&due_start_at)
    .bind(&due_end_at)
    .bind(sort_order)
    .bind(&ts)
    .bind(&ts)
    .bind(&recurrence_freq)
    .bind(recurrence_interval)
    .bind(&recurrence_end_at)
    .bind(recurrence_count)
    .bind(&remind_offset_minutes)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建任务失败: {}", e))?;

    Ok(Task {
        id,
        title: input.title,
        note: String::new(),
        list_id: input.list_id,
        parent_id,
        priority,
        due_start_at,
        due_end_at,
        done: false,
        sort_order,
        created_at: ts.clone(),
        updated_at: ts,
        completed_at: None,
        recurrence_freq,
        recurrence_interval,
        recurrence_end_at,
        recurrence_count,
        recurrence_origin_id: None,
        remind_offset_minutes,
        notified_at: None,
        checklist: Vec::new(),
    })
}

#[tauri::command]
pub async fn task_update(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    input: UpdateTaskInput,
) -> CmdResult<()> {
    let ts = now();

    if let Some(title) = &input.title {
        sqlx::query("UPDATE tasks SET title = $1, updated_at = $2 WHERE id = $3")
            .bind(title)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(note) = &input.note {
        sqlx::query("UPDATE tasks SET note = $1, updated_at = $2 WHERE id = $3")
            .bind(note)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(priority) = input.priority {
        sqlx::query("UPDATE tasks SET priority = $1, updated_at = $2 WHERE id = $3")
            .bind(priority)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(due_start_at) = &input.due_start_at {
        sqlx::query("UPDATE tasks SET due_start_at = $1, updated_at = $2 WHERE id = $3")
            .bind(due_start_at)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(due_end_at) = &input.due_end_at {
        // 截止时间改变时重置 notified_at，让新一轮 reminder 重新检查
        sqlx::query(
            "UPDATE tasks SET due_end_at = $1, notified_at = NULL, updated_at = $2 WHERE id = $3",
        )
        .bind(due_end_at)
        .bind(&ts)
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(list_id) = &input.list_id {
        sqlx::query("UPDATE tasks SET list_id = $1, updated_at = $2 WHERE id = $3")
            .bind(list_id)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    // 重复规则字段（Option<Option<T>> 表示可能清除字段）
    if let Some(freq) = &input.recurrence_freq {
        sqlx::query("UPDATE tasks SET recurrence_freq = $1, updated_at = $2 WHERE id = $3")
            .bind(freq)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(interval) = input.recurrence_interval {
        sqlx::query("UPDATE tasks SET recurrence_interval = $1, updated_at = $2 WHERE id = $3")
            .bind(interval)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(end_at) = &input.recurrence_end_at {
        sqlx::query("UPDATE tasks SET recurrence_end_at = $1, updated_at = $2 WHERE id = $3")
            .bind(end_at)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(count) = &input.recurrence_count {
        sqlx::query("UPDATE tasks SET recurrence_count = $1, updated_at = $2 WHERE id = $3")
            .bind(count)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    // 提醒规则（Option<Option<i32>> 允许显式清空）
    if let Some(remind) = &input.remind_offset_minutes {
        // 任何对提醒规则的修改都重置 notified_at，避免改完规则却不再通知
        sqlx::query("UPDATE tasks SET remind_offset_minutes = $1, notified_at = NULL, updated_at = $2 WHERE id = $3")
            .bind(remind).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新提醒失败: {}", e))?;
    }
    // 检查项列表（整组覆盖为 JSON 数组）
    if let Some(checklist) = &input.checklist {
        let json =
            serde_json::to_string(checklist).map_err(|e| format!("序列化检查项失败: {}", e))?;
        sqlx::query("UPDATE tasks SET checklist = $1, updated_at = $2 WHERE id = $3")
            .bind(json)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新检查项失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn task_toggle(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    done: bool,
) -> CmdResult<()> {
    let ts = now();
    let completed_at = if done { Some(ts.clone()) } else { None };

    sqlx::query("UPDATE tasks SET done = $1, completed_at = $2, updated_at = $3 WHERE id = $4")
        .bind(done)
        .bind(&completed_at)
        .bind(&ts)
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("切换任务状态失败: {}", e))?;

    Ok(())
}

/// 批量更新任务排序（拖拽排序后）
#[tauri::command]
pub async fn task_reorder(
    pool: State<'_, sqlx::SqlitePool>,
    items: Vec<(String, i64)>,
) -> CmdResult<()> {
    for (id, sort_order) in &items {
        sqlx::query("UPDATE tasks SET sort_order = $1, updated_at = $2 WHERE id = $3")
            .bind(sort_order)
            .bind(now())
            .bind(id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新排序失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn task_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM tasks WHERE id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除任务失败: {}", e))?;

    Ok(())
}

/// 按 ID 获取单个任务（用于详情面板解析父任务链）
#[tauri::command]
pub async fn task_get_by_id(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
) -> CmdResult<Option<Task>> {
    let row = sqlx::query("SELECT * FROM tasks WHERE id = $1")
        .bind(&id)
        .fetch_optional(pool.inner())
        .await
        .map_err(|e| format!("查询任务失败: {}", e))?;

    Ok(row.as_ref().map(row_to_task))
}

#[tauri::command]
pub async fn task_get_subtasks(
    pool: State<'_, sqlx::SqlitePool>,
    parent_id: String,
) -> CmdResult<Vec<Task>> {
    let rows = sqlx::query(
        "SELECT * FROM tasks WHERE parent_id = $1 ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(parent_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询子任务失败: {}", e))?;

    Ok(rows.iter().map(row_to_task).collect())
}

// ─── 标签操作 ────────────────────────────────────────────

#[tauri::command]
pub async fn tag_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<Tag>> {
    let rows = sqlx::query(
        "SELECT id, name, created_at, position FROM tags ORDER BY position ASC, created_at ASC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询标签失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| Tag {
            id: r.get("id"),
            name: r.get("name"),
            created_at: r.get("created_at"),
            position: r.get("position"),
        })
        .collect())
}

/// 批量更新标签位置（侧边栏拖拽排序后）
#[tauri::command]
pub async fn tag_reorder(
    pool: State<'_, sqlx::SqlitePool>,
    items: Vec<(String, i64)>,
) -> CmdResult<()> {
    for (id, position) in &items {
        sqlx::query("UPDATE tags SET position = $1 WHERE id = $2")
            .bind(position)
            .bind(id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新标签位置失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn tag_create(pool: State<'_, sqlx::SqlitePool>, name: String) -> CmdResult<Tag> {
    let id = uuid();
    let ts = now();

    sqlx::query("INSERT INTO tags (id, name, created_at) VALUES ($1, $2, $3)")
        .bind(&id)
        .bind(&name)
        .bind(&ts)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("创建标签失败: {}", e))?;

    Ok(Tag {
        id,
        name,
        created_at: ts,
        position: 0,
    })
}

/// 查询指定标签下的所有任务（包括有子任务的根任务）
#[tauri::command]
pub async fn task_get_by_tag(
    pool: State<'_, sqlx::SqlitePool>,
    tag_id: String,
    sort_field: Option<String>,
    sort_dir: Option<String>,
) -> CmdResult<Vec<Task>> {
    let (sf, sd) = resolve_sort_pref(
        pool.inner(),
        "tag",
        &tag_id,
        sort_field.as_deref(),
        sort_dir.as_deref(),
    )
    .await?;

    let sql = format!(
        "SELECT * FROM tasks
         WHERE parent_id IS NULL
           AND id IN (SELECT task_id FROM task_tags WHERE tag_id = $1)
         ORDER BY done ASC, {}",
        order_by_clause(&sf, &sd)
    );

    let rows = sqlx::query(&sql)
        .bind(&tag_id)
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("查询标签任务失败: {}", e))?;

    Ok(rows.iter().map(row_to_task).collect())
}

/// 设置清单的排序偏好
#[tauri::command]
pub async fn list_set_sort_pref(
    pool: State<'_, sqlx::SqlitePool>,
    list_id: String,
    sort_field: String,
    sort_dir: String,
) -> CmdResult<()> {
    sqlx::query("UPDATE lists SET sort_field = $1, sort_dir = $2 WHERE id = $3")
        .bind(&sort_field)
        .bind(&sort_dir)
        .bind(&list_id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("设置清单排序失败: {}", e))?;
    Ok(())
}

/// 设置标签的排序偏好
#[tauri::command]
pub async fn tag_set_sort_pref(
    pool: State<'_, sqlx::SqlitePool>,
    tag_id: String,
    sort_field: String,
    sort_dir: String,
) -> CmdResult<()> {
    sqlx::query(
        "INSERT INTO tag_sort_prefs (tag_id, sort_field, sort_dir)
         VALUES ($1, $2, $3)
         ON CONFLICT(tag_id) DO UPDATE SET sort_field = $2, sort_dir = $3",
    )
    .bind(&tag_id)
    .bind(&sort_field)
    .bind(&sort_dir)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("设置标签排序失败: {}", e))?;
    Ok(())
}

/// 查询清单的排序偏好（用于前端切换清单时同步 currentSort）
#[tauri::command]
pub async fn list_get_sort_pref(
    pool: State<'_, sqlx::SqlitePool>,
    list_id: String,
) -> CmdResult<(String, String)> {
    resolve_sort_pref(pool.inner(), "list", &list_id, None, None).await
}

/// 查询标签的排序偏好
#[tauri::command]
pub async fn tag_get_sort_pref(
    pool: State<'_, sqlx::SqlitePool>,
    tag_id: String,
) -> CmdResult<(String, String)> {
    resolve_sort_pref(pool.inner(), "tag", &tag_id, None, None).await
}

#[tauri::command]
pub async fn tag_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM tags WHERE id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除标签失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn tag_rename(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    name: String,
) -> CmdResult<()> {
    sqlx::query("UPDATE tags SET name = $1 WHERE id = $2")
        .bind(&name)
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("重命名标签失败: {}", e))?;
    Ok(())
}

// ─── 搜索 ────────────────────────────────────────────────

#[tauri::command]
pub async fn search_tasks(
    pool: State<'_, sqlx::SqlitePool>,
    query: String,
) -> CmdResult<Vec<Task>> {
    let pattern = format!("%{}%", query);
    let rows = sqlx::query(
        "SELECT * FROM tasks WHERE parent_id IS NULL AND (title LIKE $1 OR note LIKE $1) ORDER BY done ASC, updated_at DESC LIMIT 20",
    )
    .bind(&pattern)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("搜索任务失败: {}", e))?;

    Ok(rows.iter().map(row_to_task).collect())
}

// ─── 习惯操作 ────────────────────────────────────────────

#[derive(Debug, serde::Serialize, Clone)]
pub struct Habit {
    pub id: String,
    pub name: String,
    pub color: String,
    pub repeat_rule: String,
    pub target_count: i32,
    pub remind_at: Option<String>,
    pub created_at: String,
    /// 侧边栏手动排序 key（整数间隔）
    pub position: i64,
    /// 时段分组："morning" | "afternoon" | "evening"（默认 evening）
    pub time_of_day: String,
    /// emoji 图标字符（默认 🏆）
    pub icon: String,
}

#[derive(Debug, serde::Serialize)]
pub struct HabitWithStats {
    pub habit: Habit,
    pub today_done: bool,
    pub streak: i32,
    pub total_days: i32,
}

#[derive(Debug, serde::Deserialize)]
pub struct CreateHabitInput {
    pub name: String,
    pub color: Option<String>,
    pub repeat_rule: Option<String>,
    pub target_count: Option<i32>,
    pub remind_at: Option<String>,
    /// 时段分组："morning" | "afternoon" | "evening"（默认 evening）
    pub time_of_day: Option<String>,
    /// emoji 图标字符（默认 🏆）
    pub icon: Option<String>,
}

#[tauri::command]
pub async fn habit_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<HabitWithStats>> {
    let rows = sqlx::query("SELECT id, name, color, repeat_rule, target_count, remind_at, created_at, position, time_of_day, icon FROM habits ORDER BY position ASC, created_at ASC")
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("查询习惯失败: {}", e))?;

    let today = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let mut result = Vec::new();

    for r in &rows {
        let id: String = r.get("id");
        let habit = Habit {
            id: id.clone(),
            name: r.get("name"),
            color: r.get("color"),
            repeat_rule: r.get("repeat_rule"),
            target_count: r.get("target_count"),
            remind_at: r.get("remind_at"),
            created_at: r.get("created_at"),
            position: r.get("position"),
            time_of_day: r.get("time_of_day"),
            icon: r.get("icon"),
        };

        let today_count: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(count), 0) FROM habit_logs WHERE habit_id = $1 AND log_date = $2",
        )
        .bind(&id)
        .bind(&today)
        .fetch_one(pool.inner())
        .await
        .unwrap_or(0);

        let total_days: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT log_date) FROM habit_logs WHERE habit_id = $1",
        )
        .bind(&id)
        .fetch_one(pool.inner())
        .await
        .unwrap_or(0);

        let streak = calc_streak(pool.inner(), &id, &today).await;

        result.push(HabitWithStats {
            habit,
            today_done: today_count > 0,
            streak,
            total_days: total_days as i32,
        });
    }

    Ok(result)
}

async fn calc_streak(pool: &sqlx::SqlitePool, habit_id: &str, today: &str) -> i32 {
    let dates: Vec<String> = sqlx::query(
        "SELECT DISTINCT log_date FROM habit_logs WHERE habit_id = $1 ORDER BY log_date DESC LIMIT 365"
    )
    .bind(habit_id)
    .fetch_all(pool)
    .await
    .map(|rows| rows.iter().map(|r| r.get::<String, _>("log_date")).collect())
    .unwrap_or_default();

    if dates.is_empty() {
        return 0;
    }

    let mut streak = 0;
    let mut check_date = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").ok();

    for log_date_str in &dates {
        if let Some(cd) = check_date {
            let log_date = chrono::NaiveDate::parse_from_str(log_date_str, "%Y-%m-%d").ok();
            if log_date == Some(cd) {
                streak += 1;
                check_date = cd.pred_opt();
            } else {
                break;
            }
        }
    }

    streak
}

#[tauri::command]
pub async fn habit_create(
    pool: State<'_, sqlx::SqlitePool>,
    input: CreateHabitInput,
) -> CmdResult<Habit> {
    let id = uuid();
    let ts = now();
    let color = input.color.unwrap_or_else(|| "#059669".to_string());
    let repeat_rule = input.repeat_rule.unwrap_or_else(|| "daily".to_string());
    let target_count = input.target_count.unwrap_or(1);
    // 时段：仅接受 morning/afternoon/evening，其他值统一回退到 evening
    let time_of_day = match input.time_of_day.as_deref() {
        Some("morning") | Some("afternoon") | Some("evening") => input.time_of_day.unwrap(),
        _ => "evening".to_string(),
    };
    let icon = input.icon.unwrap_or_else(|| "🏆".to_string());

    sqlx::query(
        "INSERT INTO habits (id, name, color, repeat_rule, target_count, remind_at, created_at, time_of_day, icon) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"
    )
    .bind(&id).bind(&input.name).bind(&color).bind(&repeat_rule)
    .bind(target_count).bind(&input.remind_at).bind(&ts).bind(&time_of_day).bind(&icon)
    .execute(pool.inner()).await
    .map_err(|e| format!("创建习惯失败: {}", e))?;

    Ok(Habit {
        id,
        name: input.name,
        color,
        repeat_rule,
        target_count,
        remind_at: input.remind_at,
        created_at: ts,
        position: 0,
        time_of_day,
        icon,
    })
}

/// 更新习惯（编辑名称/颜色/时段/图标/重复规则/目标/提醒）
#[tauri::command]
pub async fn habit_update(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    time_of_day: Option<String>,
    icon: Option<String>,
    repeat_rule: Option<String>,
    target_count: Option<i32>,
    remind_at: Option<Option<String>>,
) -> CmdResult<Habit> {
    let new_name = name.unwrap_or_default();
    let new_color = color.unwrap_or_else(|| "#059669".to_string());
    let new_tod = match time_of_day.as_deref() {
        Some("morning") | Some("afternoon") | Some("evening") => time_of_day.unwrap(),
        _ => "evening".to_string(),
    };
    let new_icon = icon.unwrap_or_else(|| "🏆".to_string());
    let new_repeat = repeat_rule.unwrap_or_else(|| "daily".to_string());
    let new_target = target_count.unwrap_or(1);
    // remind_at 是 Option<Option<String>>：外层 Some = 调用方传了字段，
    // 内层 None = 显式清空提醒，Some(s) = 设为 s
    let new_remind: Option<String> = match remind_at {
        Some(inner) => inner,
        None => None, // 调用方未传该字段时保持现状（下方 SELECT 会拿到现状值，但 UPDATE 不动）
    };

    sqlx::query(
        "UPDATE habits SET name = $1, color = $2, time_of_day = $3, icon = $4, repeat_rule = $5, target_count = $6, remind_at = $7 WHERE id = $8",
    )
    .bind(&new_name).bind(&new_color).bind(&new_tod).bind(&new_icon)
    .bind(&new_repeat).bind(new_target).bind(&new_remind).bind(&id)
    .execute(pool.inner()).await
    .map_err(|e| format!("更新习惯失败: {}", e))?;

    let r = sqlx::query("SELECT id, name, color, repeat_rule, target_count, remind_at, created_at, position, time_of_day, icon FROM habits WHERE id = $1")
        .bind(&id)
        .fetch_one(pool.inner()).await
        .map_err(|e| format!("读取更新后的习惯失败: {}", e))?;

    Ok(Habit {
        id: r.get("id"),
        name: r.get("name"),
        color: r.get("color"),
        repeat_rule: r.get("repeat_rule"),
        target_count: r.get("target_count"),
        remind_at: r.get("remind_at"),
        created_at: r.get("created_at"),
        position: r.get("position"),
        time_of_day: r.get("time_of_day"),
        icon: r.get("icon"),
    })
}

/// 批量更新习惯位置（侧边栏拖拽排序后）
#[tauri::command]
pub async fn habit_reorder(
    pool: State<'_, sqlx::SqlitePool>,
    items: Vec<(String, i64)>,
) -> CmdResult<()> {
    for (id, position) in &items {
        sqlx::query("UPDATE habits SET position = $1 WHERE id = $2")
            .bind(position)
            .bind(id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新习惯位置失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn habit_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM habits WHERE id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除习惯失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn habit_toggle_check(
    pool: State<'_, sqlx::SqlitePool>,
    habit_id: String,
    date: Option<String>,
) -> CmdResult<bool> {
    let log_date = date.unwrap_or_else(|| {
        chrono::Utc::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string()
    });
    let id = uuid();
    let ts = now();

    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM habit_logs WHERE habit_id = $1 AND log_date = $2")
            .bind(&habit_id)
            .bind(&log_date)
            .fetch_optional(pool.inner())
            .await
            .map_err(|e| format!("查询打卡记录失败: {}", e))?;

    if let Some(log_id) = existing {
        sqlx::query("DELETE FROM habit_logs WHERE id = $1")
            .bind(&log_id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("取消打卡失败: {}", e))?;
        Ok(false)
    } else {
        sqlx::query("INSERT INTO habit_logs (id, habit_id, log_date, count, created_at) VALUES ($1, $2, $3, 1, $4)")
            .bind(&id).bind(&habit_id).bind(&log_date).bind(&ts)
            .execute(pool.inner()).await
            .map_err(|e| format!("打卡失败: {}", e))?;
        Ok(true)
    }
}

#[tauri::command]
pub async fn habit_get_logs(
    pool: State<'_, sqlx::SqlitePool>,
    habit_id: String,
) -> CmdResult<Vec<(String, i32)>> {
    let rows = sqlx::query(
        "SELECT log_date, count FROM habit_logs WHERE habit_id = $1 ORDER BY log_date DESC",
    )
    .bind(habit_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询打卡历史失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| (r.get::<String, _>("log_date"), r.get::<i32, _>("count")))
        .collect())
}

// ─── 附件 / 文件存储 ─────────────────────────────────────

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 设置自定义附件存储路径
#[tauri::command]
pub async fn set_attachment_dir(app: AppHandle, path: String) -> CmdResult<String> {
    let dir = PathBuf::from(&path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    // 记录到 app data 目录的配置文件
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?
        .join("attachment_path.txt");
    std::fs::write(&config_path, &path).map_err(|e| format!("保存配置失败: {}", e))?;

    Ok(path)
}

/// 获取当前附件存储路径（读配置或返回默认）
#[tauri::command]
pub async fn get_attachment_path(app: AppHandle) -> CmdResult<String> {
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?
        .join("attachment_path.txt");

    if config_path.exists() {
        let path =
            std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置失败: {}", e))?;
        if std::path::Path::new(&path).exists() {
            return Ok(path);
        }
    }

    // 返回默认路径
    let default = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?
        .join("attachments");
    std::fs::create_dir_all(&default).map_err(|e| format!("创建默认附件目录失败: {}", e))?;
    Ok(default.to_string_lossy().to_string())
}

/// 保存图片（base64 数据）到附件目录，返回文件名
#[tauri::command]
pub async fn save_image(app: AppHandle, data: String, ext: String) -> CmdResult<String> {
    let dir = get_attachment_path(app.clone()).await?;
    let id = uuid();
    let filename = format!("{}.{}", id, ext);
    let filepath = PathBuf::from(&dir).join(&filename);

    // 解码 base64
    use std::io::Write;
    let bytes = base64_decode(&data)?;
    let mut file = std::fs::File::create(&filepath).map_err(|e| format!("创建文件失败: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(filename)
}

/// 获取附件的完整路径
#[tauri::command]
pub async fn get_attachment_fullpath(app: AppHandle, filename: String) -> CmdResult<String> {
    let dir = get_attachment_path(app).await?;
    Ok(PathBuf::from(&dir)
        .join(&filename)
        .to_string_lossy()
        .to_string())
}

/// 简单的 base64 解码（不依赖外部 crate）
fn base64_decode(input: &str) -> CmdResult<Vec<u8>> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input: Vec<u8> = input
        .bytes()
        .filter(|b| *b != b'\n' && *b != b'\r')
        .collect();
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;

    for byte in input {
        if byte == b'=' {
            break;
        }
        let val = TABLE
            .iter()
            .position(|&b| b == byte)
            .ok_or_else(|| "无效的 base64 字符".to_string())? as u32;
        buffer = (buffer << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(output)
}

// ─── 任务-标签关联 ────────────────────────────────────────────

#[tauri::command]
pub async fn task_get_tags(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
) -> CmdResult<Vec<crate::models::Tag>> {
    let rows = sqlx::query(
        "SELECT t.id, t.name, t.created_at, t.position FROM tags t
         JOIN task_tags tt ON t.id = tt.tag_id
         WHERE tt.task_id = $1 ORDER BY t.position ASC, t.created_at ASC",
    )
    .bind(task_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询任务标签失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| crate::models::Tag {
            id: r.get("id"),
            name: r.get("name"),
            created_at: r.get("created_at"),
            position: r.get("position"),
        })
        .collect())
}

#[tauri::command]
pub async fn task_add_tag(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    tag_id: String,
) -> CmdResult<()> {
    sqlx::query("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES ($1, $2)")
        .bind(task_id)
        .bind(tag_id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("添加任务标签失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn task_remove_tag(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    tag_id: String,
) -> CmdResult<()> {
    sqlx::query("DELETE FROM task_tags WHERE task_id = $1 AND tag_id = $2")
        .bind(task_id)
        .bind(tag_id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("移除任务标签失败: {}", e))?;
    Ok(())
}

// ─── 任务重复规则 ────────────────────────────────────────

/// 根据频率和间隔，从当前日期计算下一个 due_end_at（本地时间字面量）
fn next_recurrence_date(current_iso: &str, freq: &str, interval: i32) -> Option<String> {
    // 解析本地 NaiveDateTime（兼容 RFC 3339 与本地字面量）
    let dt = parse_local_naive(current_iso)?;
    let interval = interval.max(1) as u32; // 间隔最小为 1
    let next: Option<chrono::NaiveDateTime> = match freq {
        "daily" | "weekly" => {
            let days = if freq == "daily" {
                interval
            } else {
                interval * 7
            };
            Some(dt + chrono::Duration::days(days as i64))
        }
        "monthly" => {
            let mut year = dt.year();
            let mut month = dt.month() + interval;
            while month > 12 {
                month -= 12;
                year += 1;
            }
            let day = dt.day().min(days_in_month(year, month));
            chrono::NaiveDate::from_ymd_opt(year, month, day)
                .and_then(|d| d.and_hms_opt(dt.hour(), dt.minute(), dt.second()))
        }
        "yearly" => {
            let year = dt.year() + interval as i32;
            chrono::NaiveDate::from_ymd_opt(year, dt.month(), dt.day())
                .and_then(|d| d.and_hms_opt(dt.hour(), dt.minute(), dt.second()))
        }
        _ => return None,
    };
    Some(format_local_naive(next?))
}

/// 计算某年某月的天数
fn days_in_month(year: i32, month: u32) -> u32 {
    // 下个月的第 1 天减去本月的第 1 天
    let this_month_first = match chrono::NaiveDate::from_ymd_opt(year, month, 1) {
        Some(d) => d,
        None => return 28,
    };
    let next_month_first = if month == 12 {
        chrono::NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    match next_month_first {
        Some(d) => (d - this_month_first).num_days() as u32,
        None => 28,
    }
}

/// 懒生成重复任务实例（应用启动 + 后台定时调用）
/// 对每个设置了 recurrence_freq 的模板任务，每次扫描最多补一期（不一次性补齐历史欠账）。
/// 下一期基准由 DB 的 last_instance 查询自动提供，连续扫描会慢慢追上当前日期。
pub async fn task_generate_recurring_inner(pool: &sqlx::SqlitePool) -> Result<usize, String> {
    let now = chrono::Local::now().naive_local();
    let tomorrow_start = (now.date() + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap();
    let today_end_str = format_local_naive(tomorrow_start);

    // 查询所有模板任务（recurrence_freq IS NOT NULL）
    let templates = sqlx::query("SELECT * FROM tasks WHERE recurrence_freq IS NOT NULL")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询重复模板失败: {}", e))?;

    let mut generated = 0usize;

    for template_row in &templates {
        let template: Task = row_to_task(template_row);
        let freq = match &template.recurrence_freq {
            Some(f) => f.as_str(),
            None => continue,
        };
        let interval = template.recurrence_interval.max(1);

        // 基准日期：查询该模板已有实例的最新 due_end_at，没有则用模板自己的 due_end_at
        // 用 recurrence_origin_id 关联实例与模板（而非 parent_id，后者已回归子任务语义）
        let last_instance = sqlx::query(
            "SELECT due_end_at FROM tasks WHERE recurrence_origin_id = $1 AND due_end_at IS NOT NULL ORDER BY due_end_at DESC LIMIT 1",
        )
        .bind(&template.id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询实例失败: {}", e))?;

        let current_iso_opt = match (last_instance, &template.due_end_at) {
            (Some(row), _) => row.try_get::<String, _>("due_end_at").ok(),
            (None, Some(d)) => Some(d.clone()),
            (None, None) => continue, // 模板没有截止日期，无法生成
        };

        let Some(current_iso) = current_iso_opt else {
            continue;
        };

        // 单步生成：每次扫描最多补一期，不一次性补齐所有历史欠账。
        // 下一期基准由 DB 的 last_instance 查询（recurrence_origin_id 关联）自动提供，
        // 因此连续多次扫描会慢慢追上当前日期，每天最多补 1 个，避免一开机堆一堆过期任务。
        // 示例（每天重复）：上次是周五，周一开机 → 生成周六那期；周二扫描 → 周日那期；逐步追上。

        // 检查剩余次数（达到上限则不再生成）
        if let Some(count) = template.recurrence_count {
            if count <= 0 {
                continue;
            }
        }
        // 检查结束日期（基准已超过结束日则不再生成）
        if let Some(end_at) = &template.recurrence_end_at {
            if current_iso.as_str() > end_at.as_str() {
                continue;
            }
        }

        // 计算下一个日期
        let next_iso = match next_recurrence_date(&current_iso, freq, interval) {
            Some(d) => d,
            None => continue,
        };

        // 下一个日期 >= 明天 00:00（本地）→ 当期已存在或领先，本次无需生成
        if next_iso.as_str() >= today_end_str.as_str() {
            continue;
        }

        // 检查该日期是否已有实例（避免重复生成）
        // 用 recurrence_origin_id 关联实例与模板
        let exists = sqlx::query(
            "SELECT id FROM tasks WHERE recurrence_origin_id = $1 AND due_end_at = $2 LIMIT 1",
        )
        .bind(&template.id)
        .bind(&next_iso)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("检查实例存在失败: {}", e))?;

        if exists.is_none() {
            // 生成新实例
            // 关键：parent_id = NULL（作为根任务进列表，不再被 parent_id IS NULL 过滤掉）
            //       recurrence_origin_id = 模板 id（记录来源，parent_id 回归子任务语义）
            let new_id = uuid();
            let ts = format_local_naive(now);
            let new_sort_order = chrono::Utc::now().timestamp_millis();
            sqlx::query(
                "INSERT INTO tasks (id, title, note, list_id, parent_id, priority, due_start_at, due_end_at, done, sort_order, created_at, updated_at, completed_at, recurrence_freq, recurrence_interval, recurrence_end_at, recurrence_count, recurrence_origin_id)
                 VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 0, $8, $9, $10, NULL, NULL, 1, NULL, NULL, $11)",
            )
            .bind(&new_id)
            .bind(&template.title)
            .bind(&template.note)
            .bind(&template.list_id)
            // parent_id 显式为 NULL（见上注释）
            .bind(template.priority)
            .bind(&template.due_start_at) // 保留模板的开始日期（可优化为相对计算）
            .bind(&next_iso)
            .bind(new_sort_order)
            .bind(&ts)
            .bind(&ts)
            .bind(&template.id) // recurrence_origin_id 指向模板
            .execute(pool)
            .await
            .map_err(|e| format!("生成实例失败: {}", e))?;
            generated += 1;
        }
        // 注意：不在此手动推进 current_iso。下次扫描时 last_instance 查询会自动取刚生成的
        // 这一期作为新基准，从而实现「每次扫描补一期」的逐步追上行为。
    }

    Ok(generated)
}

#[tauri::command]
pub async fn task_generate_recurring(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<usize> {
    task_generate_recurring_inner(pool.inner()).await
}

// ─── 提醒（通知） ────────────────────────────────────────────

/// 单条待通知任务（结构化返回，方便 lib.rs 用 title/body 调 notification）
#[derive(Debug, Clone)]
pub struct PendingReminder {
    pub title: String,
    pub body: String,
}

/// 解析本地时间字面量（"YYYY-MM-DDTHH:mm:ss" 或 "YYYY-MM-DD HH:mm:ss"）。
/// 返回本地 NaiveDateTime，与 SQLite `datetime()` 函数行为一致。
/// 兼容旧的 RFC 3339 字符串（带 Z 或 ±HH:mm），按其绝对时刻转为本地 NaiveDateTime。
fn parse_local_naive(s: &str) -> Option<chrono::NaiveDateTime> {
    let trimmed = s.trim();
    // 先尝试带时区的 RFC 3339（兼容历史数据）
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.with_timezone(&chrono::Local).naive_local());
    }
    // 再尝试两种本地字面量
    for fmt in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, fmt) {
            return Some(naive);
        }
    }
    // 最后尝试无秒格式
    for fmt in ["%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, fmt) {
            return Some(naive);
        }
    }
    None
}

/// 本地时间字面量格式（与前端 toLocalIso / nowLocalIso 一致）
fn format_local_naive(naive: chrono::NaiveDateTime) -> String {
    naive.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// 扫库找"该通知但还没通知过"的任务
/// - 标准扫描：trigger_at = due_end_at - remind_offset_minutes 分钟；trigger_at <= now
/// - 启动补发：due_end_at 在过去 24h 内 且 notified_at IS NULL
pub async fn task_check_reminders_inner(
    pool: &sqlx::SqlitePool,
    on_emit: impl Fn(&PendingReminder),
) -> Result<usize, String> {
    let now = chrono::Local::now().naive_local();
    let now_str = format_local_naive(now);
    let cutoff_str = format_local_naive(now - chrono::Duration::hours(24));

    // 一次性把"待通知"任务拉出来
    // 条件：
    //   - remind_offset_minutes IS NOT NULL
    //   - due_end_at IS NOT NULL
    //   - done = 0
    //   - notified_at IS NULL
    //   - 要么 (due_end_at - offset) <= now  ← 准点/提前已到
    //   - 要么 due_end_at >= cutoff 且 due_end_at <= now  ← 应用启动补发窗口
    // SQLite 的 datetime() 无 'localtime' 时按 UTC 解释。我们的本地字面量（如
    // "2026-07-14T17:25:00"）实际表达的是墙上时刻，必须显式声明 'localtime'。
    let rows = sqlx::query(
        "SELECT id, title, due_end_at, remind_offset_minutes FROM tasks
         WHERE remind_offset_minutes IS NOT NULL
           AND due_end_at IS NOT NULL
           AND done = 0
           AND notified_at IS NULL
           AND (
             datetime(replace(due_end_at, 'T', ' '), '-' || remind_offset_minutes || ' minutes', 'localtime') <= datetime($1, 'localtime')
             OR (datetime(replace(due_end_at, 'T', ' '), 'localtime') >= datetime($2, 'localtime')
                 AND datetime(replace(due_end_at, 'T', ' '), 'localtime') <= datetime($1, 'localtime'))
           )",
    )
    .bind(&now_str)
    .bind(&cutoff_str)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询待通知任务失败: {}", e))?;

    let mut count = 0usize;
    for row in &rows {
        let task_id: String = row.get("id");
        let title: String = row.get("title");
        let due_end_at: String = row.get("due_end_at");
        let offset: i32 = row.get("remind_offset_minutes");

        // 生成通知文案
        let body = build_reminder_body(&due_end_at, offset);
        on_emit(&PendingReminder {
            title: title.clone(),
            body,
        });

        // 标记为已通知（即使通知发送失败，也不再重复）
        sqlx::query("UPDATE tasks SET notified_at = $1, updated_at = $1 WHERE id = $2")
            .bind(&now_str)
            .bind(&task_id)
            .execute(pool)
            .await
            .map_err(|e| format!("标记 notified_at 失败: {}", e))?;
        count += 1;
    }
    Ok(count)
}

/// 根据截止时间 + 偏移量生成中文通知正文
fn build_reminder_body(due_end_at: &str, offset_minutes: i32) -> String {
    let due_dt = parse_local_naive(due_end_at);
    let (time_str, date_str) = match due_dt {
        Some(d) => (
            d.format("%H:%M").to_string(),
            format!("{}月{}日", d.format("%m"), d.format("%d")),
        ),
        None => (String::new(), String::new()),
    };

    if offset_minutes <= 0 {
        if time_str.is_empty() {
            "到点了".to_string()
        } else {
            format!("到点了（{}）", time_str)
        }
    } else if offset_minutes < 60 {
        if time_str.is_empty() {
            format!("还剩 {} 分钟", offset_minutes)
        } else {
            format!("还剩 {} 分钟（{} {}）", offset_minutes, date_str, time_str)
        }
    } else {
        let hours = offset_minutes / 60;
        if time_str.is_empty() {
            format!("还剩 {} 小时", hours)
        } else {
            format!("还剩 {} 小时（{} {}）", hours, date_str, time_str)
        }
    }
}

#[tauri::command]
pub async fn task_check_reminders(
    app: tauri::AppHandle,
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<usize> {
    use tauri_plugin_notification::NotificationExt;
    let count = task_check_reminders_inner(pool.inner(), |reminder| {
        let res = app
            .notification()
            .builder()
            .title(&reminder.title)
            .body(&reminder.body)
            .show();
        if let Err(e) = res {
            eprintln!("[JustToDo] 通知失败：{}", e);
        }
    })
    .await?;
    Ok(count)
}

// ─── 应用设置 ────────────────────────────────────────────

/// 查询设置（纯函数版本，供内部调用）
pub async fn get_setting_inner(
    pool: &sqlx::SqlitePool,
    key: String,
) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = $1")
        .bind(&key)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询设置失败: {}", e))?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}

#[tauri::command]
pub async fn get_setting(
    pool: State<'_, sqlx::SqlitePool>,
    key: String,
) -> CmdResult<Option<String>> {
    get_setting_inner(pool.inner(), key).await
}

#[tauri::command]
pub async fn set_setting(
    pool: State<'_, sqlx::SqlitePool>,
    interval: tauri::State<'_, std::sync::Arc<std::sync::atomic::AtomicU64>>,
    key: String,
    value: String,
) -> CmdResult<()> {
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT(key) DO UPDATE SET value = $2",
    )
    .bind(&key)
    .bind(&value)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("保存设置失败: {}", e))?;

    // 如果是检查间隔设置，同步更新内存中的 AtomicU64（分钟 → 秒）
    if key == "recurrence_check_interval" {
        if let Ok(mins) = value.parse::<u64>() {
            interval.store(mins * 60, std::sync::atomic::Ordering::Relaxed);
        }
    }
    Ok(())
}
