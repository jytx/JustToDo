// 清单生成计划 —— 路径模板渲染 + 逐级创建
// 设计依据：discuss/2026-07-30-list-schedule-design.md 第四节
//
// 本文件以纯函数为主（渲染、频率命中判断），仅 ensure_scheduled_path 涉及 DB 写入。

use chrono::{Datelike, NaiveDate, Weekday};
use sqlx::SqlitePool;

use super::models::ListSchedule;
use crate::commands::{now, uuid};

/// 渲染路径模板占位符为具体路径
///
/// 按占位符长度降序替换，避免短占位符误伤长占位符
/// （如先替换 {{YYYY}} 会吃掉 {{YYYY-MM-DD}} 里的 {{YYYY}}）。
/// 入参只读，仅返回新字符串，便于单测。
pub fn render_path_template(template: &str, date: NaiveDate) -> String {
    let year4 = format!("{:04}", date.year());
    let year2 = format!("{:02}", date.year() % 100);
    let month2 = format!("{:02}", date.month());
    let month1 = format!("{}", date.month());
    let day2 = format!("{:02}", date.day());
    let day1 = format!("{}", date.day());
    let ymd = format!("{}-{}-{}", year4, month2, day2);
    let ym = format!("{}-{}", year4, month2);

    // 长度降序：长占位符先替换
    template
        .replace("{{YYYY-MM-DD}}", &ymd)
        .replace("{{YYYY-MM}}", &ym)
        .replace("{{YYYY}}", &year4)
        .replace("{{YY}}", &year2)
        .replace("{{MM}}", &month2)
        .replace("{{M}}", &month1)
        .replace("{{DD}}", &day2)
        .replace("{{D}}", &day1)
}

/// 判断给定日期是否命中某频率（不含 workday）
///
/// workday 需结合节假日数据判断，由调用方走 holiday::is_workday，故此处返回 false。
pub fn is_freq_hit(freq: &str, date: NaiveDate) -> bool {
    match freq {
        "daily" => true,
        // 每周一命中
        "weekly" => date.weekday() == Weekday::Mon,
        // 每月 1 号命中
        "monthly" => date.day() == 1,
        // 每年 1 月 1 日命中
        "yearly" => date.month() == 1 && date.day() == 1,
        _ => false,
    }
}

/// 根据 leaf_type 判断路径最后一段是否为目录
///
/// leaf_type 由用户显式指定（folder=目录 / list=清单），与频率解耦。
/// 兼容旧值：未识别的值一律按清单处理。
pub fn leaf_is_folder(leaf_type: &str) -> bool {
    leaf_type == "folder"
}

/// 确保路径存在，逐级创建目录/清单，返回最末段 id
///
/// 逐级 SELECT by (parent_id, name)：找到则复用、没找到才建。
/// 因此天然幂等——同一路径只会存在一份，tick 每分钟跑也不会重复建。
/// 返回 (最末段 id, 最末段是否为本次新建)
/// is_new=true 表示目标项是这次新建的；false 表示已存在（幂等复用）。
pub async fn ensure_scheduled_path(
    pool: &SqlitePool,
    path: &str,
    leaf_is_folder: bool,
    color: &str,
) -> Result<(String, bool), String> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err("路径模板渲染后为空".to_string());
    }

    let mut parent_id: Option<String> = None;
    let mut leaf_is_new = false;
    let total = segments.len();

    for (i, seg) in segments.iter().enumerate() {
        let is_leaf = i == total - 1;
        let is_folder = if is_leaf { leaf_is_folder } else { true };

        // 查找同名同父级的已有项（同时取 is_folder 检查类型是否冲突）
        let existing: Option<(String, i64)> = sqlx::query_as(
            "SELECT id, is_folder FROM lists WHERE parent_id IS ? AND name = ? LIMIT 1",
        )
        .bind(&parent_id)
        .bind(seg)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询清单失败: {}", e))?;

        match existing {
            // 已存在：复用，但校验类型是否匹配（防止两条计划路径重叠时类型错乱）
            Some((id, existing_is_folder)) => {
                // 已存在项的实际类型与期望类型不同 → 报错（防止路径冲突导致类型错乱）
                if (existing_is_folder != 0) != is_folder {
                    return Err(format!(
                        "路径段「{}」已存在但类型不匹配（期望{}，实际为{}），请检查计划配置避免路径冲突",
                        seg,
                        if is_folder { "目录" } else { "清单" },
                        if existing_is_folder != 0 { "目录" } else { "清单" }
                    ));
                }
                parent_id = Some(id);
            }
            // 不存在则创建（复用 list_create 的建表 SQL）
            None => {
                let id = uuid();
                let ts = now();
                let position = chrono::Utc::now().timestamp_millis();
                let folder_flag: i64 = if is_folder { 1 } else { 0 };
                sqlx::query(
                    "INSERT INTO lists (id, name, color, position, created_at, parent_id, is_folder) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(&id)
                .bind(seg)
                .bind(color)
                .bind(position)
                .bind(&ts)
                .bind(&parent_id)
                .bind(folder_flag)
                .execute(pool)
                .await
                .map_err(|e| format!("创建清单失败: {}", e))?;
                // 生成的清单（非目录）补建默认分组 {id}-default，
                // 否则新建任务的 group_id 指向不存在的分组，在分组视图凭空消失
                // （与 list_create 的行为保持一致）
                if !is_folder {
                    let default_group_id = format!("{}-default", id);
                    sqlx::query(
                        "INSERT OR IGNORE INTO groups (id, list_id, name, sort_order, created_at) \
                         VALUES ($1, $2, $3, $4, $5)",
                    )
                    .bind(&default_group_id)
                    .bind(&id)
                    .bind("默认分组")
                    .bind(0)
                    .bind(&ts)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("创建默认分组失败: {}", e))?;
                }
                // 最末段是本次新建的
                if is_leaf {
                    leaf_is_new = true;
                }
                parent_id = Some(id);
            }
        }
    }

    Ok((parent_id.unwrap(), leaf_is_new))
}

/// 执行单条计划：渲染路径 + 逐级创建
/// 返回最末段是否为本次新建（true=新建，false=已存在）
pub async fn run_schedule(
    pool: &SqlitePool,
    schedule: &ListSchedule,
    date: NaiveDate,
) -> Result<bool, String> {
    let path = render_path_template(&schedule.path_template, date);
    let leaf_folder = leaf_is_folder(&schedule.leaf_type);
    let (_, is_new) = ensure_scheduled_path(pool, &path, leaf_folder, &schedule.color).await?;
    Ok(is_new)
}
