-- 习惯打卡功能（里程碑二）
-- habits 表存储习惯定义，habit_logs 表存储每日打卡记录

CREATE TABLE IF NOT EXISTS habits (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#059669',
  repeat_rule  TEXT NOT NULL DEFAULT 'daily',  -- daily / weekly / custom
  target_count INTEGER NOT NULL DEFAULT 1,
  remind_at    TEXT,                            -- HH:MM 格式或 NULL
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id          TEXT PRIMARY KEY,
  habit_id    TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  log_date    TEXT NOT NULL,   -- YYYY-MM-DD
  count       INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE(habit_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON habit_logs(habit_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON habit_logs(log_date);
