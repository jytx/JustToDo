// 数据库管理 —— 使用 sqlx 直接操作 SQLite
// 通过 tauri::State 持有连接池，所有操作封装为 #[tauri::command]

use sqlx::sqlite::{SqlitePool, SqliteConnectOptions};
use sqlx::Row;
use std::str::FromStr;

pub const MIGRATIONS_001: &str = include_str!("migrations/001_init.sql");
pub const MIGRATIONS_002: &str = include_str!("migrations/002_habits.sql");

/// 检查表中是否存在某列
async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> Result<bool, String> {
    let rows = sqlx::query(&format!("PRAGMA table_info({})", table))
        .fetch_all(pool)
        .await
        .map_err(|e| format!("检查列失败: {}", e))?;
    Ok(rows.iter().any(|r| r.get::<String, _>("name") == column))
}

/// 安全地添加列（仅在不存在时添加）
async fn add_column_if_missing(pool: &SqlitePool, table: &str, column: &str, def: &str) -> Result<(), String> {
    if !column_exists(pool, table, column).await? {
        sqlx::query(&format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, def))
            .execute(pool)
            .await
            .map_err(|e| format!("添加列 {}.{} 失败: {}", table, column, e))?;
    }
    Ok(())
}

/// 迁移 003：due_at → due_start_at + due_end_at
async fn run_migration_003(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "due_start_at", "TEXT").await?;
    add_column_if_missing(pool, "tasks", "due_end_at", "TEXT").await?;

    // 迁移旧数据：把 due_at 的值复制到新列（仅当新列为空时）
    sqlx::query("UPDATE tasks SET due_end_at = due_at WHERE due_at IS NOT NULL AND due_end_at IS NULL")
        .execute(pool).await
        .map_err(|e| format!("迁移 due_end_at 数据失败: {}", e))?;
    sqlx::query("UPDATE tasks SET due_start_at = due_at WHERE due_at IS NOT NULL AND due_start_at IS NULL")
        .execute(pool).await
        .map_err(|e| format!("迁移 due_start_at 数据失败: {}", e))?;

    // 新索引（幂等）
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tasks_due_end ON tasks(due_end_at) WHERE due_end_at IS NOT NULL")
        .execute(pool).await
        .map_err(|e| format!("创建索引失败: {}", e))?;

    Ok(())
}

/// 初始化数据库连接池并执行迁移
pub async fn init_pool(db_path: &str) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::from_str(db_path)
        .map_err(|e| format!("无效的数据库路径: {}", e))?
        .create_if_missing(true);

    let pool = SqlitePool::connect_with(options)
        .await
        .map_err(|e| format!("连接数据库失败: {}", e))?;

    // 依次执行迁移（001/002 用 SQL 文件，幂等）
    for (name, sql) in [
        ("001_init", MIGRATIONS_001),
        ("002_habits", MIGRATIONS_002),
    ] {
        sqlx::query(sql)
            .execute(&pool)
            .await
            .map_err(|e| format!("执行迁移 {} 失败: {}", name, e))?;
    }

    // 003 用 Rust 代码处理（ALTER TABLE 不支持 IF NOT EXISTS）
    run_migration_003(&pool).await?;

    // 004: lists 表加 parent_id + is_folder
    run_migration_004(&pool).await?;

    // 005: 排序偏好字段
    run_migration_005(&pool).await?;

    // 006: 任务重复规则字段
    run_migration_006(&pool).await?;

    // 007: 应用设置 KV 表
    run_migration_007(&pool).await?;

    Ok(pool)
}

/// 迁移 004：lists 表加 parent_id（目录父级）+ is_folder（是否目录）
async fn run_migration_004(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "lists", "parent_id", "TEXT").await?;
    add_column_if_missing(pool, "lists", "is_folder", "INTEGER NOT NULL DEFAULT 0").await?;
    Ok(())
}

/// 迁移 005：排序偏好 —— lists 加 sort_field/sort_dir；新建 tag_sort_prefs 表
async fn run_migration_005(pool: &SqlitePool) -> Result<(), String> {
    // lists 表加列
    add_column_if_missing(pool, "lists", "sort_field", "TEXT").await?;
    add_column_if_missing(pool, "lists", "sort_dir", "TEXT").await?;

    // 标签排序偏好表
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tag_sort_prefs (
            tag_id     TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
            sort_field TEXT NOT NULL,
            sort_dir   TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("创建 tag_sort_prefs 表失败: {}", e))?;

    Ok(())
}

/// 迁移 006：任务重复规则字段
/// - recurrence_freq: 频率（daily/weekly/monthly/yearly），null = 不重复
/// - recurrence_interval: 间隔（每 N 天/周/月/年）
/// - recurrence_end_at: 结束日期（null = 永不结束）
/// - recurrence_count: 剩余次数（null = 不限）
async fn run_migration_006(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "recurrence_freq", "TEXT").await?;
    add_column_if_missing(pool, "tasks", "recurrence_interval", "INTEGER NOT NULL DEFAULT 1").await?;
    add_column_if_missing(pool, "tasks", "recurrence_end_at", "TEXT").await?;
    add_column_if_missing(pool, "tasks", "recurrence_count", "INTEGER").await?;
    Ok(())
}

/// 迁移 007：应用设置 KV 表
/// 存储 recurrence_check_interval（重复任务检查间隔，单位：分钟，默认 60）
async fn run_migration_007(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("创建 app_settings 表失败: {}", e))?;

    // 写入默认值（幂等：仅当不存在时插入）
    sqlx::query(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('recurrence_check_interval', '60')",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("写入默认设置失败: {}", e))?;

    Ok(())
}
