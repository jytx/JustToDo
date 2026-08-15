-- 033: AI 智能体会话持久化（P3）
-- agent_sessions：会话元信息（标题自动取首条用户消息前 30 字）
-- agent_messages：会话消息（user / assistant / tool 三种角色）
--   - system 消息不落库（每次对话时动态拼接，含当前时间锚点与上下文）
--   - assistant.tool_calls 存 JSON 数组（模型的工具调用请求）
--   - tool.tool_call_id 与 tool_calls[].id 配对，content 为执行结果 JSON
-- 重启应用后可从这两张表还原会话，支持「查看历史会话并继续对话」。

CREATE TABLE IF NOT EXISTS agent_sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  -- 会话内单调递增序号：一轮循环的多条消息同秒写入，created_at（秒精度）
  -- 无法定序，续聊重建上下文必须严格保序（user → assistant → tool → ...）
  seq          INTEGER NOT NULL DEFAULT 0,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  tool_calls   TEXT,
  tool_call_id TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, seq);
