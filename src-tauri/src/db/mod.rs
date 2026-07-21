// 数据库管理 —— 使用 sqlx 直接操作 SQLite
// 通过 tauri::State 持有连接池，所有操作封装为 #[tauri::command]

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use sqlx::Row;
use std::str::FromStr;

pub const MIGRATIONS_001: &str = include_str!("migrations/001_init.sql");
pub const MIGRATIONS_002: &str = include_str!("migrations/002_habits.sql");
pub const MIGRATIONS_014: &str = include_str!("migrations/014_templates.sql");
pub const MIGRATIONS_015: &str = include_str!("migrations/015_templates_date_cn.sql");

/// 检查表中是否存在某列
async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> Result<bool, String> {
    let rows = sqlx::query(&format!("PRAGMA table_info({})", table))
        .fetch_all(pool)
        .await
        .map_err(|e| format!("检查列失败: {}", e))?;
    Ok(rows.iter().any(|r| r.get::<String, _>("name") == column))
}

/// 安全地添加列（仅在不存在时添加）
async fn add_column_if_missing(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    def: &str,
) -> Result<(), String> {
    if !column_exists(pool, table, column).await? {
        sqlx::query(&format!(
            "ALTER TABLE {} ADD COLUMN {} {}",
            table, column, def
        ))
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
    sqlx::query(
        "UPDATE tasks SET due_end_at = due_at WHERE due_at IS NOT NULL AND due_end_at IS NULL",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("迁移 due_end_at 数据失败: {}", e))?;
    sqlx::query(
        "UPDATE tasks SET due_start_at = due_at WHERE due_at IS NOT NULL AND due_start_at IS NULL",
    )
    .execute(pool)
    .await
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
    for (name, sql) in [("001_init", MIGRATIONS_001), ("002_habits", MIGRATIONS_002)] {
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

    // 008: 任务提醒字段（remind_offset_minutes + notified_at）
    run_migration_008(&pool).await?;

    // 009: 任务检查项字段（checklist JSON 数组）
    run_migration_009(&pool).await?;

    // 010: 重复任务实例来源标记（recurrence_origin_id）+ 存量数据回填
    run_migration_010(&pool).await?;

    // 011: tags / habits 加 position 字段（侧边栏拖拽排序）
    run_migration_011(&pool).await?;

    // 012: habits 加 time_of_day（上午/下午/晚上 分组）
    run_migration_012(&pool).await?;

    // 013: habits 加 icon（emoji 图标，默认 🏆）
    run_migration_013(&pool).await?;

    // 014: 任务模板表 + 内置模板 seed
    // 纯 SQL（建表 + INSERT OR IGNORE），与 001/002 同模式（幂等）
    sqlx::query(MIGRATIONS_014)
        .execute(&pool)
        .await
        .map_err(|e| format!("执行迁移 014_templates 失败: {}", e))?;

    // 015: 内置模板占位符 {{date}} → {{date_cn}}（只动 title，保留用户对 note 的修改）
    sqlx::query(MIGRATIONS_015)
        .execute(&pool)
        .await
        .map_err(|e| format!("执行迁移 015_templates_date_cn 失败: {}", e))?;

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
    add_column_if_missing(
        pool,
        "tasks",
        "recurrence_interval",
        "INTEGER NOT NULL DEFAULT 1",
    )
    .await?;
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
    // 默认 1 分钟：提醒/重复任务扫描的合理粒度。旧值 60 在 INSERT OR IGNORE 下保留。
    sqlx::query(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('recurrence_check_interval', '1')",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("写入默认设置失败: {}", e))?;

    Ok(())
}

/// 迁移 008：任务提醒字段
/// - remind_offset_minutes: 提前多少分钟提醒（null = 不提醒；0 = 准点；N = 提前 N 分钟）
/// - notified_at: 首次触发通知的时间戳（null = 还没通知过；写入后置 ISO 字符串，
///   用于防止重复通知 + 启动时识别"已过窗口但未通知"的任务）
async fn run_migration_008(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "remind_offset_minutes", "INTEGER").await?;
    add_column_if_missing(pool, "tasks", "notified_at", "TEXT").await?;
    Ok(())
}

/// 迁移 009：任务检查项字段
/// - checklist: JSON 数组 [{id, title, done, order}]，独立于 note 富文本
///   任务详情面板把"描述（富文本）"和"检查项（独立列表）"分开管理（滴答清单风格）
async fn run_migration_009(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "checklist", "TEXT NOT NULL DEFAULT '[]'").await?;
    Ok(())
}

/// 迁移 010：重复任务实例来源标记
/// - recurrence_origin_id: 标记实例来自哪个模板（null = 普通任务或自身即模板）
///
/// 背景：旧逻辑把重复实例的 parent_id 指向模板 id，导致实例被所有
/// `parent_id IS NULL` 的列表/智能视图/计数/搜索查询过滤掉（用户看不见）。
/// 新增独立列后，parent_id 回归「仅表示子任务嵌套」单一语义，
/// 实例以 parent_id=NULL 作为根任务正常进列表，用 recurrence_origin_id 记录来源。
async fn run_migration_010(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "recurrence_origin_id", "TEXT").await?;

    // 回填存量：把指向重复模板的实例从 parent_id 迁移到 recurrence_origin_id
    // 启发式条件——parent_id 指向一个 recurrence_freq 非空的模板、且自身非模板。
    // 当前代码中没有产生「普通子任务挂在重复模板下」的途径，故此条件安全。
    // WHERE recurrence_origin_id IS NULL 保证幂等（可重复执行）。
    sqlx::query(
        "UPDATE tasks SET recurrence_origin_id = parent_id, parent_id = NULL
         WHERE parent_id IS NOT NULL
           AND recurrence_freq IS NULL
           AND parent_id IN (SELECT id FROM tasks WHERE recurrence_freq IS NOT NULL)
           AND recurrence_origin_id IS NULL",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("回填重复实例来源失败: {}", e))?;

    Ok(())
}

/// 迁移 011：tags / habits 加 position 字段
/// - tags: 侧边栏标签拖拽排序的 sort key
/// - habits: 侧边栏习惯快捷入口拖拽排序的 sort key
/// 旧数据全部 position=0，会聚拢在列表最前；用户首次拖拽后即分散开。
async fn run_migration_011(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tags", "position", "INTEGER NOT NULL DEFAULT 0").await?;
    add_column_if_missing(pool, "habits", "position", "INTEGER NOT NULL DEFAULT 0").await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tags_position ON tags(position)")
        .execute(pool)
        .await
        .map_err(|e| format!("创建 idx_tags_position 失败: {}", e))?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_habits_position ON habits(position)")
        .execute(pool)
        .await
        .map_err(|e| format!("创建 idx_habits_position 失败: {}", e))?;
    Ok(())
}

/// 迁移 012：habits 加 time_of_day 字段（上午/下午/晚上，默认 evening）
/// 存量数据自动回填为 evening，行为等价于"全部归到晚上"
async fn run_migration_012(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(
        pool,
        "habits",
        "time_of_day",
        "TEXT NOT NULL DEFAULT 'evening'",
    )
    .await?;
    Ok(())
}

/// 迁移 013：habits 加 icon 字段（emoji 字符，默认 🏆）
async fn run_migration_013(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(
        pool,
        "habits",
        "icon",
        "TEXT NOT NULL DEFAULT '🏆'",
    )
    .await?;
    Ok(())
}
