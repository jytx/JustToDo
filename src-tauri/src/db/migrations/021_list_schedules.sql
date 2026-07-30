-- 021: 清单生成计划 + 节假日缓存
-- 设计依据：discuss/2026-07-30-list-schedule-design.md
--
-- list_schedules：用户配置的"自动建清单"规则。
--   每条规则 = 路径模板 + 频率 + 颜色。tick 命中频率时渲染路径并逐级建清单。
--   freq 取值：daily / weekly / monthly / yearly / workday（工作日跳过法定节假日）。
--
-- holidays：法定节假日缓存（按年批量，数据源 NateScarlet/holiday-cn）。
--   is_off_day=1 放假（该日不生成）；is_off_day=0 调休补班（该日生成）。
--   启动时检查当年+明年缓存，缺失则拉取；断网降级为纯周末判断。

CREATE TABLE IF NOT EXISTS list_schedules (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,                 -- 计划名称，如"每日工作清单"
    path_template TEXT NOT NULL,                 -- 路径模板，如 工作/日志/{{YYYY}}/{{MM}}/{{YYYY-MM-DD}}
    freq          TEXT NOT NULL,                 -- daily/weekly/monthly/yearly/workday
    color         TEXT NOT NULL,                 -- 生成清单的颜色
    enabled       INTEGER NOT NULL DEFAULT 1,    -- 0=停用 1=启用
    position      INTEGER NOT NULL DEFAULT 0,    -- 显示排序
    created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_list_schedules_position ON list_schedules(position);

CREATE TABLE IF NOT EXISTS holidays (
    date       TEXT PRIMARY KEY,                 -- YYYY-MM-DD
    year       INTEGER NOT NULL,
    is_off_day INTEGER NOT NULL,                 -- 1=放假 0=调休补班
    name       TEXT                               -- 节假日名称，如"元旦"
);

CREATE INDEX IF NOT EXISTS idx_holidays_year ON holidays(year);
