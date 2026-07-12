-- JustToDo 初始 schema（里程碑一）
-- 核心表：lists（清单）、tasks（任务，含子任务 parent_id）
-- 预建表：tags / task_tags（里程碑二接入 UI）

-- lists（清单）—— 任务的基础容器
CREATE TABLE IF NOT EXISTS lists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6B7280',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- tasks（任务）—— 支持子任务嵌套（parent_id 自引用）
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  list_id       TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 0,   -- 0无 1低 2中 3高
  due_at        TEXT,                          -- ISO 8601 时间或 NULL
  done          INTEGER NOT NULL DEFAULT 0,    -- 0 未完成 / 1 已完成
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);

-- tags（标签）—— 跨清单横向分类
CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- task_tags（任务-标签多对多关联）
CREATE TABLE IF NOT EXISTS task_tags (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

-- 索引（加速常用查询）
CREATE INDEX IF NOT EXISTS idx_tasks_list   ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_done   ON tasks(done);

-- 初始数据：默认「收件箱」清单（用户首个任务的落脚点）
INSERT OR IGNORE INTO lists (id, name, color, position, created_at)
VALUES ('inbox', '收件箱', '#6B7280', 0, '2026-07-10T00:00:00Z');
