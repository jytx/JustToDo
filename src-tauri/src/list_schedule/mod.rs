// 清单生成计划 —— 模块入口
// 设计依据：discuss/2026-07-30-list-schedule-design.md
//
// 本模块负责：按用户配置的"清单生成计划"自动创建目录/清单。
// 调度入口 list_schedule_tick 挂在 lib.rs 的每分钟后台循环里。
// 节假日判断走 holiday 子模块，路径渲染/逐级创建走 generate 子模块。

pub mod generate;
pub mod holiday;
pub mod models;

use chrono::{Local, NaiveDate};
use sqlx::Row;
use tauri::State;

use crate::commands::CmdResult;
use crate::commands::{now, uuid};

use models::{CreateScheduleInput, ListSchedule, SchedulePreview, UpdateScheduleInput};

// ─── DB 行 → 结构体 ──────────────────────────────────────

/// 把 sqlx 行映射为 ListSchedule（字段顺序与 SELECT 一致）
fn row_to_schedule(row: &sqlx::sqlite::SqliteRow) -> ListSchedule {
    ListSchedule {
        id: row.get("id"),
        name: row.get("name"),
        path_template: row.get("path_template"),
        freq: row.get("freq"),
        leaf_type: row.get("leaf_type"),
        color: row.get("color"),
        enabled: row.get::<i64, _>("enabled") != 0,
        position: row.get("position"),
        created_at: row.get("created_at"),
    }
}

/// 查全部计划（含已停用），按 position 排序
async fn get_all_schedules_inner(pool: &sqlx::SqlitePool) -> Result<Vec<ListSchedule>, String> {
    let rows = sqlx::query(
        "SELECT id, name, path_template, freq, leaf_type, color, enabled, position, created_at \
         FROM list_schedules ORDER BY position ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询计划失败: {}", e))?;
    Ok(rows.iter().map(row_to_schedule).collect())
}

/// 查全部启用中的计划
async fn get_enabled_schedules(pool: &sqlx::SqlitePool) -> Result<Vec<ListSchedule>, String> {
    let rows = sqlx::query(
        "SELECT id, name, path_template, freq, leaf_type, color, enabled, position, created_at \
         FROM list_schedules WHERE enabled = 1 ORDER BY position ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询计划失败: {}", e))?;
    Ok(rows.iter().map(row_to_schedule).collect())
}

// ─── 调度主循环 ──────────────────────────────────────────

/// 每轮 tick：检查今天是否该为各计划生成清单
///
/// 传入 today 便于测试；生产环境由 list_schedule_tick 取本地今天。
/// 幂等：靠 ensure_scheduled_path 的"已存在则跳过"实现，无需去重表。
pub async fn list_schedule_tick_inner(
    pool: &sqlx::SqlitePool,
    today: NaiveDate,
) -> Result<u32, String> {
    let schedules = get_enabled_schedules(pool).await?;
    let mut count = 0u32;

    for s in &schedules {
        // workday 频率需结合节假日数据判断
        let hit = if s.freq == "workday" {
            holiday::is_workday(pool, today).await
        } else {
            generate::is_freq_hit(&s.freq, today)
        };

        if hit {
            match generate::run_schedule(pool, s, today).await {
                Ok(is_new) => {
                    if is_new {
                        count += 1;
                    }
                }
                Err(e) => eprintln!("[JustToDo] 计划「{}」生成失败: {}", s.name, e),
            }
        }

        // 月/年兜底：当期目录若不存在则补建（已存在则 ensure 自动跳过）
        // 解决"月初那天没开软件，当月就永远没目录"的问题。
        // daily/weekly/workday 不做兜底（过去的日清单不补）。
        if s.freq == "monthly" || s.freq == "yearly" {
            let path = generate::render_path_template(&s.path_template, today);
            let leaf_folder = generate::leaf_is_folder(&s.leaf_type);
            match ensure_period_folder(pool, &path, leaf_folder, &s.color).await {
                Ok(is_new) => {
                    if is_new {
                        count += 1;
                    }
                }
                Err(e) => eprintln!("[JustToDo] 计划「{}」兜底目录失败: {}", s.name, e),
            }
        }
    }

    Ok(count)
}

/// 月/年兜底：确保当期路径存在（已存在则 ensure 跳过）
/// 返回最末段是否为本次新建
async fn ensure_period_folder(
    pool: &sqlx::SqlitePool,
    path: &str,
    leaf_is_folder: bool,
    color: &str,
) -> Result<bool, String> {
    let (_, is_new) = generate::ensure_scheduled_path(pool, path, leaf_is_folder, color).await?;
    Ok(is_new)
}

/// 对外：给 lib.rs 调用的入口（取本地今天）
pub async fn list_schedule_tick(pool: &sqlx::SqlitePool) -> Result<u32, String> {
    list_schedule_tick_inner(pool, Local::now().date_naive()).await
}

// ─── IPC 命令（CRUD） ────────────────────────────────────

/// 查全部计划
#[tauri::command]
pub async fn list_schedule_get_all(
    pool: State<'_, sqlx::SqlitePool>,
) -> CmdResult<Vec<ListSchedule>> {
    get_all_schedules_inner(pool.inner()).await
}

/// 新建计划
#[tauri::command]
pub async fn list_schedule_create(
    pool: State<'_, sqlx::SqlitePool>,
    input: CreateScheduleInput,
) -> CmdResult<ListSchedule> {
    let id = uuid();
    let ts = now();
    let position = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO list_schedules (id, name, path_template, freq, leaf_type, color, enabled, position, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.path_template)
    .bind(&input.freq)
    .bind(&input.leaf_type)
    .bind(&input.color)
    .bind(position)
    .bind(&ts)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建计划失败: {}", e))?;

    Ok(ListSchedule {
        id,
        name: input.name,
        path_template: input.path_template,
        freq: input.freq,
        leaf_type: input.leaf_type,
        color: input.color,
        enabled: true,
        position,
        created_at: ts,
    })
}

/// 更新计划（支持部分字段更新）
#[tauri::command]
pub async fn list_schedule_update(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    input: UpdateScheduleInput,
) -> CmdResult<()> {
    // 逐字段拼接 UPDATE，仅更新非 None 的字段（避免覆盖未传字段）
    let mut sets: Vec<&str> = Vec::new();
    if input.name.is_some() {
        sets.push("name = ?");
    }
    if input.path_template.is_some() {
        sets.push("path_template = ?");
    }
    if input.freq.is_some() {
        sets.push("freq = ?");
    }
    if input.leaf_type.is_some() {
        sets.push("leaf_type = ?");
    }
    if input.color.is_some() {
        sets.push("color = ?");
    }
    if input.enabled.is_some() {
        sets.push("enabled = ?");
    }
    if sets.is_empty() {
        return Ok(());
    }

    let sql = format!("UPDATE list_schedules SET {} WHERE id = ?", sets.join(", "));
    let mut q = sqlx::query(&sql);
    if let Some(v) = input.name {
        q = q.bind(v);
    }
    if let Some(v) = input.path_template {
        q = q.bind(v);
    }
    if let Some(v) = input.freq {
        q = q.bind(v);
    }
    if let Some(v) = input.leaf_type {
        q = q.bind(v);
    }
    if let Some(v) = input.color {
        q = q.bind(v);
    }
    if let Some(v) = input.enabled {
        q = q.bind(if v { 1i64 } else { 0 });
    }
    q = q.bind(id);

    q.execute(pool.inner())
        .await
        .map_err(|e| format!("更新计划失败: {}", e))?;
    Ok(())
}

/// 删除计划
#[tauri::command]
pub async fn list_schedule_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM list_schedules WHERE id = ?")
        .bind(id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除计划失败: {}", e))?;
    Ok(())
}

/// 立即触发一次 tick（手动测试 / 补生成用）
#[tauri::command]
pub async fn list_schedule_run_now(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<u32> {
    list_schedule_tick(pool.inner()).await
}

/// 预览：模拟某一天运行会生成哪些路径（不实际创建，仅用于调试）
///
/// 返回每条启用计划在该日期的预览结果：是否命中 + 渲染后的路径。
/// 用于回答"下月1号那天到底会不会建清单"这类问题，不污染真实数据。
#[tauri::command]
pub async fn list_schedule_preview(
    pool: State<'_, sqlx::SqlitePool>,
    date: String,
) -> CmdResult<Vec<SchedulePreview>> {
    // 解析日期（YYYY-MM-DD），失败返回错误
    let target = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|e| format!("日期格式错误（应为 YYYY-MM-DD）: {}", e))?;

    let schedules = get_enabled_schedules(pool.inner()).await?;
    let mut previews: Vec<SchedulePreview> = Vec::new();

    for s in &schedules {
        // workday 频率需结合节假日判断
        let hit = if s.freq == "workday" {
            holiday::is_workday(pool.inner(), target).await
        } else {
            generate::is_freq_hit(&s.freq, target)
        };

        let path = generate::render_path_template(&s.path_template, target);
        previews.push(SchedulePreview {
            name: s.name.clone(),
            freq: s.freq.clone(),
            hit,
            path,
            is_folder: generate::leaf_is_folder(&s.leaf_type),
        });
    }

    Ok(previews)
}
