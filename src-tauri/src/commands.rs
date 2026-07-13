// Tauri 命令 —— 前端通过 invoke() 调用这些函数
// 所有命令返回 Result<T, String>，错误信息清晰传到前端

use sqlx::Row;
use tauri::State;

use crate::models::*;

type CmdResult<T> = Result<T, String>;

// ─── 工具函数 ────────────────────────────────────────────

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 根据 sort_field + sort_dir 生成 ORDER BY 子句（不含前缀 "ORDER BY "）
/// 总是先按 done 排（未完成在前），再按用户指定字段
fn order_by_clause(sort_field: &str, sort_dir: &str) -> String {
    let dir = if sort_dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
    match sort_field {
        "priority" => format!("priority {}, sort_order ASC", if dir == "ASC" { "DESC" } else { "ASC" }), // 默认 desc
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
        .bind(&name).bind(&color).bind(&id)
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
pub async fn task_count_by_list(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<(String, i64)>> {
    let rows = sqlx::query(
        "SELECT list_id, COUNT(*) as cnt FROM tasks WHERE parent_id IS NULL AND done = 0 GROUP BY list_id"
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("统计任务数量失败: {}", e))?;

    Ok(rows.iter().map(|r| (r.get::<String, _>("list_id"), r.get::<i64, _>("cnt"))).collect())
}

/// 统计各标签的未完成根任务数量（供侧边栏显示）
#[tauri::command]
pub async fn task_count_by_tag(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<(String, i64)>> {
    let rows = sqlx::query(
        "SELECT tt.tag_id, COUNT(*) as cnt
         FROM task_tags tt
         JOIN tasks t ON t.id = tt.task_id
         WHERE t.parent_id IS NULL AND t.done = 0
         GROUP BY tt.tag_id"
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("统计标签任务数量失败: {}", e))?;

    Ok(rows.iter().map(|r| (r.get::<String, _>("tag_id"), r.get::<i64, _>("cnt"))).collect())
}

/// 统计智能视图的未完成根任务数量
#[tauri::command]
pub async fn task_count_smart_view(
    pool: State<'_, sqlx::SqlitePool>,
    view: String,
) -> CmdResult<i64> {
    let today = chrono::Utc::now().date_naive();
    let end_of_today = (today + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let end_of_week = (today + chrono::Duration::days(7))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    let count: i64 = if view == "today" {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0 AND due_end_at < $1"
        )
        .bind(&end_of_today)
        .fetch_one(pool.inner())
        .await
    } else if view == "upcoming" {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0 AND due_end_at >= $1 AND due_end_at < $2"
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
        "list" => {
            sqlx::query("SELECT sort_field, sort_dir FROM lists WHERE id = $1")
                .bind(pref_id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten()
        }
        "tag" => {
            sqlx::query("SELECT sort_field, sort_dir FROM tag_sort_prefs WHERE tag_id = $1")
                .bind(pref_id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten()
        }
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

#[tauri::command]
pub async fn task_get_smart_view(
    pool: State<'_, sqlx::SqlitePool>,
    view: String,
    sort_field: Option<String>,
    sort_dir: Option<String>,
) -> CmdResult<Vec<Task>> {
    let today = chrono::Utc::now().date_naive();
    let end_of_today = (today + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let end_of_week = (today + chrono::Duration::days(7))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    // today / upcoming 固定按日期+优先级；all 支持可选排序
    let sql = if view == "today" {
        "SELECT * FROM tasks WHERE parent_id IS NULL AND done = 0 AND due_end_at < $1 ORDER BY due_end_at ASC, priority DESC, sort_order ASC".to_string()
    } else if view == "upcoming" {
        "SELECT * FROM tasks WHERE parent_id IS NULL AND done = 0 AND due_end_at >= $1 AND due_end_at < $2 ORDER BY due_end_at ASC, priority DESC, sort_order ASC".to_string()
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

    sqlx::query(
        "INSERT INTO tasks (id, title, note, list_id, parent_id, priority, due_start_at, due_end_at, done, sort_order, created_at, updated_at, completed_at)
         VALUES ($1, $2, '', $3, $4, $5, $6, $7, 0, $8, $9, $10, NULL)",
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
            .bind(title).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(note) = &input.note {
        sqlx::query("UPDATE tasks SET note = $1, updated_at = $2 WHERE id = $3")
            .bind(note).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(priority) = input.priority {
        sqlx::query("UPDATE tasks SET priority = $1, updated_at = $2 WHERE id = $3")
            .bind(priority).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(due_start_at) = &input.due_start_at {
        sqlx::query("UPDATE tasks SET due_start_at = $1, updated_at = $2 WHERE id = $3")
            .bind(due_start_at).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(due_end_at) = &input.due_end_at {
        sqlx::query("UPDATE tasks SET due_end_at = $1, updated_at = $2 WHERE id = $3")
            .bind(due_end_at).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    if let Some(list_id) = &input.list_id {
        sqlx::query("UPDATE tasks SET list_id = $1, updated_at = $2 WHERE id = $3")
            .bind(list_id).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新任务失败: {}", e))?;
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
    let rows = sqlx::query("SELECT id, name, created_at FROM tags ORDER BY name ASC")
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("查询标签失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| Tag {
            id: r.get("id"),
            name: r.get("name"),
            created_at: r.get("created_at"),
        })
        .collect())
}

#[tauri::command]
pub async fn tag_create(pool: State<'_, sqlx::SqlitePool>, name: String) -> CmdResult<Tag> {
    let id = uuid();
    let ts = now();

    sqlx::query("INSERT INTO tags (id, name, created_at) VALUES ($1, $2, $3)")
        .bind(&id).bind(&name).bind(&ts)
        .execute(pool.inner()).await
        .map_err(|e| format!("创建标签失败: {}", e))?;

    Ok(Tag { id, name, created_at: ts })
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
    sqlx::query(
        "UPDATE lists SET sort_field = $1, sort_dir = $2 WHERE id = $3",
    )
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

#[tauri::command]
pub async fn tag_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM tags WHERE id = $1")
        .bind(&id)
        .execute(pool.inner()).await
        .map_err(|e| format!("删除标签失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn tag_rename(pool: State<'_, sqlx::SqlitePool>, id: String, name: String) -> CmdResult<()> {
    sqlx::query("UPDATE tags SET name = $1 WHERE id = $2")
        .bind(&name).bind(&id)
        .execute(pool.inner()).await
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
}

#[tauri::command]
pub async fn habit_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<HabitWithStats>> {
    let rows = sqlx::query("SELECT id, name, color, repeat_rule, target_count, remind_at, created_at FROM habits ORDER BY created_at ASC")
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("查询习惯失败: {}", e))?;

    let today = chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string();
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
        };

        let today_count: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(count), 0) FROM habit_logs WHERE habit_id = $1 AND log_date = $2"
        )
        .bind(&id).bind(&today)
        .fetch_one(pool.inner()).await.unwrap_or(0);

        let total_days: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT log_date) FROM habit_logs WHERE habit_id = $1"
        )
        .bind(&id)
        .fetch_one(pool.inner()).await.unwrap_or(0);

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

    sqlx::query(
        "INSERT INTO habits (id, name, color, repeat_rule, target_count, remind_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)"
    )
    .bind(&id).bind(&input.name).bind(&color).bind(&repeat_rule)
    .bind(target_count).bind(&input.remind_at).bind(&ts)
    .execute(pool.inner()).await
    .map_err(|e| format!("创建习惯失败: {}", e))?;

    Ok(Habit {
        id, name: input.name, color, repeat_rule, target_count,
        remind_at: input.remind_at, created_at: ts,
    })
}

#[tauri::command]
pub async fn habit_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM habits WHERE id = $1")
        .bind(&id)
        .execute(pool.inner()).await
        .map_err(|e| format!("删除习惯失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn habit_toggle_check(
    pool: State<'_, sqlx::SqlitePool>,
    habit_id: String,
    date: Option<String>,
) -> CmdResult<bool> {
    let log_date = date.unwrap_or_else(|| chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string());
    let id = uuid();
    let ts = now();

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM habit_logs WHERE habit_id = $1 AND log_date = $2"
    )
    .bind(&habit_id).bind(&log_date)
    .fetch_optional(pool.inner()).await
    .map_err(|e| format!("查询打卡记录失败: {}", e))?;

    if let Some(log_id) = existing {
        sqlx::query("DELETE FROM habit_logs WHERE id = $1")
            .bind(&log_id)
            .execute(pool.inner()).await
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
        "SELECT log_date, count FROM habit_logs WHERE habit_id = $1 ORDER BY log_date DESC"
    )
    .bind(habit_id)
    .fetch_all(pool.inner()).await
    .map_err(|e| format!("查询打卡历史失败: {}", e))?;

    Ok(rows.iter().map(|r| (r.get::<String, _>("log_date"), r.get::<i32, _>("count"))).collect())
}

// ─── 附件 / 文件存储 ─────────────────────────────────────

use tauri::{AppHandle, Manager};
use std::path::PathBuf;

/// 获取附件存储目录（用户配置或默认 app data/attachments）
#[tauri::command]
pub async fn get_attachment_dir(app: AppHandle) -> CmdResult<String> {
    let dir = app.path().app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?
        .join("attachments");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建附件目录失败: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 设置自定义附件存储路径
#[tauri::command]
pub async fn set_attachment_dir(app: AppHandle, path: String) -> CmdResult<String> {
    let dir = PathBuf::from(&path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    // 记录到 app data 目录的配置文件
    let config_path = app.path().app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?
        .join("attachment_path.txt");
    std::fs::write(&config_path, &path)
        .map_err(|e| format!("保存配置失败: {}", e))?;

    Ok(path)
}

/// 获取当前附件存储路径（读配置或返回默认）
#[tauri::command]
pub async fn get_attachment_path(app: AppHandle) -> CmdResult<String> {
    let config_path = app.path().app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?
        .join("attachment_path.txt");

    if config_path.exists() {
        let path = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置失败: {}", e))?;
        if std::path::Path::new(&path).exists() {
            return Ok(path);
        }
    }

    // 返回默认路径
    let default = app.path().app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?
        .join("attachments");
    std::fs::create_dir_all(&default)
        .map_err(|e| format!("创建默认附件目录失败: {}", e))?;
    Ok(default.to_string_lossy().to_string())
}

/// 保存图片（base64 数据）到附件目录，返回文件名
#[tauri::command]
pub async fn save_image(
    app: AppHandle,
    data: String,
    ext: String,
) -> CmdResult<String> {
    let dir = get_attachment_path(app.clone()).await?;
    let id = uuid();
    let filename = format!("{}.{}", id, ext);
    let filepath = PathBuf::from(&dir).join(&filename);

    // 解码 base64
    use std::io::Write;
    let bytes = base64_decode(&data)?;
    let mut file = std::fs::File::create(&filepath)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(filename)
}

/// 获取附件的完整路径
#[tauri::command]
pub async fn get_attachment_fullpath(
    app: AppHandle,
    filename: String,
) -> CmdResult<String> {
    let dir = get_attachment_path(app).await?;
    Ok(PathBuf::from(&dir).join(&filename).to_string_lossy().to_string())
}

/// 简单的 base64 解码（不依赖外部 crate）
fn base64_decode(input: &str) -> CmdResult<Vec<u8>> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input: Vec<u8> = input.bytes().filter(|b| *b != b'\n' && *b != b'\r').collect();
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;

    for byte in input {
        if byte == b'=' { break; }
        let val = TABLE.iter().position(|&b| b == byte)
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
        "SELECT t.id, t.name, t.created_at FROM tags t
         JOIN task_tags tt ON t.id = tt.tag_id
         WHERE tt.task_id = $1 ORDER BY t.name ASC"
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
        })
        .collect())
}

#[tauri::command]
pub async fn task_add_tag(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    tag_id: String,
) -> CmdResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES ($1, $2)"
    )
    .bind(task_id).bind(tag_id)
    .execute(pool.inner()).await
    .map_err(|e| format!("添加任务标签失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn task_remove_tag(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    tag_id: String,
) -> CmdResult<()> {
    sqlx::query(
        "DELETE FROM task_tags WHERE task_id = $1 AND tag_id = $2"
    )
    .bind(task_id).bind(tag_id)
    .execute(pool.inner()).await
    .map_err(|e| format!("移除任务标签失败: {}", e))?;
    Ok(())
}
