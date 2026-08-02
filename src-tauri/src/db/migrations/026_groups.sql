-- 分组表：每个清单可以有自己的分组（类比 Trello 的列）
-- id: 分组唯一标识
-- list_id: 所属清单（外键，清单删除时级联删除分组）
-- name: 分组名称
-- sort_order: 排序权重
-- created_at: 创建时间
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
