// Tauri 命令 —— 前端通过 invoke() 调用这些函数
// 所有命令返回 Result<T, String>，错误信息清晰传到前端

use chrono::{Datelike, Timelike};
use sqlx::Row;
use tauri::State;

use crate::models::*;

pub(crate) type CmdResult<T> = Result<T, String>;

// ─── 工具函数 ────────────────────────────────────────────

/// 生成 UUID v4 字符串（crate 内可见，供 list_schedule 等模块复用）
pub(crate) fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 当前本地时间字面量（"YYYY-MM-DDTHH:mm:ss"），与前端 toLocalIso 输出格式一致
pub(crate) fn now() -> String {
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
pub(crate) fn row_to_task(row: &sqlx::sqlite::SqliteRow) -> Task {
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
        // recurrence_paused NOT NULL DEFAULT 0，try_get 容错（旧库迁移前可能无此列）
        recurrence_paused: row.try_get("recurrence_paused").ok().unwrap_or(false),
        remind_offset_minutes: row.try_get("remind_offset_minutes").ok().flatten(),
        remind_at: row.try_get("remind_at").ok().flatten(),
        notified_at: row.try_get("notified_at").ok().flatten(),
        // checklist 存的是 JSON 字符串，反序列化为 Vec
        // 字段 NOT NULL DEFAULT '[]'，所以一定存在；解析失败则为空列表
        checklist: row
            .try_get::<String, _>("checklist")
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<ChecklistItem>>(&s).ok())
            .unwrap_or_default(),
        // attachments 同 checklist：JSON 字符串，解析失败为空列表
        attachments: row
            .try_get::<String, _>("attachments")
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Attachment>>(&s).ok())
            .unwrap_or_default(),
        // kind 用 try_get 容错（极旧库可能无此列，缺省视为 'task'）
        kind: row
            .try_get::<String, _>("kind")
            .unwrap_or_else(|_| "task".to_string()),
        // group_id 用 try_get 容错（迁移前可能无此列）
        group_id: row.try_get("group_id").ok().flatten(),
        // title_url 用 try_get 容错（migration 029 前可能无此列）
        title_url: row.try_get("title_url").ok().flatten(),
        // deleted_at 用 try_get 容错（migration 035 前可能无此列）
        deleted_at: row.try_get("deleted_at").ok().flatten(),
    }
}

// ─── 清单操作 ────────────────────────────────────────────

/// 从行数据提取 TaskList（trash 模块的清单详情命令复用）
pub(crate) fn row_to_list(row: &sqlx::sqlite::SqliteRow) -> TaskList {
    TaskList {
        id: row.get("id"),
        name: row.get("name"),
        color: row.get("color"),
        position: row.get("position"),
        created_at: row.get("created_at"),
        parent_id: row.get("parent_id"),
        is_folder: row.get::<i32, _>("is_folder") != 0,
        archived: row.get::<i32, _>("archived") != 0,
        kind: row.try_get("kind").unwrap_or_else(|_| "task".to_string()),
        deleted_at: row.try_get("deleted_at").ok().flatten(),
    }
}

#[tauri::command]
pub async fn list_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<TaskList>> {
    // 含已删除（deleted_at 非空）的清单：与 archived 同模式，后端全量返回、前端筛分
    let rows = sqlx::query(
        "SELECT id, name, color, position, created_at, parent_id, is_folder, archived, kind, deleted_at FROM lists ORDER BY position ASC, created_at ASC"
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询清单失败: {}", e))?;

    Ok(rows.iter().map(row_to_list).collect())
}

#[tauri::command]
pub async fn list_create(
    pool: State<'_, sqlx::SqlitePool>,
    name: String,
    color: String,
    parent_id: Option<String>,
    is_folder: Option<bool>,
    kind: Option<String>,
) -> CmdResult<TaskList> {
    let id = uuid();
    let ts = now();
    let position = chrono::Utc::now().timestamp_millis();
    let is_folder_val = if is_folder.unwrap_or(false) { 1 } else { 0 };
    // kind 不传默认 'task'（待办清单/目录）；'note' = 笔记本/笔记本目录
    let kind_val = kind.unwrap_or_else(|| "task".to_string());

    sqlx::query(
        "INSERT INTO lists (id, name, color, position, created_at, parent_id, is_folder, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&color)
    .bind(position)
    .bind(&ts)
    .bind(&parent_id)
    .bind(is_folder_val)
    .bind(&kind_val)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建清单失败: {}", e))?;

    // 待办清单（非目录、非笔记本）创建后立即建默认分组 {id}-default。
    // 否则新建任务的 group_id 指向不存在的分组，在分组视图凭空消失。
    if is_folder_val == 0 && kind_val == "task" {
        let default_group_id = format!("{}-default", id);
        sqlx::query(
            "INSERT OR IGNORE INTO groups (id, list_id, name, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&default_group_id)
        .bind(&id)
        .bind("默认分组")
        .bind(0)
        .bind(&ts)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("创建默认分组失败: {}", e))?;
    }

    Ok(TaskList {
        id,
        name,
        color,
        position,
        created_at: ts,
        parent_id,
        is_folder: is_folder_val != 0,
        archived: false,
        kind: kind_val,
        deleted_at: None,
    })
}

#[tauri::command]
pub async fn list_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    if id == "inbox" {
        return Err("收件箱不能删除".to_string());
    }
    if id == "default-notebook" {
        return Err("默认笔记本不能删除".to_string());
    }
    // 回收站语义（migration 035 起）：删除 = 软删除整棵子树——
    // 目录 + 所有后代清单/子目录 + 这些清单下的全部任务/笔记一起标记 deleted_at。
    // 恢复时整棵树回来（trash_restore）；彻底删除走 trash_purge/trash_empty。
    // 旧实现（任务迁默认容器 + 子清单上提 + 硬删本体）已被整体替换。
    crate::trash::list_trash(pool.inner(), &id).await
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

/// 仅修改清单/笔记本/目录的颜色（不涉及重命名；收件箱/默认笔记本也可换色）。
/// 独立命令而非复用 list_rename：list_rename 拒绝收件箱且必须同时传名称，
/// 侧边栏色点直接换色需要"只改颜色"的单一职责入口。
#[tauri::command]
pub async fn list_set_color(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    color: String,
) -> CmdResult<()> {
    sqlx::query("UPDATE lists SET color = $1 WHERE id = $2")
        .bind(&color)
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("更新颜色失败: {}", e))?;
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
    // 循环防护（纵深防御，前端菜单已过滤）：不能挂到自己名下（直接自挂），
    // 也不能挂到自己的后代目录下（会造成父子环，整棵子树无法再遍历）。
    if let Some(pid) = &parent_id {
        if pid == &id {
            return Err("清单/目录不能移动到自身".to_string());
        }
        // WITH RECURSIVE 查出被移动节点的全部后代 id，目标父级在其中则拒绝
        let row = sqlx::query(
            "WITH RECURSIVE subtree(id) AS (
                 SELECT id FROM lists WHERE id = $1
                 UNION ALL
                 SELECT l.id FROM lists l JOIN subtree s ON l.parent_id = s.id
             )
             SELECT EXISTS(SELECT 1 FROM subtree WHERE id = $2) AS in_subtree",
        )
        .bind(&id)
        .bind(pid)
        .fetch_one(pool.inner())
        .await
        .map_err(|e| format!("移动清单失败: {}", e))?;
        let in_subtree: i64 = row.get("in_subtree");
        if in_subtree != 0 {
            return Err("清单/目录不能移动到自己的子目录下".to_string());
        }
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

/// 归档整棵子树（id 自身 + 所有后代清单与子目录），archived 列置 1。
/// 任务本身**不动**（list_id 不变），仅随归属清单一起在主页隐藏。
/// - inbox 硬保护（与 delete/rename/move 同样不允许）
/// - 用 SQLite WITH RECURSIVE 一次 SQL 找出整棵子树，避免多条往返
#[tauri::command]
pub async fn list_archive_tree(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    if id == "inbox" {
        return Err("收件箱不能归档".to_string());
    }
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM lists WHERE id = $1
             UNION ALL
             SELECT l.id FROM lists l JOIN subtree s ON l.parent_id = s.id
         )
         UPDATE lists SET archived = 1
         WHERE id IN (SELECT id FROM subtree)",
    )
    .bind(&id)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("归档清单失败: {}", e))?;
    Ok(())
}

/// 取消归档：仅把 id 自身 + 祖先链上的"被归档"项批量置 0。
/// 设计原因：归档是以树为单位操作的，但取消归档可以挑某个子项恢复。
/// 如果只置 id 自身为 0 而不动其祖先，会出现"父级 archived=1、子项 archived=0"的中间态——
/// 这时子项在侧边栏主页与归档区都找不到（成为"孤儿"）。
/// 修复：让取消归档自动顺带把 archived 祖先链一并恢复，使该子项能回到原父级正常显示。
/// - 后代不动（仍 archived=1，归档区可见，与其他兄弟同处）
/// - 同级兄弟不动（仍 archived=1）
/// - 遇到第一个 archived=0 的祖先即停（再上层是另一棵 active 树，不卷入）
#[tauri::command]
pub async fn list_unarchive_tree(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    if id == "inbox" {
        return Err("收件箱不能取消归档".to_string());
    }
    // 校验目标存在
    let row = sqlx::query("SELECT id FROM lists WHERE id = $1")
        .bind(&id)
        .fetch_optional(pool.inner())
        .await
        .map_err(|e| format!("查询失败: {}", e))?;
    if row.is_none() {
        return Err("清单不存在".to_string());
    }
    // 沿 parent **向上**溯，仅爬"archived=1"的祖先，遇到 archived=0 即停——
    // 这条策略与"整树恢复"对称：恢复 X 自身 + 把所有 archived 父级（即祖先链）
    // 一起置 0，使 X 能回到原父级正常显示。
    // 关键 SQL：JOIN 条件必须是 l.parent_id = c.id（找 X 的"父亲"，再找"父亲的父亲"），
    // 而**不能**是 c.parent_id = l.id（后者会让 X 同级也被错误纳入，等效"整树恢复"反语义版本）。
    sqlx::query(
        "WITH RECURSIVE chain(id) AS (
             SELECT id FROM lists WHERE id = $1
             UNION ALL
             SELECT l.id FROM lists l
             JOIN chain c ON l.parent_id = c.id
             WHERE l.archived = 1
         )
         UPDATE lists SET archived = 0
         WHERE id IN (SELECT id FROM chain) AND archived = 1",
    )
    .bind(&id)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("取消归档失败: {}", e))?;
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
/// 归属已归档清单的任务不计入角标（归档清单虽仍含任务，但不再进主页统计）；
/// 已移入回收站的任务（deleted_at 非空）一律不计入。
#[tauri::command]
pub async fn task_count_by_list(
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<Vec<(String, i64)>> {
    let rows = sqlx::query(
        "SELECT t.list_id, COUNT(*) as cnt
         FROM tasks t
         WHERE t.parent_id IS NULL
           AND t.done = 0
           AND t.deleted_at IS NULL
           AND t.list_id NOT IN (SELECT id FROM lists WHERE archived = 1)
         GROUP BY t.list_id",
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
/// 注意：标签全局共用（任务和笔记都可打标签），但角标只统计待办（kind='task'），
/// 笔记无"未完成"概念，不进角标计数。
#[tauri::command]
pub async fn task_count_by_tag(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<(String, i64)>> {
    let rows = sqlx::query(
        "SELECT tt.tag_id, COUNT(*) as cnt
         FROM task_tags tt
         JOIN tasks t ON t.id = tt.task_id
         WHERE t.parent_id IS NULL AND t.done = 0 AND t.kind = 'task' AND t.deleted_at IS NULL
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
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0 AND deleted_at IS NULL AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($1, 'localtime')"
        )
        .bind(&end_of_today)
        .fetch_one(pool.inner())
        .await
    } else if view == "upcoming" {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0 AND deleted_at IS NULL AND datetime(replace(due_end_at, 'T', ' '), 'localtime') >= datetime($1, 'localtime') AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($2, 'localtime')"
        )
        .bind(&end_of_today)
        .bind(&end_of_week)
        .fetch_one(pool.inner())
        .await
    } else {
        // all 视图：统计全部未完成根待办（笔记无日期，不属于"全部待办"，按 kind 过滤）
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks WHERE parent_id IS NULL AND done = 0 AND kind = 'task' AND deleted_at IS NULL"
        )
        .fetch_one(pool.inner())
        .await
    }
    .map_err(|e| format!("统计智能视图任务失败: {}", e))?;

    Ok(count)
}

/// 统计各笔记本的条目数量（供侧边栏显示）
/// 与 task_count_by_list 的区别：
/// - 只统计笔记（kind='note'），不统计待办
/// - 不按 done 过滤（笔记无完成概念，done 恒为 0）
/// - 归属已归档笔记本的笔记不计入角标
#[tauri::command]
pub async fn note_count_by_list(
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<Vec<(String, i64)>> {
    let rows = sqlx::query(
        "SELECT t.list_id, COUNT(*) as cnt
         FROM tasks t
         WHERE t.parent_id IS NULL
           AND t.kind = 'note'
           AND t.deleted_at IS NULL
           AND t.list_id NOT IN (SELECT id FROM lists WHERE archived = 1)
         GROUP BY t.list_id",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("统计笔记数量失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| (r.get::<String, _>("list_id"), r.get::<i64, _>("cnt")))
        .collect())
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
        "SELECT * FROM tasks WHERE list_id = $1 AND parent_id IS NULL AND deleted_at IS NULL ORDER BY done ASC, {}",
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
        // 注意：DB 中 sort_field / sort_dir 可能存成空字符串 ""（历史数据），
        // 空字符串必须视为无效值并回退到默认值 "manual"/"asc"，
        // 否则前端 currentSort.field 变成 ""，导致 canDrag 恒为 false、任务无法拖拽。
        let f: Option<String> = row
            .try_get("sort_field")
            .ok()
            .filter(|s: &String| !s.is_empty());
        let d: Option<String> = row
            .try_get("sort_dir")
            .ok()
            .filter(|s: &String| !s.is_empty());
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
    // 区间相交匹配：开始日期用 COALESCE(due_start_at, due_end_at) 兜底，
    // 结束日期用 COALESCE(due_end_at, due_start_at) 兜底。
    // 这样只有 due_end_at（无开始日期）的任务也能被查到——开始=结束=due_end_at，
    // 作为单点任务显示，避免在时间线/日历凭空消失。
    let sql = format!(
        "SELECT * FROM tasks
         WHERE COALESCE(due_start_at, due_end_at) IS NOT NULL
           AND COALESCE(due_start_at, due_end_at) <= $2
           AND COALESCE(due_end_at, due_start_at) >= $1
           AND deleted_at IS NULL
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
        "SELECT * FROM tasks WHERE parent_id IS NULL AND done = 0 AND deleted_at IS NULL AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($1, 'localtime') ORDER BY due_end_at ASC, priority DESC, sort_order ASC".to_string()
    } else if view == "upcoming" {
        "SELECT * FROM tasks WHERE parent_id IS NULL AND done = 0 AND deleted_at IS NULL AND datetime(replace(due_end_at, 'T', ' '), 'localtime') >= datetime($1, 'localtime') AND datetime(replace(due_end_at, 'T', ' '), 'localtime') < datetime($2, 'localtime') ORDER BY due_end_at ASC, priority DESC, sort_order ASC".to_string()
    } else {
        // all 视图支持 sort
        let (sf, sd) = match (sort_field.as_deref(), sort_dir.as_deref()) {
            (Some(f), Some(d)) => (f.to_string(), d.to_string()),
            _ => ("manual".to_string(), "asc".to_string()),
        };
        format!(
            "SELECT * FROM tasks WHERE parent_id IS NULL AND kind = 'task' AND deleted_at IS NULL ORDER BY done ASC, {}",
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
    let remind_at = input.remind_at.clone();
    // kind 不传默认 'task'（待办）；'note' = 笔记（复用 tasks 表，但无日期/完成/重复/提醒）
    let kind = input.kind.clone().unwrap_or_else(|| "task".to_string());
    // group_id 不传则用清单的默认分组
    let group_id = input
        .group_id
        .clone()
        .unwrap_or_else(|| format!("{}-default", input.list_id));

    sqlx::query(
        "INSERT INTO tasks (id, title, note, list_id, parent_id, priority, due_start_at, due_end_at, done, sort_order, created_at, updated_at, completed_at, recurrence_freq, recurrence_interval, recurrence_end_at, recurrence_count, remind_offset_minutes, remind_at, kind, group_id)
         VALUES ($1, $2, '', $3, $4, $5, $6, $7, 0, $8, $9, $10, NULL, $11, $12, $13, $14, $15, $16, $17, $18)",
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
    .bind(&remind_at)
    .bind(&kind)
    .bind(&group_id)
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
        // 新建任务默认未暂停（DB DEFAULT 0 也保证）
        recurrence_paused: false,
        remind_offset_minutes,
        remind_at,
        notified_at: None,
        checklist: Vec::new(),
        attachments: Vec::new(),
        kind,
        group_id: Some(group_id),
        // 新建任务默认无标题链接（DB NULL 也保证）
        title_url: None,
        // 新建任务未删除（DB NULL 也保证）
        deleted_at: None,
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
    // 日期字段为 Option<Option<String>>：Some(Some(v)) 更新为 v，
    // Some(None) 显式清空（设 NULL），None 表示不更新（字段未传）
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
        // 移动任务到新清单时，group_id 必须同步回退到新清单的默认分组，
        // 否则旧清单的 group_id 在新清单里不存在，任务会在分组视图丢失。
        // 若调用方显式传了 groupId（下方 group_id 分支），会覆盖此默认值。
        let new_default_group = format!("{}-default", list_id);
        sqlx::query("UPDATE tasks SET list_id = $1, group_id = $2, updated_at = $3 WHERE id = $4")
            .bind(list_id)
            .bind(&new_default_group)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新任务失败: {}", e))?;
    }
    // group_id：Option<Option<String>>，Some(Some(v)) 改分组，Some(None) 清空回默认
    if let Some(group_id) = &input.group_id {
        sqlx::query("UPDATE tasks SET group_id = $1, updated_at = $2 WHERE id = $3")
            .bind(group_id)
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
    // 相对提醒规则（Option<Option<i32>> 允许显式清空）
    if let Some(remind) = &input.remind_offset_minutes {
        // 任何对提醒规则的修改都重置 notified_at，避免改完规则却不再通知；
        // 同时清空 remind_at（与「指定时刻提醒」互斥，二者只能存其一）
        sqlx::query("UPDATE tasks SET remind_offset_minutes = $1, remind_at = NULL, notified_at = NULL, updated_at = $2 WHERE id = $3")
            .bind(remind).bind(&ts).bind(&id)
            .execute(pool.inner()).await
            .map_err(|e| format!("更新提醒失败: {}", e))?;
    }
    // 指定时刻提醒（Option<Option<String>> 允许显式清空；与 remind_offset_minutes 互斥）
    if let Some(remind_at) = &input.remind_at {
        let r: Option<&str> = remind_at.as_deref();
        sqlx::query("UPDATE tasks SET remind_at = $1, remind_offset_minutes = NULL, notified_at = NULL, updated_at = $2 WHERE id = $3")
            .bind(r).bind(&ts).bind(&id)
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
    // 附件列表（整组覆盖为 JSON 数组；与 checklist 完全对称）
    if let Some(attachments) = &input.attachments {
        let json =
            serde_json::to_string(attachments).map_err(|e| format!("序列化附件失败: {}", e))?;
        sqlx::query("UPDATE tasks SET attachments = $1, updated_at = $2 WHERE id = $3")
            .bind(json)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新附件失败: {}", e))?;
    }

    // kind 转换（任务↔笔记）：转换时清理目标类型不用的字段。
    //  - 转笔记（kind='note'）：清空日期/完成态/重复/提醒（笔记无这些概念）
    //  - 转任务（kind='task'）：同上字段一并清空（由调用方决定是否后续重新设置）
    // 同时落默认笔记本（notebook）或收件箱（inbox）的默认分组，避免跨容器 group_id 孤儿。
    if let Some(kind) = &input.kind {
        if kind == "note" {
            sqlx::query(
                "UPDATE tasks
                 SET kind = 'note', done = 0, completed_at = NULL,
                     due_start_at = NULL, due_end_at = NULL,
                     recurrence_freq = NULL, recurrence_interval = 1,
                     recurrence_end_at = NULL, recurrence_count = NULL,
                     remind_offset_minutes = NULL, remind_at = NULL, notified_at = NULL,
                     list_id = 'default-notebook',
                     group_id = 'default-notebook-default',
                     updated_at = $1
                 WHERE id = $2",
            )
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("转换笔记失败: {}", e))?;
        } else {
            sqlx::query("UPDATE tasks SET kind = 'task', updated_at = $1 WHERE id = $2")
                .bind(&ts)
                .bind(&id)
                .execute(pool.inner())
                .await
                .map_err(|e| format!("转换任务失败: {}", e))?;
        }
    }

    // 标题关联 URL（Option<Option<String>>：Some(Some(v)) 更新为 v，Some(None) 解除链接）
    if let Some(title_url) = &input.title_url {
        sqlx::query("UPDATE tasks SET title_url = $1, updated_at = $2 WHERE id = $3")
            .bind(title_url)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新标题链接失败: {}", e))?;
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
    // 回收站语义（migration 035 起）：删除 = 软删除该任务及其全部子任务
    // （WITH RECURSIVE 标记 deleted_at），恢复走 trash_restore。
    // 注意：不再清理 recurrence_generated —— 保留生成历史，
    // 恢复后不会重复生成历史日期的实例；彻底删除（trash_purge）时才清理。
    crate::trash::task_trash(pool.inner(), &id).await
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
        "SELECT * FROM tasks WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(parent_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询子任务失败: {}", e))?;

    Ok(rows.iter().map(row_to_task).collect())
}

/// 查询可作为「关联主任务/主笔记」的候选：全部清单/笔记本的未完成一级条目。
/// 排除自身（exclude_id）+ 排除归档清单内条目；按 kind 过滤（'task' 或 'note'）。
/// 候选都是一级条目，挂载后变二级就不再出现在候选里，天然无循环挂载风险。
#[tauri::command]
pub async fn task_get_root_candidates(
    pool: State<'_, sqlx::SqlitePool>,
    exclude_id: String,
    kind: String,
) -> CmdResult<Vec<Task>> {
    let rows = sqlx::query(
        "SELECT * FROM tasks
         WHERE parent_id IS NULL AND done = 0 AND kind = $2
           AND deleted_at IS NULL
           AND id != $1
           AND list_id NOT IN (SELECT id FROM lists WHERE archived = 1)
         ORDER BY list_id, sort_order ASC",
    )
    .bind(exclude_id)
    .bind(kind)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询候选主任务失败: {}", e))?;

    Ok(rows.iter().map(row_to_task).collect())
}

/// 把任务挂为另一任务的子任务（关联主任务）。
/// 跨清单时同步子任务的 list_id / group_id 到父任务所在清单，避免跨清单 group_id 孤儿。
/// 父任务必须存在（调用方保证）。
#[tauri::command]
pub async fn task_set_parent(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    parent_id: String,
) -> CmdResult<()> {
    // 查父任务的 list_id（用于跨清单同步）
    let parent: Option<(String,)> = sqlx::query_as("SELECT list_id FROM tasks WHERE id = $1")
        .bind(&parent_id)
        .fetch_optional(pool.inner())
        .await
        .map_err(|e| format!("查询父任务失败: {}", e))?;
    let parent_list_id = parent
        .map(|(l,)| l)
        .ok_or_else(|| format!("父任务不存在: {}", parent_id))?;
    let group_id = format!("{}-default", parent_list_id);

    let ts = now();
    sqlx::query(
        "UPDATE tasks
         SET parent_id = $1, list_id = $2, group_id = $3, updated_at = $4
         WHERE id = $5",
    )
    .bind(&parent_id)
    .bind(&parent_list_id)
    .bind(&group_id)
    .bind(&ts)
    .bind(&task_id)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("关联主任务失败: {}", e))?;

    Ok(())
}

/// 把任务（含整棵子任务树）移动到另一个清单（跨清单拖拽）。
/// - 校验：任务存在、目标清单存在且非目录、kind 与任务一致、目标 ≠ 当前清单（no-op）
/// - 子树用 WITH RECURSIVE 一次收集，全部迁移到目标清单并回退目标清单默认分组，
///   避免子任务留在旧清单形成孤儿（task_update 单条移动做不到这一点）
/// - 被拖任务 sort_order 置为目标清单根任务末尾（max + 1000），子任务保持相对顺序
/// - 整体用事务包裹：任一步失败全部回滚
#[tauri::command]
pub async fn task_move_to_list(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    target_list_id: String,
) -> CmdResult<()> {
    // 查任务当前清单与 kind
    let task_row: Option<(String, String)> =
        sqlx::query_as("SELECT list_id, kind FROM tasks WHERE id = $1")
            .bind(&task_id)
            .fetch_optional(pool.inner())
            .await
            .map_err(|e| format!("查询任务失败: {}", e))?;
    let (src_list_id, task_kind) = task_row.ok_or_else(|| format!("任务不存在: {}", task_id))?;

    // 目标清单必须存在、是清单（非目录）、kind 与任务一致（防跨 kind 拖拽）
    let list_row: Option<(String, i64)> =
        sqlx::query_as("SELECT kind, is_folder FROM lists WHERE id = $1")
            .bind(&target_list_id)
            .fetch_optional(pool.inner())
            .await
            .map_err(|e| format!("查询目标清单失败: {}", e))?;
    let (list_kind, is_folder) =
        list_row.ok_or_else(|| format!("目标清单不存在: {}", target_list_id))?;
    if is_folder == 1 {
        return Err("目标不能是目录，请拖到清单上".to_string());
    }
    if task_kind != list_kind {
        return Err(format!(
            "任务类型({})与清单类型({})不匹配，不能移动",
            task_kind, list_kind
        ));
    }
    // 目标与当前相同 → no-op（拖回原清单）
    if src_list_id == target_list_id {
        return Ok(());
    }

    // 事务：子树迁移 + 根任务追加到目标清单末尾
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;

    // 整棵子树（任务自身 + 所有后代）迁移到目标清单，
    // group_id 全部回退目标清单默认分组，避免跨清单分组孤儿。
    let default_group = format!("{}-default", target_list_id);
    let ts = now();
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM tasks WHERE id = $1
             UNION ALL
             SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
         )
         UPDATE tasks
         SET list_id = $2, group_id = $3, updated_at = $4
         WHERE id IN (SELECT id FROM subtree)",
    )
    .bind(&task_id)
    .bind(&target_list_id)
    .bind(&default_group)
    .bind(&ts)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("迁移任务失败: {}", e))?;

    // 被拖任务排到目标清单根任务末尾（子任务保持相对顺序，无需调整）
    let max_sort: Option<(i64,)> = sqlx::query_as(
        "SELECT MAX(sort_order) FROM tasks WHERE list_id = $1 AND parent_id IS NULL",
    )
    .bind(&target_list_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| format!("查询目标清单排序失败: {}", e))?;
    let new_sort = max_sort.map(|(m,)| m + 1000).unwrap_or(1000);
    sqlx::query("UPDATE tasks SET sort_order = $1, updated_at = $2 WHERE id = $3")
        .bind(new_sort)
        .bind(&ts)
        .bind(&task_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("调整任务排序失败: {}", e))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

// ─── 标签操作 ────────────────────────────────────────────

#[tauri::command]
pub async fn tag_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<Tag>> {
    let rows = sqlx::query(
        "SELECT id, name, created_at, position, color FROM tags ORDER BY position ASC, created_at ASC",
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
            color: r.get("color"),
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
pub async fn tag_create(
    pool: State<'_, sqlx::SqlitePool>,
    name: String,
    color: String,
) -> CmdResult<Tag> {
    let id = uuid();
    let ts = now();

    // 新标签追加到末尾：position = 当前最大 position + 1000（与前端 reorderTags 步长一致）。
    // 不能用默认值 0 —— 拖拽排序过的标签 position 均为正整数，0 会让新标签排到列表最前。
    let max_position: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position), 0) FROM tags")
        .fetch_one(pool.inner())
        .await
        .map_err(|e| format!("查询标签位置失败: {}", e))?;
    let position = max_position + 1000;

    sqlx::query(
        "INSERT INTO tags (id, name, created_at, position, color) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&ts)
    .bind(position)
    .bind(&color)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建标签失败: {}", e))?;

    Ok(Tag {
        id,
        name,
        created_at: ts,
        position,
        color,
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
           AND deleted_at IS NULL
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
    // 级联清理关联表，再删标签本体。
    // SQLite 默认不开启外键约束（init_pool 未设 PRAGMA foreign_keys=ON），
    // schema 的 ON DELETE CASCADE 不生效，必须手动删除孤儿关联，否则
    // task_tags / tag_sort_prefs 会残留指向已删除标签的死引用。
    // 顺序：先删关联（task_tags / tag_sort_prefs）再删 tags，幂等安全。
    sqlx::query("DELETE FROM task_tags WHERE tag_id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("清理任务标签关联失败: {}", e))?;
    sqlx::query("DELETE FROM tag_sort_prefs WHERE tag_id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("清理标签排序偏好失败: {}", e))?;
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
    color: Option<String>,
) -> CmdResult<()> {
    // color 为 Some 时同时更新 name + color；为 None 时只改 name（向后兼容）
    if let Some(c) = &color {
        sqlx::query("UPDATE tags SET name = $1, color = $2 WHERE id = $3")
            .bind(&name)
            .bind(c)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新标签失败: {}", e))?;
    } else {
        sqlx::query("UPDATE tags SET name = $1 WHERE id = $2")
            .bind(&name)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("重命名标签失败: {}", e))?;
    }
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
        "SELECT * FROM tasks WHERE parent_id IS NULL AND deleted_at IS NULL AND (title LIKE $1 OR note LIKE $1) ORDER BY done ASC, updated_at DESC LIMIT 20",
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
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?;
    get_attachment_path_sync(&app_data_dir)
}

/// 获取附件目录的同步核心（纯函数：仅读传入的 app_data_dir，不访问 Tauri 全局状态）。
///
/// 解析规则：优先读 app_data_dir/attachment_path.txt 中用户自定义路径，
/// 不存在或失效则回退到默认的 app_data_dir/attachments（并自动创建）。
/// 抽出此同步核心，让 #[tauri::command] 的 async 版本与菜单事件可共享同一份逻辑。
pub(crate) fn get_attachment_path_sync(app_data_dir: &std::path::Path) -> CmdResult<String> {
    let config_path = app_data_dir.join("attachment_path.txt");

    if config_path.exists() {
        let path_str =
            std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置失败: {}", e))?;
        if std::path::Path::new(&path_str).exists() {
            return Ok(path_str);
        }
    }

    // 返回默认路径
    let default = app_data_dir.join("attachments");
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

/// 合法的附件磁盘分类目录名（白名单，杜绝路径穿越）
/// 与前端 ATTACHMENT_TYPE_DIRS 保持一致
const ATTACHMENT_CATEGORY_DIRS: [&str; 6] =
    ["images", "videos", "audios", "docs", "archives", "others"];

/// 保存任意类型附件到附件目录，返回相对路径（YYYYMMDD/<category>/<uuid>.<ext>）
///
/// 存储结构：按"日期/类型"分层，便于在 Finder 中按天查看、按类型筛选。
/// - 日期：Rust 端取当前本地日期（与前端 createdAt 同一刻，忽略秒级偏差）
/// - 类型：前端传 category（从文件名推导），Rust 白名单校验后用作子目录名
/// - 安全：category 走白名单，避免前端拼子路径导致的路径穿越（Path::join 不拦截 ..）
///
/// 返回的相对路径会存入 tasks.attachments 的 stored_name 字段；
/// 其他命令（get_fullpath/delete/read/reveal）用 Path::join(stored_name) 自动适配多级路径。
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    data: String,
    ext: String,
    category: String,
) -> CmdResult<String> {
    // 白名单校验 category，杜绝路径穿越
    if !ATTACHMENT_CATEGORY_DIRS.contains(&category.as_str()) {
        return Err(format!(
            "非法的附件分类: {}（合法值: {}）",
            category,
            ATTACHMENT_CATEGORY_DIRS.join(", ")
        ));
    }

    let dir = get_attachment_path(app.clone()).await?;
    let id = uuid();
    // ext 已由前端小写化处理；为空时用 bin 兜底，避免拼出 "uuid." 这样的文件名
    let safe_ext = if ext.is_empty() {
        "bin".to_string()
    } else {
        ext
    };

    // 拼相对子路径：YYYYMMDD/<category>/<uuid>.<ext>
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    let rel_path = format!("{}/{}/{}.{}", today, category, id, safe_ext);
    let filepath = PathBuf::from(&dir).join(&rel_path);

    // 确保子目录存在（create_dir_all 幂等，已有不报错）
    if let Some(parent) = filepath.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建附件目录失败: {}", e))?;
    }

    use std::io::Write;
    let bytes = base64_decode(&data)?;
    let mut file = std::fs::File::create(&filepath).map_err(|e| format!("创建文件失败: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(rel_path)
}

/// 删除附件目录中的物理文件（删除任务附件时调用，避免孤儿文件）
/// 文件不存在视为成功（幂等）
#[tauri::command]
pub async fn delete_attachment(app: AppHandle, stored_name: String) -> CmdResult<()> {
    let dir = get_attachment_path(app).await?;
    let filepath = PathBuf::from(&dir).join(&stored_name);
    if filepath.exists() {
        std::fs::remove_file(&filepath).map_err(|e| format!("删除附件文件失败: {}", e))?;
    }
    Ok(())
}

/// 读取文本类附件内容（用于 md/txt 应用内预览）
/// 2MB 上限保护：超过则让前端改走系统默认程序打开
#[tauri::command]
pub async fn read_attachment_text(app: AppHandle, stored_name: String) -> CmdResult<String> {
    let dir = get_attachment_path(app).await?;
    let filepath = PathBuf::from(&dir).join(&stored_name);
    let meta = std::fs::metadata(&filepath).map_err(|e| format!("读取附件信息失败: {}", e))?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，请使用系统默认程序打开".to_string());
    }
    std::fs::read_to_string(&filepath).map_err(|e| format!("读取附件内容失败: {}", e))
}

/// 在系统文件管理器中定位（高亮选中）附件文件
/// macOS: Finder；Windows: 资源管理器；Linux: 打开所在目录
#[tauri::command]
pub async fn reveal_attachment(app: AppHandle, stored_name: String) -> CmdResult<()> {
    let dir = get_attachment_path(app).await?;
    let filepath = PathBuf::from(&dir).join(&stored_name);
    if !filepath.exists() {
        return Err("附件文件不存在".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        // /select, 后面跟逗号是 explorer 的参数分隔符
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", filepath.display()))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Linux 无统一高亮选中机制，退化为打开所在目录
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }

    Ok(())
}

/// 把任意文本写入系统剪贴板（跨平台 shell-out，无需引入剪贴板 crate）
/// macOS: pbcopy；Windows: clip；Linux: xclip（失败回退 wl-copy）
fn write_to_clipboard(text: &str) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    let (cmd, args): (&str, Vec<&str>) = ("pbcopy", vec![]);
    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<&str>) = ("clip", vec![]);
    #[cfg(target_os = "linux")]
    let (cmd, args): (&str, Vec<&str>) = ("xclip", vec!["-selection", "clipboard"]);

    let mut child = std::process::Command::new(cmd)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .or_else(|_| {
            // Linux 下 xclip 可能未装，回退 wl-copy（Wayland）；其他平台直接报错
            #[cfg(target_os = "linux")]
            {
                std::process::Command::new("wl-copy")
                    .stdin(std::process::Stdio::piped())
                    .spawn()
            }
            #[cfg(not(target_os = "linux"))]
            {
                Err(std::io::Error::last_os_error())
            }
        })
        .map_err(|e| format!("启动剪贴板工具失败（{cmd}）: {e}"))?;

    use std::io::Write;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("写入剪贴板失败: {e}"))?;
    }
    child
        .wait()
        .map_err(|e| format!("剪贴板工具等待失败（{cmd}）: {e}"))?;
    Ok(())
}

/// 把附件完整路径写入系统剪贴板
#[tauri::command]
pub async fn copy_attachment_path(app: AppHandle, stored_name: String) -> CmdResult<()> {
    let dir = get_attachment_path(app).await?;
    let filepath = PathBuf::from(&dir).join(&stored_name);
    let path_str = filepath.to_string_lossy().to_string();
    write_to_clipboard(&path_str)
}

/// 把任意文本写入系统剪贴板（供富文本「复制代码块」等前端场景调用）
#[tauri::command]
pub async fn copy_text(text: String) -> CmdResult<()> {
    write_to_clipboard(&text)
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
        "SELECT t.id, t.name, t.created_at, t.position, t.color FROM tags t
         JOIN task_tags tt ON t.id = tt.tag_id
         WHERE tt.task_id = $1 ORDER BY tt.sort_order ASC, t.created_at ASC",
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
            color: r.get("color"),
        })
        .collect())
}

/// 批量查询多个任务的标签关联。
/// 一条 SQL 查询全部，返回扁平的 TaskTagLink 数组（每条 = 一个任务的一个标签），
/// 前端按 task_id 分组成映射。空入参直接返回空数组，避免生成非法的 `IN ()`。
#[tauri::command]
pub async fn task_get_tags_batch(
    pool: State<'_, sqlx::SqlitePool>,
    task_ids: Vec<String>,
) -> CmdResult<Vec<crate::models::TaskTagLink>> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    // 动态构造占位符：$1, $2, ...（sqlx 用 $N 而非 ?）
    let placeholders: Vec<String> = (1..=task_ids.len()).map(|i| format!("${i}")).collect();
    let sql = format!(
        "SELECT tt.task_id, t.id, t.name, t.created_at, t.position, t.color
         FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
         WHERE tt.task_id IN ({})
         ORDER BY tt.sort_order ASC, t.created_at ASC",
        placeholders.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for id in &task_ids {
        query = query.bind(id);
    }
    let rows = query
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("批量查询任务标签失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|r| crate::models::TaskTagLink {
            task_id: r.get("task_id"),
            tag_id: r.get("id"),
            tag_name: r.get("name"),
            tag_created_at: r.get("created_at"),
            tag_position: r.get("position"),
            tag_color: r.get("color"),
        })
        .collect())
}

#[tauri::command]
pub async fn task_add_tag(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    tag_id: String,
) -> CmdResult<()> {
    // sort_order 追加到末尾：取该任务已有标签的最大 sort_order + 1（无标签时为 0）。
    // INSERT OR IGNORE 保证幂等（已关联的标签不会被重复插入，sort_order 保持原值）。
    sqlx::query(
        "INSERT OR IGNORE INTO task_tags (task_id, tag_id, sort_order)
         SELECT $1, $2, COALESCE((SELECT MAX(sort_order) FROM task_tags WHERE task_id = $1), -1) + 1",
    )
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

/// 重排某任务内的标签顺序（每个任务独立的局部顺序，不影响全局 tags.position）。
/// 入参为该任务内标签的有序 id 数组，按 i*1000 全量重写 task_tags.sort_order
/// （对齐 group_reorder 模式）。仅更新 task_id 匹配的行。
#[tauri::command]
pub async fn task_reorder_tags(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
    ordered_tag_ids: Vec<String>,
) -> CmdResult<()> {
    for (i, tag_id) in ordered_tag_ids.iter().enumerate() {
        sqlx::query("UPDATE task_tags SET sort_order = $1 WHERE task_id = $2 AND tag_id = $3")
            .bind((i * 1000) as i64)
            .bind(&task_id)
            .bind(tag_id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("重排任务标签失败: {}", e))?;
    }
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
///
/// `only_id`：传 Some(id) 时只处理该模板（用于「后台任务」面板单条手动运行），
/// 此时跳过 done/paused 过滤（手动触发就是要跑）；None 时为全量后台扫描。
pub async fn task_generate_recurring_inner(
    pool: &sqlx::SqlitePool,
    only_id: Option<&str>,
) -> Result<usize, String> {
    let now = chrono::Local::now().naive_local();
    let tomorrow_start = (now.date() + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap();
    let today_end_str = format_local_naive(tomorrow_start);

    // 查询模板任务。全量后台扫描过滤 done=0 + paused=0 + 未删除（回收站模板不再生成）；
    // 单条手动运行（only_id）跳过前两个过滤——用户明确要触发这一次，
    // 但已删除过滤仍然保留（回收站中的模板不允许手动运行）。
    let templates = if let Some(id) = only_id {
        sqlx::query(
            "SELECT * FROM tasks WHERE id = $1 AND recurrence_freq IS NOT NULL AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询重复模板失败: {}", e))?
    } else {
        sqlx::query(
            "SELECT * FROM tasks WHERE recurrence_freq IS NOT NULL AND done = 0 AND recurrence_paused = 0 AND deleted_at IS NULL",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询重复模板失败: {}", e))?
    };

    let mut generated = 0usize;

    for template_row in &templates {
        let template: Task = row_to_task(template_row);
        let freq = match &template.recurrence_freq {
            Some(f) => f.as_str(),
            None => continue,
        };
        let interval = template.recurrence_interval.max(1);

        // 基准日期：从生成历史表查该模板最新已生成的日期（实例被删除仍保留记录），
        // 没有历史则用模板自己的 due_end_at。
        let last_generated = sqlx::query(
            "SELECT due_date FROM recurrence_generated WHERE template_id = $1 ORDER BY due_date DESC LIMIT 1",
        )
        .bind(&template.id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询生成历史失败: {}", e))?;

        let current_iso_opt = match (last_generated, &template.due_end_at) {
            (Some(row), _) => row.try_get::<String, _>("due_date").ok(),
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

        // 去重：查生成历史表（recurrence_generated），而非查现存实例。
        // 关键：实例被用户删除后历史记录保留，去重仍生效，不会重新生成。
        let exists = sqlx::query(
            "SELECT template_id FROM recurrence_generated WHERE template_id = $1 AND due_date = $2 LIMIT 1",
        )
        .bind(&template.id)
        .bind(&next_iso)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("检查生成历史失败: {}", e))?;

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

            // 同步记录到生成历史表（去重依据；实例删除后记录保留，防止重生）
            sqlx::query(
                "INSERT OR IGNORE INTO recurrence_generated (template_id, due_date, instance_id, generated_at)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(&template.id)
            .bind(&next_iso)
            .bind(&new_id)
            .bind(&ts)
            .execute(pool)
            .await
            .map_err(|e| format!("记录生成历史失败: {}", e))?;

            generated += 1;
        }
        // 注意：不在此手动推进 current_iso。下次扫描时 last_generated 查询会自动取刚生成的
        // 这一期作为新基准，从而实现「每次扫描补一期」的逐步追上行为。
    }

    Ok(generated)
}

#[tauri::command]
pub async fn task_generate_recurring(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<usize> {
    task_generate_recurring_inner(pool.inner(), None).await
}

/// 手动运行单个重复模板的生成（「后台任务」面板单条触发）。
/// 跳过 done/paused 过滤——用户明确要补这一期。返回是否生成了新实例。
#[tauri::command]
pub async fn recurrence_run_one(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<usize> {
    task_generate_recurring_inner(pool.inner(), Some(&id)).await
}

// ─── 重复任务管理（后台任务面板用） ───────────────────────────

/// 列出所有重复任务模板（含已暂停、已完成），供「后台任务」面板展示。
/// 模板识别：recurrence_freq IS NOT NULL（实例的 freq 字段为 NULL）。
/// 已移入回收站的模板不展示（deleted_at IS NULL 过滤）。
#[tauri::command]
pub async fn recurrence_list_templates(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<Task>> {
    let rows = sqlx::query(
        "SELECT * FROM tasks WHERE recurrence_freq IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询重复模板失败: {}", e))?;
    Ok(rows.iter().map(row_to_task).collect())
}

/// 暂停/恢复某个重复模板的生成。
/// - paused=true：后台 tick 跳过该模板，不再生成新实例（已生成的实例保留）
/// - paused=false：恢复正常生成
#[tauri::command]
pub async fn recurrence_pause(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    paused: bool,
) -> CmdResult<()> {
    let now = format_local_naive(chrono::Local::now().naive_local());
    sqlx::query("UPDATE tasks SET recurrence_paused = $2, updated_at = $3 WHERE id = $1")
        .bind(&id)
        .bind(if paused { 1 } else { 0 })
        .bind(&now)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("更新暂停状态失败: {}", e))?;
    Ok(())
}

/// 重复任务生成历史记录（用于查看某模板「已生成过哪些期」）。
/// 返回最近 20 条，按生成日期倒序。
#[tauri::command]
pub async fn recurrence_history(
    pool: State<'_, sqlx::SqlitePool>,
    template_id: String,
) -> CmdResult<Vec<RecurrenceHistoryEntry>> {
    let rows = sqlx::query(
        "SELECT template_id, due_date, instance_id, generated_at \
         FROM recurrence_generated WHERE template_id = $1 \
         ORDER BY due_date DESC LIMIT 20",
    )
    .bind(&template_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询生成历史失败: {}", e))?;
    Ok(rows
        .iter()
        .map(|r| RecurrenceHistoryEntry {
            template_id: r.try_get("template_id").unwrap_or_default(),
            due_date: r.try_get("due_date").unwrap_or_default(),
            instance_id: r.try_get("instance_id").ok().flatten(),
            generated_at: r.try_get("generated_at").unwrap_or_default(),
        })
        .collect())
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

/// 扫库找"该通知但还没通知过"的任务。两种提醒源（互斥，不会同时命中同一任务）：
/// - 相对提醒：remind_offset_minutes + due_end_at
///     标准扫描 trigger_at = due_end_at - offset；trigger_at <= now
///     启动补发 due_end_at 在过去 24h 内 且 notified_at IS NULL
/// - 指定时刻提醒：remind_at（绝对本地时刻）
///     remind_at 落在 [now-24h, now] 区间即触发（到点且不超过 24h 补发窗口）
pub async fn task_check_reminders_inner(
    pool: &sqlx::SqlitePool,
    on_emit: impl Fn(&PendingReminder),
) -> Result<usize, String> {
    let now = chrono::Local::now().naive_local();
    let now_str = format_local_naive(now);
    let cutoff_str = format_local_naive(now - chrono::Duration::hours(24));

    // 一次性把"待通知"任务拉出来。公共过滤：done=0 且 notified_at IS NULL。
    // 两个提醒源用 OR 连接（二者字段互斥，同一任务只会命中一支）：
    //   A 相对提醒：remind_offset_minutes 与 due_end_at 都非空，
    //     要么 (due_end_at - offset) <= now（准点/提前已到），
    //     要么 due_end_at 在 [cutoff, now] 内（应用启动补发窗口）。
    //   B 指定时刻：remind_at 非空且落在 [cutoff, now] 内（到点 + 24h 补发上限）。
    // SQLite 的 datetime() 无 'localtime' 时按 UTC 解释。我们的本地字面量（如
    // "2026-07-14T17:25:00"）实际表达的是墙上时刻，必须显式声明 'localtime'。
    let rows = sqlx::query(
        "SELECT id, title, due_end_at, remind_offset_minutes, remind_at FROM tasks
         WHERE done = 0
           AND deleted_at IS NULL
           AND notified_at IS NULL
           AND (
             (remind_offset_minutes IS NOT NULL AND due_end_at IS NOT NULL
              AND (datetime(replace(due_end_at, 'T', ' '), '-' || remind_offset_minutes || ' minutes', 'localtime') <= datetime($1, 'localtime')
                   OR (datetime(replace(due_end_at, 'T', ' '), 'localtime') >= datetime($2, 'localtime')
                       AND datetime(replace(due_end_at, 'T', ' '), 'localtime') <= datetime($1, 'localtime'))))
             OR
             (remind_at IS NOT NULL
              AND datetime(replace(remind_at, 'T', ' '), 'localtime') <= datetime($1, 'localtime')
              AND datetime(replace(remind_at, 'T', ' '), 'localtime') >= datetime($2, 'localtime'))
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
        // 两源互斥：相对提醒分支 due_end_at/offset 有值、remind_at 为 NULL；
        //           指定时刻分支 remind_at 有值、另两者为 NULL。均用 Option 安全取值。
        let due_end_at: Option<String> = row.get("due_end_at");
        let offset: Option<i32> = row.get("remind_offset_minutes");
        let remind_at: Option<String> = row.get("remind_at");

        // 生成通知文案：优先指定时刻，其次相对提醒，兜底"到点了"
        let body = if let Some(ra) = &remind_at {
            build_reminder_body_at(ra)
        } else if let (Some(de), Some(off)) = (&due_end_at, offset) {
            build_reminder_body(de, off)
        } else {
            "到点了".to_string()
        };
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

/// 后台任务面板：列出所有设置了提醒的未完成任务（含计算后的触发时刻）。
/// 触发时刻 trigger_at 的计算规则与 task_check_reminders_inner 一致：
///   - 指定时刻 remind_at 非空 → 直接取 remind_at
///   - 相对偏移 remind_offset_minutes + due_end_at 非空 → due_end_at - offset 分钟
///   - 都算不出（如 offset 设了但无截止时间）→ 该任务永远不会触发提醒，直接排除
/// 结果按触发时刻升序（最近的在前）；notified_at 非空表示已通知过（前端灰化展示）。
#[tauri::command]
pub async fn reminder_upcoming_list(
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<Vec<UpcomingReminder>> {
    let rows = sqlx::query(
        "SELECT t.id, t.title, t.list_id, t.remind_at, t.remind_offset_minutes,
                t.due_end_at, t.notified_at, l.name AS list_name, l.color AS list_color
         FROM tasks t
         LEFT JOIN lists l ON t.list_id = l.id
         WHERE t.done = 0
           AND t.deleted_at IS NULL
           AND (t.remind_at IS NOT NULL OR t.remind_offset_minutes IS NOT NULL)",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询定时提醒列表失败: {}", e))?;

    let mut items: Vec<UpcomingReminder> = Vec::new();
    for row in &rows {
        let remind_at: Option<String> = row.get("remind_at");
        let offset: Option<i32> = row.get("remind_offset_minutes");
        let due_end_at: Option<String> = row.get("due_end_at");
        // 计算触发时刻（与 task_check_reminders_inner 同规则）
        let trigger_at: Option<String> = if let Some(ra) = &remind_at {
            Some(ra.clone())
        } else if let (Some(de), Some(off)) = (&due_end_at, offset) {
            parse_local_naive(de)
                .map(|dt| format_local_naive(dt - chrono::Duration::minutes(off as i64)))
        } else {
            None
        };
        // 算不出触发时刻 → 永远不会触发提醒，排除
        let trigger_at = match trigger_at {
            Some(v) => v,
            None => continue,
        };
        items.push(UpcomingReminder {
            task_id: row.get("id"),
            title: row.get("title"),
            list_id: row.get("list_id"),
            list_name: row.get("list_name"),
            list_color: row.get("list_color"),
            remind_at,
            offset_minutes: offset,
            due_end_at,
            trigger_at: Some(trigger_at),
            notified_at: row.get("notified_at"),
        });
    }
    // 按触发时刻升序（本地字面量字典序 = 时间序）
    items.sort_by(|a, b| a.trigger_at.cmp(&b.trigger_at));
    Ok(items)
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

/// 根据「指定时刻」生成中文通知正文。
/// 与相对提醒（"还剩 N 分钟"）不同，指定时刻是绝对时间，文案直接体现该时刻。
fn build_reminder_body_at(remind_at: &str) -> String {
    match parse_local_naive(remind_at) {
        Some(d) => {
            let time_str = d.format("%H:%M").to_string();
            let date_str = format!("{}月{}日", d.format("%m"), d.format("%d"));
            format!("提醒时间到了（{} {}）", date_str, time_str)
        }
        None => "提醒时间到了".to_string(),
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

// ─── 每日固定时点提醒（汇总通知） ────────────────────────
//
// 与 task_check_reminders_inner 解耦：
// - 任务级提醒：每个有 remind_offset_minutes 的任务在 due 时刻前后发单条；
//   去重靠 tasks.notified_at。
// - 每日汇总：用户在设置里配置的若干 HH:mm 到点，发一条汇总未完成任务数的通知；
//   去重靠 daily_reminder_log (log_date, log_time) 主键。
//
// 应用场景：用户配置 09:00 / 17:00 两个时刻，每天 09:00、17:00 各发一条：
//   「任务速览
//    7月23日 周四
//    69 过期任务
//    立即查看今天的任务」
//
// 启动补发：lib.rs 后台 task 第一轮会扫描过去 24h 内所有到点时刻，确保关闭期间
// 漏发的时刻也能补上（同一天同一时刻只补一次，由 log 表约束保证）。

/// 每日汇总通知内容（与 PendingReminder 解耦，独立结构）
#[derive(Debug, Clone)]
pub struct DailySummary {
    pub title: String,
    pub body: String,
}

/// 解析 CSV 时刻字符串（"09:00,17:00"）为合法 HH:mm 列表
/// - 去重、去空
/// - 仅接受 `^[0-2]\d:[0-5]\d$` 格式（24h 制，HH:mm）
/// - 字典序排序（HH:mm 字典序 == 时间序）
/// - 最多 8 个（与前端 store 的上限保持一致）
pub fn parse_daily_times(raw: Option<String>) -> Vec<String> {
    const MAX_TIMES: usize = 8;
    let Some(s) = raw else { return Vec::new() };
    let mut seen: Vec<String> = Vec::new();
    for tok in s.split(',') {
        let t = tok.trim();
        if t.is_empty() {
            continue;
        }
        // 严格校验：2 位小时（00-23）+ 冒号 + 2 位分钟（00-59）
        let valid = {
            let bytes = t.as_bytes();
            bytes.len() == 5
                && bytes[2] == b':'
                && bytes[0].is_ascii_digit()
                && bytes[1].is_ascii_digit()
                && bytes[3].is_ascii_digit()
                && bytes[4].is_ascii_digit()
                && t[0..2].parse::<u32>().is_ok_and(|h| h < 24)
                && t[3..5].parse::<u32>().is_ok_and(|m| m < 60)
        };
        if !valid {
            continue;
        }
        if !seen.iter().any(|x| x == t) {
            seen.push(t.to_string());
        }
        if seen.len() >= MAX_TIMES {
            break;
        }
    }
    seen.sort();
    seen
}

/// 扫描过去 24h 内"应该发但还没发"的时刻，对每个时刻：
///   1) 计算过期 / 今天 / 未来 7 天的未完成根任务计数
///   2) 调 on_emit(&DailySummary) 让调用方发通知
///   3) 写入 daily_reminder_log 防重复
///
/// 触发条件：`times` 中的某个 `HH:mm` 满足：
///   - hh:mm <= now（防止 11:00 时补 14:00 的）
///   - hh:mm >= now - 24h（防止过老的补发）
///   - daily_reminder_log 里 (today, hh:mm) 不存在
///
/// 返回实际发送的通知条数（用于日志 / UI 反馈）。
pub async fn task_daily_reminder_scan_inner(
    pool: &sqlx::SqlitePool,
    times: &[String],
    now: chrono::NaiveDateTime,
    on_emit: impl Fn(&DailySummary),
) -> Result<usize, String> {
    if times.is_empty() {
        return Ok(0);
    }

    // 本地今日 YYYY-MM-DD（与 chrono::Local 一致）
    let today_str = now.format("%Y-%m-%d").to_string();

    // 本地今日 00:00 / 明日 00:00 / 未来 7 天结束边界（用于三类计数）
    let today_start: chrono::NaiveDateTime = now
        .date()
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "now.date() 转 NaiveDateTime 失败".to_string())?;
    let tomorrow_start = today_start + chrono::Duration::days(1);
    let week_later_start = today_start + chrono::Duration::days(7);

    // 触发窗口：每个配置时刻的"今日目标时间"在
    //   [today_target, today_target + 24h) 区间内
    // 含义：今天 hh:mm 对应的本地时间字面量，加上 24 小时窗口。这意味着循环里
    // today_target 之后**任意一次扫描**都算"在窗口里"（不再依赖 now_hhmm 严格匹配）。
    // daily_reminder_log (log_date, log_time) 主键防同一天重复发。
    // 启动补发同理：spawn 第一轮 + 启动期间窗口足够长，足以补过去 24h 内的所有时刻。
    let day_window = chrono::Duration::hours(24);

    let mut sent = 0usize;

    for hhmm in times {
        // 1. 时点合法性（parse_daily_times 已保证 hh:mm 格式）→ 拆出 h / m
        if hhmm.len() != 5 {
            continue;
        }
        let h: u32 = match hhmm[0..2].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let m: u32 = match hhmm[3..5].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if h >= 24 || m >= 60 {
            continue;
        }
        // 今日 hh:mm 对应的本地 NaiveDateTime（与 today_start 同日期，仅替换时分）
        let today_target = match today_start.date().and_hms_opt(h, m, 0) {
            Some(dt) => dt,
            None => continue,
        };

        // 2. 触发窗口判定：now 落在 [today_target, today_target + 24h)
        if now < today_target || now >= today_target + day_window {
            continue;
        }

        // 3. 是否已发过？（daily_reminder_log 主键 (log_date, log_time)）
        let already = sqlx::query(
            "SELECT 1 FROM daily_reminder_log WHERE log_date = $1 AND log_time = $2 LIMIT 1",
        )
        .bind(&today_str)
        .bind(hhmm)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询 daily_reminder_log 失败: {}", e))?;
        if already.is_some() {
            continue;
        }

        // 4. 统计三类未完成根任务数（done=0 AND parent_id IS NULL AND due_end_at 非空）
        //    过期：due_end_at < today 00:00
        //    今天：today 00:00 <= due_end_at < 明天 00:00
        //    未来 7 天：明天 00:00 <= due_end_at < 8 天后 00:00
        //    deleted_at IS NULL 排除回收站任务（与侧边栏计数 / 智能视图口径一致）
        let count_overdue: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks
             WHERE parent_id IS NULL AND done = 0
               AND deleted_at IS NULL
               AND due_end_at IS NOT NULL
               AND datetime(replace(due_end_at, 'T', ' '), 'localtime')
                   < datetime($1, 'localtime')",
        )
        .bind(format_local_naive(today_start))
        .fetch_one(pool)
        .await
        .map_err(|e| format!("统计过期任务失败: {}", e))?;

        let count_today: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks
             WHERE parent_id IS NULL AND done = 0
               AND deleted_at IS NULL
               AND due_end_at IS NOT NULL
               AND datetime(replace(due_end_at, 'T', ' '), 'localtime')
                   >= datetime($1, 'localtime')
               AND datetime(replace(due_end_at, 'T', ' '), 'localtime')
                   < datetime($2, 'localtime')",
        )
        .bind(format_local_naive(today_start))
        .bind(format_local_naive(tomorrow_start))
        .fetch_one(pool)
        .await
        .map_err(|e| format!("统计今日任务失败: {}", e))?;

        let count_week: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tasks
             WHERE parent_id IS NULL AND done = 0
               AND deleted_at IS NULL
               AND due_end_at IS NOT NULL
               AND datetime(replace(due_end_at, 'T', ' '), 'localtime')
                   >= datetime($1, 'localtime')
               AND datetime(replace(due_end_at, 'T', ' '), 'localtime')
                   < datetime($2, 'localtime')",
        )
        .bind(format_local_naive(tomorrow_start))
        .bind(format_local_naive(week_later_start))
        .fetch_one(pool)
        .await
        .map_err(|e| format!("统计未来 7 天任务失败: {}", e))?;

        // 5. 组装通知文案（中文）
        //    标题始终为「任务速览」
        //    正文：日期 + 三段计数（0 段省略）+ 行动号召
        //    全部为 0 时退化为「暂无未完成任务」
        let weekday_cn = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
            [now.weekday().num_days_from_monday() as usize];
        let date_label = format!("{}月{}日 {}", now.month(), now.day(), weekday_cn,);

        let mut lines: Vec<String> = Vec::new();
        if count_overdue > 0 {
            lines.push(format!("{} 过期任务", count_overdue));
        }
        if count_today > 0 {
            lines.push(format!("{} 今天的任务", count_today));
        }
        if count_week > 0 {
            lines.push(format!("{} 未来 7 天", count_week));
        }

        let body = if lines.is_empty() {
            format!("{}\n暂无未完成任务", date_label)
        } else {
            format!("{}\n{}\n立即查看今天的任务", date_label, lines.join("\n"))
        };

        let summary = DailySummary {
            title: "任务速览".to_string(),
            body,
        };
        on_emit(&summary);

        // 6. 写入 log 防重复（即使 on_emit 失败也写，避免反复尝试）
        let sent_at = format_local_naive(now);
        sqlx::query(
            "INSERT OR IGNORE INTO daily_reminder_log (log_date, log_time, sent_at)
             VALUES ($1, $2, $3)",
        )
        .bind(&today_str)
        .bind(hhmm)
        .bind(&sent_at)
        .execute(pool)
        .await
        .map_err(|e| format!("写入 daily_reminder_log 失败: {}", e))?;

        sent += 1;
    }

    Ok(sent)
}

#[tauri::command]
pub async fn task_daily_reminder_scan(
    app: tauri::AppHandle,
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<usize> {
    use tauri_plugin_notification::NotificationExt;
    let raw = get_setting_inner(pool.inner(), "daily_reminder_times".to_string()).await?;
    let times = parse_daily_times(raw);
    let now = chrono::Local::now().naive_local();
    let count = task_daily_reminder_scan_inner(pool.inner(), &times, now, |summary| {
        let res = app
            .notification()
            .builder()
            .title(&summary.title)
            .body(&summary.body)
            .show();
        if let Err(e) = res {
            eprintln!("[JustToDo] 每日提醒通知失败：{}", e);
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

// ─── 模板操作 ────────────────────────────────────────────
// 模板是"任务参数预设"，独立于 tasks 表。
// 应用模板由前端编排：taskStore.createTask + db.updateTask(note)。

/// 从行数据提取 Template（is_builtin 是 0/1 整数；kind 用 try_get 容错旧库）
fn row_to_template(row: &sqlx::sqlite::SqliteRow) -> Template {
    Template {
        id: row.get("id"),
        name: row.get("name"),
        title: row.get("title"),
        note: row.get("note"),
        is_builtin: row.get::<i32, _>("is_builtin") != 0,
        position: row.get("position"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        kind: row.try_get("kind").unwrap_or_else(|_| "task".to_string()),
    }
}

#[tauri::command]
pub async fn template_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<Template>> {
    let rows = sqlx::query(
        "SELECT id, name, title, note, is_builtin, position, created_at, updated_at, kind FROM templates ORDER BY position ASC, created_at ASC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询模板失败: {}", e))?;

    Ok(rows.iter().map(row_to_template).collect())
}

#[tauri::command]
pub async fn template_create(
    pool: State<'_, sqlx::SqlitePool>,
    input: CreateTemplateInput,
) -> CmdResult<Template> {
    let id = uuid();
    let ts = now();
    // position 取当前最大值 + 1000，保证新模板排在最后
    let max_pos: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position), 0) FROM templates")
        .fetch_one(pool.inner())
        .await
        .map_err(|e| format!("查询模板 position 失败: {}", e))?;
    let position = max_pos + 1000;
    // kind 不传默认 'task'（任务模板）；'note' = 笔记模板
    let kind = input.kind.unwrap_or_else(|| "task".to_string());

    sqlx::query(
        "INSERT INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at, kind) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.title)
    .bind(&input.note)
    .bind(position)
    .bind(&ts)
    .bind(&ts)
    .bind(&kind)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建模板失败: {}", e))?;

    Ok(Template {
        id,
        name: input.name,
        title: input.title,
        note: input.note,
        is_builtin: false,
        position,
        created_at: ts.clone(),
        updated_at: ts,
        kind,
    })
}

#[tauri::command]
pub async fn template_update(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    input: UpdateTemplateInput,
) -> CmdResult<()> {
    let ts = now();

    // 逐字段更新（与 task_update 同模式；任一字段 Some 则更新该字段）
    if let Some(name) = &input.name {
        sqlx::query("UPDATE templates SET name = $1, updated_at = $2 WHERE id = $3")
            .bind(name)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新模板失败: {}", e))?;
    }
    if let Some(title) = &input.title {
        sqlx::query("UPDATE templates SET title = $1, updated_at = $2 WHERE id = $3")
            .bind(title)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新模板失败: {}", e))?;
    }
    if let Some(note) = &input.note {
        sqlx::query("UPDATE templates SET note = $1, updated_at = $2 WHERE id = $3")
            .bind(note)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新模板失败: {}", e))?;
    }
    if let Some(kind) = &input.kind {
        sqlx::query("UPDATE templates SET kind = $1, updated_at = $2 WHERE id = $3")
            .bind(kind)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新模板失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn template_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM templates WHERE id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除模板失败: {}", e))?;
    Ok(())
}

/// 批量重排模板顺序
///
/// 入参 items 是 [(id, position)] 的数组，前端在拖拽完成后一次性传入完整新顺序。
/// 用事务批量 UPDATE，保证原子性。与 list_reorder / habit_reorder 同模式。
#[tauri::command]
pub async fn template_reorder(
    pool: State<'_, sqlx::SqlitePool>,
    items: Vec<(String, i64)>,
) -> CmdResult<()> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let ts = now();
    for (id, position) in &items {
        sqlx::query("UPDATE templates SET position = $1, updated_at = $2 WHERE id = $3")
            .bind(position)
            .bind(&ts)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("更新模板顺序失败: {}", e))?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

/// 查询某时间范围内「已完成」的根任务（按 completed_at 过滤）。
///
/// 与 task_get_by_due_range 的区别：
/// - 那个按「截止日期 due_end_at」过滤，回答"哪天到期"
/// - 本命令按「完成时间 completed_at」过滤，回答"哪天完成" —— 每日小结的核心数据
/// - 不限 due_start_at（避免漏掉没设截止日期但已完成的任务）
///
/// 时间字符串格式：本地字面量 "YYYY-MM-DDTHH:mm:ss"（与 DB 存储一致）。
/// SQLite datetime() 对无时区字符串默认按 UTC 解释，必须显式 'localtime'。
#[tauri::command]
pub async fn task_get_completed_in_range(
    pool: State<'_, sqlx::SqlitePool>,
    start: String,
    end: String,
) -> CmdResult<Vec<Task>> {
    let rows = sqlx::query(
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
    .map_err(|e| format!("查询已完成任务失败: {}", e))?;
    Ok(rows.iter().map(row_to_task).collect())
}

// ─── 任务分组（Group）CRUD ───────────────────────────

/// 从行数据提取 Group
fn row_to_group(row: &sqlx::sqlite::SqliteRow) -> Group {
    Group {
        id: row.get("id"),
        list_id: row.get("list_id"),
        name: row.get("name"),
        sort_order: row.get("sort_order"),
        created_at: row.get("created_at"),
    }
}

/// 获取清单的所有分组（按 sort_order 排序）
#[tauri::command]
pub async fn group_list(
    pool: State<'_, sqlx::SqlitePool>,
    list_id: String,
) -> CmdResult<Vec<Group>> {
    let rows = sqlx::query("SELECT * FROM groups WHERE list_id = $1 ORDER BY sort_order ASC")
        .bind(&list_id)
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("查询分组失败: {}", e))?;
    Ok(rows.iter().map(row_to_group).collect())
}

/// 获取全部分组（看板「按分组」模式跨清单展示用，按 sort_order 排序）
#[tauri::command]
pub async fn group_list_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<Group>> {
    let rows = sqlx::query("SELECT * FROM groups ORDER BY sort_order ASC")
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("查询全部分组失败: {}", e))?;
    Ok(rows.iter().map(row_to_group).collect())
}

/// 创建分组
#[tauri::command]
pub async fn group_create(
    pool: State<'_, sqlx::SqlitePool>,
    input: CreateGroupInput,
) -> CmdResult<Group> {
    let id = uuid();
    let ts = now();
    // sort_order：传入则用传入值（支持插入到指定位置），否则追加到末尾（时间戳足够大）
    let sort_order = input
        .sort_order
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    sqlx::query(
        "INSERT INTO groups (id, list_id, name, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(&input.list_id)
    .bind(&input.name)
    .bind(sort_order)
    .bind(&ts)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建分组失败: {}", e))?;
    Ok(Group {
        id,
        list_id: input.list_id,
        name: input.name,
        sort_order,
        created_at: ts,
    })
}

/// 更新分组（重命名 / 改排序）
#[tauri::command]
pub async fn group_update(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    input: UpdateGroupInput,
) -> CmdResult<()> {
    let ts = now();
    if let Some(name) = &input.name {
        sqlx::query("UPDATE groups SET name = $1 WHERE id = $2")
            .bind(name)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新分组失败: {}", e))?;
    }
    if let Some(sort_order) = input.sort_order {
        sqlx::query("UPDATE groups SET sort_order = $1 WHERE id = $2")
            .bind(sort_order)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新分组排序失败: {}", e))?;
    }
    let _ = ts; // updated_at 暂不用于 groups
    Ok(())
}

/// 删除分组（组内任务的 group_id 回填为清单的默认分组）
#[tauri::command]
pub async fn group_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    let row = sqlx::query("SELECT list_id FROM groups WHERE id = $1")
        .bind(&id)
        .fetch_optional(pool.inner())
        .await
        .map_err(|e| format!("查询分组失败: {}", e))?;
    let list_id: String = match row {
        Some(r) => r.get("list_id"),
        None => return Ok(()),
    };
    let default_group_id = format!("{}-default", list_id);
    if id == default_group_id {
        return Err("不能删除默认分组".to_string());
    }
    sqlx::query("UPDATE tasks SET group_id = $1 WHERE group_id = $2")
        .bind(&default_group_id)
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("回填任务分组失败: {}", e))?;
    sqlx::query("DELETE FROM groups WHERE id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除分组失败: {}", e))?;
    Ok(())
}

/// 批量重排分组顺序
#[tauri::command]
pub async fn group_reorder(
    pool: State<'_, sqlx::SqlitePool>,
    ordered_ids: Vec<String>,
) -> CmdResult<()> {
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE groups SET sort_order = $1 WHERE id = $2")
            .bind((i * 1000) as i64)
            .bind(id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("重排分组失败: {}", e))?;
    }
    Ok(())
}
