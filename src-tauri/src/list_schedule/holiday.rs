// 清单生成计划 —— 法定节假日获取/缓存/工作日判断
// 设计依据：discuss/2026-07-30-list-schedule-design.md 第六节
//
// 数据源：NateScarlet/holiday-cn（每年一份 JSON，含放假与调休补班）。
// 启动时检查当年+明年缓存，缺失则拉取；断网降级为纯周末判断 + 通知。

use chrono::{Datelike, NaiveDate, Weekday};
use sqlx::{Row, SqlitePool};

use super::models::{Holiday, HolidayCnYear};

/// holiday-cn CDN 基址（按年份拼 JSON 路径）
const HOLIDAY_CN_BASE: &str = "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master";

/// 拉取并缓存指定年份的节假日数据
///
/// 成功返回写入条数；失败返回 Err（由调用方降级处理）。
/// 写入用 INSERT OR REPLACE，重复拉取同一年的数据会安全覆盖。
pub async fn fetch_and_cache_year(pool: &SqlitePool, year: i32) -> Result<usize, String> {
    let url = format!("{}/{}.json", HOLIDAY_CN_BASE, year);
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("请求节假日数据失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("节假日接口返回 {}", resp.status()));
    }
    let data: HolidayCnYear = resp
        .json()
        .await
        .map_err(|e| format!("解析节假日数据失败: {}", e))?;

    for d in &data.days {
        let off_flag: i64 = if d.is_off_day { 1 } else { 0 };
        sqlx::query(
            "INSERT OR REPLACE INTO holidays (date, year, is_off_day, name) VALUES ($1, $2, $3, $4)",
        )
        .bind(&d.date)
        .bind(year)
        .bind(off_flag)
        .bind(&d.name)
        .execute(pool)
        .await
        .map_err(|e| format!("写入节假日缓存失败: {}", e))?;
    }

    Ok(data.days.len())
}

/// 检查并补齐当年 + 明年的节假日缓存
///
/// 跨年兜底：明确覆盖"当年 + 下一年"，保证元旦附近判断不缺数据。
/// 缺失则拉取；任一年失败返回错误列表，由调用方决定是否通知降级。
pub async fn ensure_holiday_cache(pool: &SqlitePool) -> Result<(), Vec<String>> {
    let this_year = chrono::Local::now().year();
    let years = [this_year, this_year + 1];
    let mut errors: Vec<String> = Vec::new();

    for y in years {
        // 查当年是否已有缓存
        let count: i64 = match sqlx::query("SELECT COUNT(*) AS c FROM holidays WHERE year = ?")
            .bind(y)
            .fetch_optional(pool)
            .await
        {
            Ok(Some(r)) => r.get::<i64, _>("c"),
            Ok(None) => 0,
            Err(e) => {
                // 查询失败按"无缓存"处理，尝试拉取
                eprintln!("[JustToDo] 查询 {} 年节假日缓存失败: {}", y, e);
                0
            }
        };

        // 无缓存才拉取
        if count == 0 {
            if let Err(e) = fetch_and_cache_year(pool, y).await {
                errors.push(format!("{} 年: {}", y, e));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// 查询某天的节假日记录（无记录返回 None）
async fn get_holiday_record(pool: &SqlitePool, date: NaiveDate) -> Option<Holiday> {
    let iso = format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day());
    let row: Option<(String, i32, i64, Option<String>)> =
        sqlx::query_as("SELECT date, year, is_off_day, name FROM holidays WHERE date = ?")
            .bind(&iso)
            .fetch_optional(pool)
            .await
            .ok()?;

    row.map(|(d, y, off, name)| Holiday {
        date: d,
        year: y,
        is_off_day: off != 0,
        name,
    })
}

/// 判断某天是否为法定工作日（A 语义：完整法定工作日）
///
/// - 有记录且 is_off_day=true（放假）→ 非工作日
/// - 有记录且 is_off_day=false（调休补班）→ 工作日
/// - 无记录 → 降级为纯周末判断（周一~周五为工作日）
pub async fn is_workday(pool: &SqlitePool, date: NaiveDate) -> bool {
    match get_holiday_record(pool, date).await {
        Some(h) => !h.is_off_day,
        None => {
            let wd = date.weekday();
            wd != Weekday::Sat && wd != Weekday::Sun
        }
    }
}
