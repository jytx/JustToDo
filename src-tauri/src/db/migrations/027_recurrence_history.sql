-- 027: 重复任务生成历史表
--
-- 问题：重复任务实例被用户删除后，下次扫描去重检查（查现存实例）失效，
-- 系统又重新生成同日期的实例，「删了又冒出来」。
--
-- 方案：独立记录「已生成过的 (模板id, 日期)」，即使实例被删除记录仍保留，
-- 去重改查本表而非 tasks 现存实例。
--
-- instance_id 冗余字段仅用于追溯，不参与去重逻辑（实例删除后保留记录）。

CREATE TABLE IF NOT EXISTS recurrence_generated (
    template_id  TEXT NOT NULL,   -- 模板任务 id（tasks.id，有 recurrence_freq 的）
    due_date     TEXT NOT NULL,   -- 已生成的截止日期（实例的 due_end_at）
    instance_id  TEXT,            -- 生成的实例 id（实例删除后记录仍保留）
    generated_at TEXT NOT NULL,   -- 生成时间
    PRIMARY KEY (template_id, due_date)
);

CREATE INDEX IF NOT EXISTS idx_recurrence_generated_template
    ON recurrence_generated(template_id);

-- 存量回填：把现存的重复实例（recurrence_origin_id 关联）记录到历史表
-- 已删除的实例虽不在 tasks，但现存的会被记录；未来删除不再重生。
-- INSERT OR IGNORE 保证幂等（重复执行不报错）。
INSERT OR IGNORE INTO recurrence_generated (template_id, due_date, instance_id, generated_at)
SELECT recurrence_origin_id, due_end_at, id, created_at
FROM tasks
WHERE recurrence_origin_id IS NOT NULL
  AND due_end_at IS NOT NULL;
