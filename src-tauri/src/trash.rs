// 回收站模块 —— 软删除 / 恢复 / 彻底删除的核心实现
//
// 数据模型（migration 035）：tasks.deleted_at / lists.deleted_at
// NULL = 未删除；非 NULL = 已入回收站（值为删除时刻，本地字面量）。
//
// 删除语义（整树软删除，替换 035 之前的硬删除）：
// - 删任务 = 该任务 + 全部后代子任务标记 deleted_at（task_trash）
// - 删清单/目录 = 清单子树 + 这些清单下的所有任务标记（list_trash）
//
// 回收站展示（trash_list_items）：只列「删除树的根」——父级未删除的条目，
// 避免删一个目录后回收站出现几十条；恢复顶层项 = 整棵子树恢复。
//
// 彻底删除（trash_purge / trash_empty）用 WITH RECURSIVE + DELETE 物理清除，
// 任务树递归收集后代（防外键约束阻塞），并同步清理关联数据：
// task_tags / recurrence_generated / groups / 附件磁盘文件。

use serde_json::Value;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, State};

use crate::commands::{now, CmdResult};
use crate::models::TrashItem;

// ─── 软删除（task_delete / list_delete 委托） ───────────────────

/// 任务入回收站：自身 + 全部后代子任务标记 deleted_at。
/// 由 commands::task_delete 调用（保持原命令签名，前端零改动）。
pub(crate) async fn task_trash(pool: &SqlitePool, id: &str) -> CmdResult<()> {
    let ts = now();
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM tasks WHERE id = $1
             UNION ALL
             SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
         )
         UPDATE tasks SET deleted_at = $2, updated_at = $2
         WHERE id IN (SELECT id FROM subtree)",
    )
    .bind(id)
    .bind(&ts)
    .execute(pool)
    .await
    .map_err(|e| format!("移入回收站失败: {}", e))?;
    Ok(())
}

/// 清单/目录入回收站：清单子树 + 这些清单下的所有任务标记 deleted_at。
/// 由 commands::list_delete 调用。任务标记按 list_id 直查（与恢复对称），
/// 不递归任务树 —— 正常数据里子任务与祖先同 list_id（挂载/移动时同步）。
pub(crate) async fn list_trash(pool: &SqlitePool, id: &str) -> CmdResult<()> {
    let ts = now();
    sqlx::query(
        "WITH RECURSIVE ltree(id) AS (
             SELECT id FROM lists WHERE id = $1
             UNION ALL
             SELECT l.id FROM lists l JOIN ltree s ON l.parent_id = s.id
         )
         UPDATE tasks SET deleted_at = $2, updated_at = $2
         WHERE list_id IN (SELECT id FROM ltree)",
    )
    .bind(id)
    .bind(&ts)
    .execute(pool)
    .await
    .map_err(|e| format!("移入清单条目失败: {}", e))?;

    sqlx::query(
        "WITH RECURSIVE ltree(id) AS (
             SELECT id FROM lists WHERE id = $1
             UNION ALL
             SELECT l.id FROM lists l JOIN ltree s ON l.parent_id = s.id
         )
         UPDATE lists SET deleted_at = $2
         WHERE id IN (SELECT id FROM ltree)",
    )
    .bind(id)
    .bind(&ts)
    .execute(pool)
    .await
    .map_err(|e| format!("移入回收站失败: {}", e))?;
    Ok(())
}

// ─── 回收站列表 ──────────────────────────────────────────

/// 列出回收站顶层项（删除树的根），按删除时间倒序。
/// 任务成为顶层项的条件：parent 链上无已删任务、所属清单未删除
/// （否则它属于某棵已删清单树，恢复清单时一并回来）。
/// 清单成为顶层项的条件：父目录未删除。
#[tauri::command]
pub async fn trash_list_items(pool: State<'_, SqlitePool>) -> CmdResult<Vec<TrashItem>> {
    // 已删任务（含笔记，kind 映射为 task/note）
    let task_rows = sqlx::query(
        "SELECT t.id,
                CASE WHEN t.kind = 'note' THEN 'note' ELSE 'task' END AS item_kind,
                t.title AS name, t.deleted_at,
                l.name AS origin,
                EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id) AS has_children
         FROM tasks t
         LEFT JOIN lists l ON l.id = t.list_id
         WHERE t.deleted_at IS NOT NULL
           AND (t.parent_id IS NULL OR NOT EXISTS(
                SELECT 1 FROM tasks p WHERE p.id = t.parent_id AND p.deleted_at IS NOT NULL))
           AND NOT EXISTS(
                SELECT 1 FROM lists dl WHERE dl.id = t.list_id AND dl.deleted_at IS NOT NULL)",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询回收站任务失败: {}", e))?;

    // 已删清单/目录/笔记本（is_folder/kind 映射为 folder/notebook/list）
    let list_rows = sqlx::query(
        "SELECT l.id,
                CASE WHEN l.is_folder = 1 THEN 'folder'
                     WHEN l.kind = 'note' THEN 'notebook'
                     ELSE 'list' END AS item_kind,
                l.name, l.deleted_at,
                p.name AS origin,
                (EXISTS(SELECT 1 FROM lists c WHERE c.parent_id = l.id)
                 OR EXISTS(SELECT 1 FROM tasks t2 WHERE t2.list_id = l.id)) AS has_children
         FROM lists l
         LEFT JOIN lists p ON p.id = l.parent_id
         WHERE l.deleted_at IS NOT NULL
           AND (l.parent_id IS NULL OR NOT EXISTS(
                SELECT 1 FROM lists dp WHERE dp.id = l.parent_id AND dp.deleted_at IS NOT NULL))",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询回收站清单失败: {}", e))?;

    let mut items: Vec<TrashItem> = task_rows
        .iter()
        .map(|r| TrashItem {
            id: r.get("id"),
            kind: r.get("item_kind"),
            name: r.get("name"),
            deleted_at: r.get::<Option<String>, _>("deleted_at").unwrap_or_default(),
            origin: r.get("origin"),
            has_children: r.get::<i64, _>("has_children") != 0,
        })
        .chain(list_rows.iter().map(|r| TrashItem {
            id: r.get("id"),
            kind: r.get("item_kind"),
            name: r.get("name"),
            deleted_at: r.get::<Option<String>, _>("deleted_at").unwrap_or_default(),
            origin: r.get("origin"),
            has_children: r.get::<i64, _>("has_children") != 0,
        }))
        .collect();
    // 本地字面量字典序 = 时间序，倒序 = 最近删除在前
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

// ─── 恢复 ────────────────────────────────────────────────

/// 恢复回收站条目（整棵子树）。
/// kind 为大类：'task'（任务/笔记）或 'list'（清单/笔记本/目录）。
/// 防御兜底（正常流程不会触发，顶层项定义已保证父级健在）：
/// - 任务的 parent 在回收站 → 提升为根任务（parent_id 置 NULL）
/// - 任务的所属清单在回收站 → 迁移到默认容器（收件箱/默认笔记本），分组置空
/// - 清单的父目录在回收站 → 挂到根级（parent_id 置 NULL）
#[tauri::command]
pub async fn trash_restore(pool: State<'_, SqlitePool>, id: String, kind: String) -> CmdResult<()> {
    let ts = now();
    if kind == "list" {
        // 父目录兜底：在回收站则挂根级
        sqlx::query(
            "UPDATE lists SET parent_id = NULL
             WHERE id = $1 AND parent_id IN (
                SELECT id FROM lists WHERE deleted_at IS NOT NULL)",
        )
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("恢复清单失败: {}", e))?;

        // 清单子树 + 其下任务整树恢复（条件与 list_trash 标记时对称）
        sqlx::query(
            "WITH RECURSIVE ltree(id) AS (
                 SELECT id FROM lists WHERE id = $1
                 UNION ALL
                 SELECT l.id FROM lists l JOIN ltree s ON l.parent_id = s.id
             )
             UPDATE tasks SET deleted_at = NULL, updated_at = $2
             WHERE deleted_at IS NOT NULL
               AND list_id IN (SELECT id FROM ltree)",
        )
        .bind(&id)
        .bind(&ts)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("恢复清单条目失败: {}", e))?;

        sqlx::query(
            "WITH RECURSIVE ltree(id) AS (
                 SELECT id FROM lists WHERE id = $1
                 UNION ALL
                 SELECT l.id FROM lists l JOIN ltree s ON l.parent_id = s.id
             )
             UPDATE lists SET deleted_at = NULL
             WHERE deleted_at IS NOT NULL
               AND id IN (SELECT id FROM ltree)",
        )
        .bind(&id)
        .bind(&ts)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("恢复清单失败: {}", e))?;
        return Ok(());
    }

    // 任务/笔记分支
    let row = sqlx::query("SELECT kind FROM tasks WHERE id = $1")
        .bind(&id)
        .fetch_optional(pool.inner())
        .await
        .map_err(|e| format!("查询任务失败: {}", e))?;
    let task_kind: String = match row {
        Some(r) => r.get("kind"),
        None => return Err("回收站中不存在该任务".to_string()),
    };

    // 容器兜底：所属清单在回收站 → 迁默认容器（分组随之置空，原分组不属于新清单）
    let fallback_list = if task_kind == "note" {
        "default-notebook"
    } else {
        "inbox"
    };
    sqlx::query(
        "UPDATE tasks SET list_id = $2, group_id = NULL, updated_at = $3
         WHERE id = $1 AND list_id IN (
            SELECT id FROM lists WHERE deleted_at IS NOT NULL)",
    )
    .bind(&id)
    .bind(fallback_list)
    .bind(&ts)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("恢复任务失败: {}", e))?;

    // 父级兜底：parent 在回收站 → 提升为根任务
    sqlx::query(
        "UPDATE tasks SET parent_id = NULL, updated_at = $2
         WHERE id = $1 AND parent_id IN (
            SELECT id FROM tasks WHERE deleted_at IS NOT NULL)",
    )
    .bind(&id)
    .bind(&ts)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("恢复任务失败: {}", e))?;

    // 任务子树整树恢复
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM tasks WHERE id = $1
             UNION ALL
             SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
         )
         UPDATE tasks SET deleted_at = NULL, updated_at = $2
         WHERE deleted_at IS NOT NULL AND id IN (SELECT id FROM subtree)",
    )
    .bind(&id)
    .bind(&ts)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("恢复任务失败: {}", e))?;
    Ok(())
}

// ─── 彻底删除 ────────────────────────────────────────────

/// 解析一行 attachments JSON，提取附件 stored_name 列表（解析失败返回空）
fn attachment_names(json_text: Option<String>) -> Vec<String> {
    json_text
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("storedName").and_then(|v| v.as_str()))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// 尽力删除附件磁盘文件（事务外调用；文件缺失视为成功，失败仅忽略——
/// DB 已删，残留文件只是磁盘孤儿，不应阻断删除流程）
fn remove_attachment_files(dir: &str, names: &[String]) {
    for name in names {
        let filepath = std::path::PathBuf::from(dir).join(name);
        if filepath.exists() {
            if let Err(e) = std::fs::remove_file(&filepath) {
                eprintln!("[trash] 清理附件文件失败 {} : {}", name, e);
            }
        }
    }
}

/// 彻底删除单条（整棵子树物理删除）。kind: 'task' | 'list'。
#[tauri::command]
pub async fn trash_purge(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    id: String,
    kind: String,
) -> CmdResult<()> {
    if kind == "list" {
        purge_lists(
            pool.inner(),
            &app,
            &format!(
                "WITH RECURSIVE ltree(id) AS (
                 SELECT id FROM lists WHERE id = '{lid}'
                 UNION ALL
                 SELECT l.id FROM lists l JOIN ltree s ON l.parent_id = s.id
             ) SELECT id FROM ltree",
                lid = escape_sql(&id)
            ),
        )
        .await
    } else {
        // 任务子树（含跨清单挂载的后代，UNION 去重防环）
        purge_tasks(
            pool.inner(),
            &app,
            &format!(
                "WITH RECURSIVE subtree(id) AS (
                 SELECT id FROM tasks WHERE id = '{tid}'
                 UNION
                 SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
             ) SELECT id FROM subtree",
                tid = escape_sql(&id)
            ),
        )
        .await
    }
}

/// 清空回收站：所有已删除任务 + 已删除清单全部物理删除。
#[tauri::command]
pub async fn trash_empty(app: AppHandle, pool: State<'_, SqlitePool>) -> CmdResult<()> {
    // 先删任务（含已删任务的后代，防外键阻塞），再删清单及其分组
    purge_tasks(
        pool.inner(),
        &app,
        "WITH RECURSIVE ttree(id) AS (
             SELECT id FROM tasks WHERE deleted_at IS NOT NULL
             UNION
             SELECT c.id FROM tasks c JOIN ttree s ON c.parent_id = s.id
         ) SELECT id FROM ttree",
    )
    .await?;
    purge_lists(
        pool.inner(),
        &app,
        "SELECT id FROM lists WHERE deleted_at IS NOT NULL",
    )
    .await
}

/// SQL 字符串字面量转义（id 拼进 CTE 需要防注入；id 来自前端 UUID，
/// 正常不含引号，这里做纵深防御）
fn escape_sql(s: &str) -> String {
    s.replace('\'', "''")
}

/// 按 CTE 收集到的清单 id 集合物理删除：清单下的任务（递归后代）→
/// 任务关联（task_tags/recurrence_generated/附件）→ groups → lists 本体。
/// 附件文件在事务提交后清理。
async fn purge_lists(pool: &SqlitePool, app: &AppHandle, list_cte: &str) -> CmdResult<()> {
    // 清单树下的任务（递归任务后代，覆盖跨清单挂载的子任务，防外键阻塞）
    let task_sql = format!(
        "WITH RECURSIVE lid(id) AS ({cte}),
         ttree(id) AS (
             SELECT t.id FROM tasks t WHERE t.list_id IN (SELECT id FROM lid)
             UNION
             SELECT c.id FROM tasks c JOIN ttree s ON c.parent_id = s.id
         ) SELECT id FROM ttree",
        cte = list_cte
    );
    purge_tasks(pool, app, &task_sql).await?;

    // 删除清单本体与其分组（分组不级联依赖：手动先删，外键开关两种情况都正确）
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let list_ids: Vec<String> = sqlx::query(list_cte)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| format!("查询清单子树失败: {}", e))?
        .iter()
        .map(|r| r.get::<String, _>("id"))
        .collect();

    for lid in &list_ids {
        sqlx::query("DELETE FROM groups WHERE list_id = $1")
            .bind(lid)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("清理分组失败: {}", e))?;
        sqlx::query("DELETE FROM lists WHERE id = $1")
            .bind(lid)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("删除清单失败: {}", e))?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

/// 按 CTE 收集到的任务 id 集合物理删除：
/// 先取附件清单 → 事务内删 task_tags / recurrence_generated / tasks → 提交后删附件文件。
async fn purge_tasks(pool: &SqlitePool, app: &AppHandle, task_cte: &str) -> CmdResult<()> {
    // 事务外先读附件元数据（行删掉就拿不到了）
    let rows = sqlx::query(&format!(
        "SELECT attachments FROM tasks WHERE id IN ({cte}) AND attachments IS NOT NULL AND attachments != '[]'",
        cte = task_cte
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询附件失败: {}", e))?;
    let names: Vec<String> = rows
        .iter()
        .flat_map(|r| attachment_names(r.try_get::<String, _>("attachments").ok()))
        .collect();

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;
    for table_sql in [
        format!(
            "DELETE FROM task_tags WHERE task_id IN ({cte})",
            cte = task_cte
        ),
        format!(
            "DELETE FROM recurrence_generated WHERE template_id IN ({cte}) OR instance_id IN ({cte})",
            cte = task_cte
        ),
        format!("DELETE FROM tasks WHERE id IN ({cte})", cte = task_cte),
    ] {
        sqlx::query(&table_sql)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("彻底删除失败: {}", e))?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    if !names.is_empty() {
        if let Ok(dir) = crate::commands::get_attachment_path(app.clone()).await {
            remove_attachment_files(&dir, &names);
        }
    }
    Ok(())
}
