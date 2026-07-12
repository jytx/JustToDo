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

    Ok(pool)
}
