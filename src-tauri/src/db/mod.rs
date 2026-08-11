// 数据库管理 —— 使用 sqlx 直接操作 SQLite
// 通过 tauri::State 持有连接池，所有操作封装为 #[tauri::command]

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use sqlx::Row;
use std::str::FromStr;

pub const MIGRATIONS_001: &str = include_str!("migrations/001_init.sql");
pub const MIGRATIONS_002: &str = include_str!("migrations/002_habits.sql");
pub const MIGRATIONS_014: &str = include_str!("migrations/014_templates.sql");
pub const MIGRATIONS_015: &str = include_str!("migrations/015_templates_date_cn.sql");
pub const MIGRATIONS_016: &str = include_str!("migrations/016_templates_placeholders.sql");
pub const MIGRATIONS_017: &str = include_str!("migrations/017_daily_reminder_log.sql");
pub const MIGRATIONS_021: &str = include_str!("migrations/021_list_schedules.sql");
pub const MIGRATIONS_026: &str = include_str!("migrations/026_groups.sql");
pub const MIGRATIONS_027: &str = include_str!("migrations/027_recurrence_history.sql");

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
///
/// `app_data_dir`: 应用数据目录路径。仅 migration 019 需要（用它定位附件目录来移动磁盘文件）。
/// 传 None 时跳过 019（用于不涉及附件迁移的纯 DB 初始化场景，当前无此调用，保留扩展性）。
pub async fn init_pool(
    db_path: &str,
    app_data_dir: Option<&std::path::Path>,
) -> Result<SqlitePool, String> {
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

    // 016: 内置模板用户语义占位符 {{title}}/{{book}} → 下划线（程序无法自动替换）
    sqlx::query(MIGRATIONS_016)
        .execute(&pool)
        .await
        .map_err(|e| format!("执行迁移 016_templates_placeholders 失败: {}", e))?;

    // 017: 每日固定时点提醒日志（去重）
    sqlx::query(MIGRATIONS_017)
        .execute(&pool)
        .await
        .map_err(|e| format!("执行迁移 017_daily_reminder_log 失败: {}", e))?;

    // 018: 任务附件字段（attachments JSON 数组）
    run_migration_018(&pool).await?;

    // 019: 附件磁盘文件按"日期/类型"分目录（存量迁移）
    // 需要 app_data_dir 来定位附件目录，若未提供则跳过（保留旧平铺结构，功能不丢）
    if let Some(data_dir) = app_data_dir {
        run_migration_019(&pool, data_dir).await?;
    }

    // 020: lists 表加 archived（清单/目录归档位，0=未归档 1=已归档）
    run_migration_020(&pool).await?;

    // 021: 清单生成计划 + 节假日缓存（纯 SQL 建表，幂等）
    sqlx::query(MIGRATIONS_021)
        .execute(&pool)
        .await
        .map_err(|e| format!("执行迁移 021_list_schedules 失败: {}", e))?;

    // 022: list_schedules 加 leaf_type（生成项类型，与频率解耦）
    run_migration_022(&pool).await?;

    // 023: tasks/lists 加 kind 字段（区分待办/笔记、清单/笔记本）+ 预置默认笔记本
    run_migration_023(&pool).await?;

    // 024: templates 加 kind 字段（区分任务模板/笔记模板）
    run_migration_024(&pool).await?;

    // 025: 修复孤儿任务 —— list_id 指向已不存在清单的 tasks，迁移到默认容器
    run_migration_025(&pool).await?;

    // 026: 任务分组（groups 表 + tasks.group_id 列 + 预置默认分组）
    run_migration_026(&pool).await?;

    // 027: 重复任务生成历史表（建表 + 存量回填，纯 SQL 幂等）
    sqlx::query(MIGRATIONS_027)
        .execute(&pool)
        .await
        .map_err(|e| format!("执行迁移 027_recurrence_history 失败: {}", e))?;

    // 028: 重复任务暂停标记（recurrence_paused，0=运行中 1=已暂停）
    run_migration_028(&pool).await?;

    // 029: 任务标题关联 URL（title_url，详情面板「解析网页标题」功能）
    run_migration_029(&pool).await?;

    // 030: task_tags 加 sort_order —— 任务项内标签的独立显示顺序
    run_migration_030(&pool).await?;

    // 031: tags 加 color —— 标签自定义颜色（淡色底 chip 显示）
    run_migration_031(&pool).await?;

    // 032: tasks 加 remind_at —— 指定时刻提醒（与 remind_offset_minutes 互斥）
    run_migration_032(&pool).await?;

    Ok(pool)
}

/// 迁移 029：任务标题关联 URL
/// - tasks.title_url：标题关联的网页链接（null = 无链接）。
///   详情面板标题输入 URL → 点击解析图标抓取网页标题替换标题文本，
///   原 URL 存到本列，标题旁显示可点击链接 chip（点击用系统浏览器打开）。
async fn run_migration_029(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "title_url", "TEXT").await?;
    Ok(())
}

/// 迁移 030：task_tags 加 sort_order —— 任务项内标签的独立显示顺序
///
/// 之前标签显示顺序由全局 tags.position 决定（同一标签在所有任务里位置固定），
/// 无法做到"任务 A 里 [工作, 紧急]、任务 B 里 [紧急, 工作]"各自不同的排列。
/// 加列后，task_tags.sort_order 记录每个任务内标签的局部顺序：
/// - 新增关联时追加到末尾（task_add_tag 计算 MAX(sort_order)+1）
/// - 拖拽排序时按 i*1000 全量重写（task_reorder_tags，对齐 group_reorder 模式）
/// - 旧数据缺省为 0，查询时按 sort_order ASC 兜底 created_at ASC
async fn run_migration_030(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "task_tags", "sort_order", "INTEGER NOT NULL DEFAULT 0").await?;
    Ok(())
}

/// 迁移 031：tags 加 color —— 标签自定义颜色
///
/// 标签 chip 的底色由该字段决定（前端 color-mix 生成淡色背景）。
/// 默认值 '#EF4444'（LIST_COLORS 第一个颜色，红色），存量标签统一获得红色，
/// 用户可在侧边栏「编辑标签」弹窗里逐个修改。
async fn run_migration_031(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tags", "color", "TEXT NOT NULL DEFAULT '#EF4444'").await?;
    Ok(())
}

/// 迁移 032：tasks 加 remind_at —— 指定时刻提醒
///
/// 现有提醒机制基于「相对截止时间的偏移」remind_offset_minutes，
/// 触发时刻 = due_end_at - offset，无法表达「截止 23:59 但想在 15:00 提醒」。
/// 新增 remind_at 存「绝对本地时刻」（本地字面量 "YYYY-MM-DDTHH:mm:ss"，
/// 与 due 体系一致），与 remind_offset_minutes 互斥：同一时刻只有一个生效。
/// 存量任务天然为 null（未启用），无需回填。
async fn run_migration_032(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "remind_at", "TEXT").await?;
    Ok(())
}

/// 迁移 028：重复任务暂停标记
/// - recurrence_paused: 0=运行中（默认），1=已暂停（后台 tick 跳过生成）
/// 用于「后台任务管理」面板的暂停/恢复切换，不影响已生成的实例
async fn run_migration_028(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "recurrence_paused", "INTEGER NOT NULL DEFAULT 0").await?;
    Ok(())
}

/// 迁移 020：清单/目录归档状态（与 018 同模式：单列添加 + DEFAULT 0）
async fn run_migration_020(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "lists", "archived", "INTEGER NOT NULL DEFAULT 0").await?;
    Ok(())
}

/// 迁移 022：list_schedules 加 leaf_type（生成项类型，与频率解耦）
///
/// 之前由 freq 自动推断（monthly/yearly→目录，其余→清单），但"月目录""日清单"
/// 的类型应由用户显式指定。加列后按原推断规则回填存量数据，升级后用户可自行调整。
/// 回填 UPDATE 天然幂等（重复执行结果一致）。
async fn run_migration_022(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(
        pool,
        "list_schedules",
        "leaf_type",
        "TEXT NOT NULL DEFAULT 'list'",
    )
    .await?;
    // 回填：保留原 freq 推断行为
    sqlx::query(
        "UPDATE list_schedules SET leaf_type = 'folder' \
         WHERE freq IN ('monthly', 'yearly') AND leaf_type = 'list'",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("回填 leaf_type 失败: {}", e))?;
    Ok(())
}

/// 迁移 023：tasks / lists 加 kind 字段 + 预置默认笔记本
///
/// - tasks.kind：'task'（待办，默认）| 'note'（笔记）。笔记复用 tasks 表全部基础设施，
///   但 due/done/completed/recurrence/remind 恒为默认值（由应用层保证）。
/// - lists.kind：'task'（清单/目录，默认）| 'note'（笔记本/笔记本目录）。清单与笔记本
///   共用 lists 表，靠 kind 隔离成两棵独立树（前端 moveNode 拦截跨 kind 移动）。
/// - 预置「默认笔记本」（id='default-notebook'），与 inbox 对称：删除笔记本时其下笔记
///   迁移到此（避免数据丢失）。INSERT OR IGNORE 天然幂等。
/// - 数据自洽修复：把归属于 kind='note' 的 list 下的 tasks，其 kind 修正为 'note'。
///   这一步在早期版本尤为关键——彼时前端 db.ts 的 createTask 漏传 kind，导致笔记本里
///   创建的笔记被错误地存成 kind='task'。UPDATE 天然幂等，可重复执行。
async fn run_migration_023(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "kind", "TEXT NOT NULL DEFAULT 'task'").await?;
    add_column_if_missing(pool, "lists", "kind", "TEXT NOT NULL DEFAULT 'task'").await?;
    sqlx::query(
        "INSERT OR IGNORE INTO lists (id, name, color, position, created_at, kind) \
         VALUES ('default-notebook', '默认笔记本', '#6B7280', 0, '2026-07-10T00:00:00Z', 'note')",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("预置默认笔记本失败: {}", e))?;
    // 数据自洽修复：笔记本（kind='note' 的 list）下的条目，kind 统一修正为 'note'
    sqlx::query(
        "UPDATE tasks SET kind = 'note' \
         WHERE kind != 'note' \
           AND list_id IN (SELECT id FROM lists WHERE kind = 'note')",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("修复笔记 kind 失败: {}", e))?;
    Ok(())
}

/// 迁移 024：templates 加 kind 字段（区分任务模板/笔记模板）
///
/// - templates.kind：'task'（任务模板，默认）| 'note'（笔记模板）。笔记模板复用
///   templates 表全部字段（name/title/note），应用时落地到当前笔记本或默认笔记本。
/// - 存量模板（4 个内置 + 用户自建）无需回填：DEFAULT 'task' 对旧记录自动生效。
async fn run_migration_024(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "templates", "kind", "TEXT NOT NULL DEFAULT 'task'").await?;
    Ok(())
}

/// 迁移 025：修复孤儿任务
///
/// 背景：旧版 `list_delete` 删除目录（is_folder=1）时只迁移了子清单的 parent_id，
/// 没有处理 tasks 表，导致挂在被删目录 id 上的任务（list_id 指向已不存在的清单）
/// 成为孤儿。其中若包含重复模板，后台 tick 每次生成实例都会因外键约束失败
/// （SQLite code 787）报错。本迁移一次性把这类孤儿迁回默认容器：
/// - kind='note' → default-notebook
/// - kind='task'（含默认）→ inbox
///
/// 用 NOT EXISTS 反向匹配孤儿（list_id 在 lists 表无对应行），UPDATE 天然幂等。
async fn run_migration_025(pool: &SqlitePool) -> Result<(), String> {
    // 笔记类孤儿 → 默认笔记本
    let notes_fixed = sqlx::query(
        "UPDATE tasks SET list_id = 'default-notebook' \
         WHERE kind = 'note' \
           AND list_id NOT IN (SELECT id FROM lists)",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("迁移025: 修复笔记孤儿失败: {}", e))?
    .rows_affected();

    // 待办类孤儿 → 收件箱
    let tasks_fixed = sqlx::query(
        "UPDATE tasks SET list_id = 'inbox' \
         WHERE kind != 'note' \
           AND list_id NOT IN (SELECT id FROM lists)",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("迁移025: 修复待办孤儿失败: {}", e))?
    .rows_affected();

    if notes_fixed + tasks_fixed > 0 {
        println!(
            "[JustToDo] 迁移025 完成: 修复孤儿任务 {} 条 (笔记 {}, 待办 {})",
            notes_fixed + tasks_fixed,
            notes_fixed,
            tasks_fixed,
        );
    }
    Ok(())
}

/// 迁移 026：任务分组
/// 1. 建 groups 表（幂等 CREATE IF NOT EXISTS）
/// 2. tasks 加 group_id 列（add_column_if_missing 幂等）
/// 3. 为每个已有清单创建「默认分组」并回填存量任务的 group_id
async fn run_migration_026(pool: &SqlitePool) -> Result<(), String> {
    // 1. 建 groups 表
    sqlx::query(MIGRATIONS_026)
        .execute(pool)
        .await
        .map_err(|e| format!("迁移026: 建表 groups 失败: {}", e))?;

    // 2. tasks 加 group_id 列
    add_column_if_missing(pool, "tasks", "group_id", "TEXT").await?;

    // 3. 为没有分组的清单创建默认分组 + 回填存量任务
    // 找出有任务但没有分组的清单
    let lists_without_groups = sqlx::query(
        "SELECT DISTINCT t.list_id FROM tasks t \
         LEFT JOIN groups g ON g.list_id = t.list_id \
         WHERE g.id IS NULL AND t.parent_id IS NULL",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("迁移026: 查询无分组清单失败: {}", e))?;

    let ts = chrono::Utc::now().to_rfc3339();
    let mut created = 0;
    let mut backfilled = 0;

    for row in &lists_without_groups {
        let list_id: String = row.get("list_id");
        let group_id = format!("{}-default", list_id);

        // 创建默认分组
        sqlx::query("INSERT OR IGNORE INTO groups (id, list_id, name, sort_order, created_at) VALUES ($1, $2, '默认分组', 0, $3)")
            .bind(&group_id)
            .bind(&list_id)
            .bind(&ts)
            .execute(pool)
            .await
            .map_err(|e| format!("迁移026: 创建默认分组失败: {}", e))?;
        created += 1;

        // 回填该清单下所有 group_id 为 NULL 的根任务
        let result = sqlx::query("UPDATE tasks SET group_id = $1 WHERE list_id = $2 AND group_id IS NULL AND parent_id IS NULL")
            .bind(&group_id)
            .bind(&list_id)
            .execute(pool)
            .await
            .map_err(|e| format!("迁移026: 回填 group_id 失败: {}", e))?;
        backfilled += result.rows_affected();
    }

    if created > 0 || backfilled > 0 {
        println!(
            "[JustToDo] 迁移026 完成: 创建 {} 个默认分组, 回填 {} 条任务",
            created, backfilled,
        );
    }
    Ok(())
}
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
    add_column_if_missing(pool, "habits", "icon", "TEXT NOT NULL DEFAULT '🏆'").await?;
    Ok(())
}

/// 迁移 018：任务附件字段
/// - attachments: JSON 数组 [{id, original_name, stored_name, mime, size, created_at}]
///   文件实体存附件目录（由 save_attachment 落盘），这里只存元信息。
///   设计与 checklist（009）完全对称：JSON 数组 + 整组覆盖更新。
async fn run_migration_018(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "attachments", "TEXT NOT NULL DEFAULT '[]'").await?;
    Ok(())
}

/// 根据文件名扩展名判定磁盘分类（与前端 categorizeAttachmentType 逻辑一致）
/// 复制一份在迁移里用，避免 migration 依赖 commands 模块
fn m19_categorize(file_name: &str) -> &'static str {
    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
    if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico"
    ) {
        return "images";
    }
    if matches!(ext.as_str(), "mp4" | "mov" | "webm" | "ogv" | "mkv") {
        return "videos";
    }
    if matches!(ext.as_str(), "mp3" | "wav" | "m4a" | "ogg" | "flac" | "aac") {
        return "audios";
    }
    if matches!(
        ext.as_str(),
        "md" | "markdown" | "txt" | "log" | "json" | "yml" | "yaml" | "csv" | "tsv" | "pdf"
    ) {
        return "docs";
    }
    if matches!(
        ext.as_str(),
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz"
    ) {
        return "archives";
    }
    "others"
}

/// 读附件目录（复用 commands::get_attachment_path 的逻辑：读 attachment_path.txt，否则默认）
fn m19_read_attachment_dir(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    let config_path = app_data_dir.join("attachment_path.txt");
    if let Ok(path) = std::fs::read_to_string(&config_path) {
        let p = std::path::PathBuf::from(&path);
        if p.exists() {
            return p;
        }
    }
    // 默认：app_data_dir/attachments
    let default = app_data_dir.join("attachments");
    let _ = std::fs::create_dir_all(&default);
    default
}

/// 迁移 019：附件磁盘文件按"日期/类型"分目录（存量迁移）
///
/// 把旧的平铺附件（attachments/<uuid>.<ext>）按其 created_at 移到新结构：
///   attachments/<YYYYMMDD>/<category>/<uuid>.<ext>
///
/// - 幂等：stored_name 已含 `/` 的跳过（已是新结构）
/// - 安全：逐条处理，rename 成功后才更新 DB；单条失败跳过并记日志，不阻断整体
/// - 写回：每个任务的 attachments 数组若有变更，整体 UPDATE 一次
/// - created_at 格式："YYYY-MM-DDTHH:mm:ss"，取前 10 位去掉 `-` 得 YYYYMMDD
async fn run_migration_019(
    pool: &SqlitePool,
    app_data_dir: &std::path::Path,
) -> Result<(), String> {
    // 该 migration 既读 attachment_path.txt，也可能因 attachments 列不存在（旧版）而失败。
    // 如果 attachments 列不存在（018 没跑），直接跳过 —— 说明是全新或过旧的库，无附件可迁移。
    let has_attachments_col = column_exists(pool, "tasks", "attachments").await?;
    if !has_attachments_col {
        return Ok(());
    }

    let attach_dir = m19_read_attachment_dir(app_data_dir);

    // 读所有任务的 (id, attachments_json)
    let rows = sqlx::query("SELECT id, attachments FROM tasks")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("迁移019: 查询任务失败: {}", e))?;

    let mut migrated_count: u32 = 0;
    let mut skipped_count: u32 = 0;
    let mut failed_count: u32 = 0;

    for row in &rows {
        let task_id: String = row.get("id");
        let raw: String = row.get("attachments");

        // 解析为 serde_json::Value 数组（不强制类型，宽松处理历史脏数据）
        let mut arr: Vec<serde_json::Value> = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                // JSON 解析失败：跳过该任务，不动其数据
                skipped_count += 1;
                continue;
            }
        };

        let mut changed = false;
        for item in arr.iter_mut() {
            let obj = match item.as_object_mut() {
                Some(o) => o,
                None => continue,
            };

            // 取 stored_name 和 created_at、original_name（camelCase，由 serde rename_all 决定）
            let stored_name = match obj.get("storedName").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };

            // 幂等：已含路径分隔符说明已是新结构
            if stored_name.contains('/') || stored_name.contains('\\') {
                continue;
            }

            let original_name = obj
                .get("originalName")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let created_at = obj.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");

            // 推导日期目录：created_at 前 10 位 "YYYY-MM-DD" → "YYYYMMDD"
            // 格式不符则用当前日期兜底（尽量不丢文件）
            let date_dir: String = if created_at.len() >= 10 {
                created_at[..10].chars().filter(|c| *c != '-').collect()
            } else {
                chrono::Local::now().format("%Y%m%d").to_string()
            };
            let category = m19_categorize(original_name);

            // 拼新旧路径
            let old_path = attach_dir.join(&stored_name);
            let new_rel = format!("{}/{}/{}", date_dir, category, stored_name);
            let new_path = attach_dir.join(&new_rel);

            // 源文件不存在：可能已被手动移走或本就是测试数据，跳过（保留 DB 原值）
            if !old_path.exists() {
                skipped_count += 1;
                continue;
            }

            // 创建目标父目录
            if let Some(parent) = new_path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    eprintln!(
                        "[迁移019] 创建目录失败 {} (task={}): {}",
                        parent.display(),
                        task_id,
                        e
                    );
                    failed_count += 1;
                    continue;
                }
            }

            // 移动文件
            match std::fs::rename(&old_path, &new_path) {
                Ok(_) => {
                    obj.insert("storedName".to_string(), serde_json::Value::String(new_rel));
                    changed = true;
                    migrated_count += 1;
                }
                Err(e) => {
                    eprintln!(
                        "[迁移019] 移动文件失败 {} -> {} (task={}): {}",
                        old_path.display(),
                        new_path.display(),
                        task_id,
                        e
                    );
                    failed_count += 1;
                }
            }
        }

        // 该任务的 attachments 有变更，整体写回
        if changed {
            let new_json = serde_json::to_string(&arr)
                .map_err(|e| format!("迁移019: 序列化失败 (task={}): {}", task_id, e))?;
            sqlx::query("UPDATE tasks SET attachments = $1 WHERE id = $2")
                .bind(&new_json)
                .bind(&task_id)
                .execute(pool)
                .await
                .map_err(|e| format!("迁移019: 更新失败 (task={}): {}", task_id, e))?;
        }
    }

    println!(
        "[JustToDo] 迁移019 完成: 迁移 {} 个, 跳过 {}, 失败 {}",
        migrated_count, skipped_count, failed_count
    );
    Ok(())
}
