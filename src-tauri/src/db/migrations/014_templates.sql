-- 014: 任务模板表
-- 模板是"任务参数预设"，独立于 tasks 表。"应用模板"时由前端走
-- taskStore.createTask + db.updateTask(note) 两步落库。
-- 内置模板用固定 id（tpl-meeting 等），INSERT OR IGNORE 保证幂等：
-- 重复执行 migration 不报错、不覆盖用户改动。

CREATE TABLE IF NOT EXISTS templates (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    is_builtin   INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_position ON templates(position);

-- 内置模板 4 个（固定 id，position 从 1 开始递增便于将来插队）
-- note 用单引号包裹的 HTML；内部双引号用 &quot; 转义避免 SQL 字符串提前结束
INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-meeting',
 '会议纪要',
 '{{date_cn}} 会议纪要',
 '<p><strong>会议：</strong>______</p><p><strong>时间：</strong>______</p><p><strong>参会：</strong>______</p><p><strong>议题：</strong></p><ul><li>议题一</li><li>议题二</li></ul><p><strong>结论 &amp; Action：</strong></p><ul><li>决定 1 —— 负责人 / 截止</li></ul>',
 1,
 1,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');

INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-weekly',
 '周报',
 '{{date_cn}} 周报',
 '<p><strong>本周完成：</strong></p><ul><li></li></ul><p><strong>下周计划：</strong></p><ul><li></li></ul><p><strong>阻塞 / 风险：</strong></p><ul><li></li></ul>',
 1,
 2,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');

INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-codereview',
 '代码审查',
 '代码审查：_____',
 '<p><strong>PR：</strong>______</p><p><strong>优点：</strong></p><ul><li></li></ul><p><strong>问题：</strong></p><ul><li></li></ul><p><strong>建议：</strong></p><ul><li></li></ul>',
 1,
 3,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');

INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-reading',
 '读书笔记',
 '《_____》读书笔记',
 '<p><strong>书名：</strong>______</p><p><strong>作者：</strong>______</p><p><strong>核心观点：</strong></p><ul><li></li></ul><p><strong>摘录：</strong></p><blockquote></blockquote><p><strong>启发 / 行动：</strong></p><ul><li></li></ul>',
 1,
 4,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');
