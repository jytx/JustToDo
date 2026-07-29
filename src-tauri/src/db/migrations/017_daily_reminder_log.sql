-- 017: 每日固定时点提醒日志
-- 与 task_check_reminders_inner 各自独立。task_check_reminders 走 tasks.notified_at
-- 防重复；本表只记录"每日汇总通知"发送过的 (date, time) 组合，避免同一天同一时刻重复发。
--
-- 应用场景：用户设置 09:00、17:00 两个时刻，每天到点扫描未完成根任务并发一条汇总通知。
-- 启动补发：若应用关闭时漏过一个时刻（关闭期间 hh:mm ≤ now），启动后第一轮扫描会
-- 通过 log 表判定未发并补发，再写入 log 防再次重复。
--
-- 字段说明：
--   log_date: YYYY-MM-DD（本地日期）
--   log_time: HH:mm（配置时刻，与 daily_reminder_times 中的项严格匹配）
--   sent_at:  实际发送的本地时间字面量（YYYY-MM-DDTHH:mm:ss），便于排查/审计

CREATE TABLE IF NOT EXISTS daily_reminder_log (
    log_date TEXT NOT NULL,
    log_time TEXT NOT NULL,
    sent_at  TEXT NOT NULL,
    PRIMARY KEY (log_date, log_time)
);

-- 启动补发 / 清理时按日期范围查 log
CREATE INDEX IF NOT EXISTS idx_daily_reminder_log_date ON daily_reminder_log(log_date);