# AI 智能体（Agent）功能设计规划

> 状态：待评审
> 日期：2026-08-15
> 前置文档：`discuss/2026-07-31-ai-config-design.md`（Provider 抽象层）、`discuss/2026-07-31-ai-summary-scope-design.md`（范围总结）

## 一、背景与目标

当前 AI 功能（总结/建任务/拆解/提取/润色）都是**单轮硬编码流程**：前端选工具 →
Rust 拼一份固定 prompt → 一次调用 → 返回结果。能力边界被 6 个命令写死，
模型无法自主决定「先查什么、再做几步、何时结束」。

本次增强目标：让 AI 像**智能体（Agent）**一样工作——

1. **多轮工具循环**：模型可连续调用应用内工具（查任务 → 分析 → 建任务 → 再查），
   自主决定执行路径，直到给出最终答复。
2. **对话式交互**：支持多轮对话（上下文延续），而非一问一答的孤立弹窗。
3. **能真正干活**：不只生成文本草稿，而是直接对应用数据做增改（带安全阀）。

## 二、现状盘点

### 已具备（可直接复用）

| 能力 | 位置 | 说明 |
| ---- | ---- | ---- |
| 协议无关 chat 类型 | `src-tauri/src/ai/types.rs` | `ChatMessage` 已含 `assistant.tool_calls` 与 `tool` 角色，`ToolDef/ToolCall/ToolChoice` 齐全，**无需改动** |
| 双协议 adapter | `src-tauri/src/ai/provider.rs` | OpenAI 兼容 + Anthropic，`chat()`（拿 tool_calls）与 `chat_stream()`（文本流式）都有 |
| 配置与构造 | `src-tauri/src/ai/mod.rs` | `build_from_settings()` 统一校验+构造 |
| 流式推送管道 | `commands.rs` 的 `StreamChunk` + Tauri `Channel` | 前端 `api/ai.ts` 已有 `createStreamChannel` |
| function calling 范例 | `ai_parse_task` 等 | ToolDef 手写 JSON Schema 的写法可照搬 |
| 提示词可配置机制 | `app_settings` + `load_prompt()` | agent 系统提示词同样暴露到设置页 |
| Rust → 前端事件 | 提示音功能的 emit 先例 | 写库后通知前端刷新 store 可复用此模式 |

### 缺失（本次要建）

- **Agent Loop 引擎**：执行工具 → 结果作为 tool 消息回传 → 再调模型，循环至终态。
- **应用内工具集**：把「查任务/建任务/改任务/查清单…」注册为模型可调用的工具。
- **对话 UI**：消息列表 + 工具调用过程可视化 + 流式渲染 + 多轮输入。
- **会话管理**：历史消息拼装（Phase 1 内存态，Phase 3 持久化）。
- **数据同步**：Rust 端写库后，前端 Pinia store 需要刷新（store 是前端唯一数据源）。

## 三、总体架构

```
┌─────────────────────── 前端 (Vue) ───────────────────────┐
│  AiChatModal（对话 UI）                                    │
│   ├─ 消息列表（用户/AI/工具步骤卡片）                        │
│   ├─ 输入框 + 快捷指令（沿用原 6 工具入口）                   │
│   └─ api/agent.ts —— invoke("ai_agent_chat", { sessionId,  │
│         message, context, onEvent: Channel<AgentEvent> })  │
└──────────────┬────────────────────────────────────────────┘
               │ invoke + Channel 事件流
┌──────────────▼───────────── Rust ─────────────────────────┐
│  ai_agent_chat 命令（新模块，见 §7 拆分建议）                │
│   └─ agent.rs :: run_agent_loop()                          │
│       1. messages = [system(提示词+时间+上下文)] + 会话历史   │
│       2. loop（≤ MAX_ROUNDS 轮）:                           │
│          provider.chat_stream(req) ──delta──► Channel      │
│          ├─ 无 tool_calls → 保存历史，结束                   │
│          └─ 有 tool_calls → 逐个执行：                       │
│              tools.rs 查注册表 → tool_exec.rs 执行(读写 DB)  │
│              ──tool_start/tool_end──► Channel               │
│              结果作为 tool 消息 append，continue             │
│   └─ 写操作后 emit "ai:data-changed" ──► 前端刷新 store      │
└────────────────────────────────────────────────────────────┘
```

设计原则：

- **循环在 Rust 端跑**。若每轮工具执行回前端做，一次 IPC 往返 + Pinia 写入，
  轮次多时延迟与复杂度都不可接受。Rust 直连 DB 是既有架构（sqlx）。
- **读工具直接查库，写工具直接写库**，与前端 store 的同步靠事件（§4.5）。
- **工具入参用「名称」不用 ID**。模型不应感知内部 ID；执行器负责名称 → ID
  解析，解析失败把错误回传给模型自纠（如让模型先调 `query_tasks` 确认）。

## 四、核心设计

### 4.1 Agent Loop 引擎（`ai/agent.rs`）

```rust
/// 单次 agent 会话执行结果
pub struct AgentOutcome {
    pub rounds: u32,             // 实际循环轮数
    pub usage_total: TokenUsage, // 累计 token（多轮求和）
}

/// 执行一轮工具循环。
/// on_event：向前端 Channel 推 AgentEvent；on_delta：文本流式回调。
pub async fn run_agent_loop(
    pool: &SqlitePool,
    provider: &dyn AiProvider,
    system_prompt: String,
    history: Vec<ChatMessage>,   // 本轮之前的历史
    user_input: String,
    on_event: impl Fn(AgentEvent),
) -> Result<AgentOutcome, AiError>
```

循环要点：

- 每轮先 `chat_stream`：文本 delta 实时推前端；`tool_calls` 从汇总响应取。
  （OpenAI/Anthropic 均支持流式响应带 tool_calls，现有 adapter 已解析。）
- 工具结果统一 `ChatMessage::tool { tool_call_id, content }` 回传，content 为
  JSON 字符串（`{ ok: true, ...data }` 或 `{ ok: false, error }`）。
- **工具执行失败不中断会话**：错误作为 tool 结果回传，模型可自行重试/换路径。
- 轮数达上限（`MAX_ROUNDS = 12`）时追加一条 system 提示「请基于已有信息直接作答」，
  并将 `tool_choice` 置 None 强制收尾。

### 4.2 应用内工具集（`ai/tools.rs` + `ai/tool_exec.rs`）

注册表形态（避免 match 长链散落）：

```rust
/// 工具注册项：schema 定义 + 执行器分离，tools.rs 只管定义，exec 只管执行
pub struct ToolSpec {
    pub def: ToolDef,                                   // 给模型的 schema
    pub exec: fn(&SqlitePool, Value) -> BoxFuture<Value>, // 执行器（返回给模型的 JSON）
}
```

**第一版工具清单（9 个，够用即止 —— YAGNI）：**

只读（零风险）：

| 工具 | 参数要点 | 说明 |
| ---- | ---- | ---- |
| `query_tasks` | `list_name?` `status?`(undone/done/all) `due?`(today/tomorrow/this_week/overdue/no_date) `priority?` `tag_name?` `kind?`(task/note) `limit?`(默认 50) | 结构化查询，返回字段精简的任务列表（id/title/due/priority/tags/list） |
| `search_items` | `query` `kind?` | 关键词全文搜（复用全局搜索的 SQL 条件） |
| `get_task` | `task_id` 或 `title` | 单条详情：子任务树、标签、备注正文（HTML 转纯文本摘要） |
| `list_folders` | `kind?` | 清单/笔记本树（含目录层级、各清单计数） |
| `get_stats` | `range`(today/this_week/last_7_days) | 完成量统计（复用 ai_summary 取数逻辑） |

写（有安全阀，见 §4.6）：

| 工具 | 参数要点 | 说明 |
| ---- | ---- | ---- |
| `create_task` | `title` `list_name?`(默认收件箱) `due?` `priority?` `tag_names?` `note_html?` `parent_task_id?` | 建任务/子任务 |
| `create_note` | `title` `notebook_name?`(默认默认笔记本) `content_html?` `tag_names?` | 建笔记 |
| `update_task` | `task_id` + 可选 patch（`title?` `due?` `priority?` `note_html?` `list_name?` `tag_names?`） | 改任务字段 |
| `set_task_done` | `task_id` `done`(bool) | 完成/重开 |

明确**不提供**：删除类工具、清单/标签 CRUD、批量超过 10 条的写操作。
工具返回值里带人类可读的 `summary` 字段（如「已创建任务『周报』到『工作』」），
前端工具卡片直接展示，不用二次加工。

日期约定：模型可输出枚举（today/tomorrow/next_monday…）或 `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`；
执行器统一解析为本地时区 `due_start_at/due_end_at`。system 提示词注入当前时间锚点
（沿用 `ai_parse_task` 的做法）。

### 4.3 前端事件协议（`AgentEvent`）

现有 `StreamChunk { delta, done }` 不够表达工具过程，agent 用独立事件类型
（同一 Channel 串行推送）：

```ts
/** agent 会话事件（Rust Channel → 前端） */
type AgentEvent =
  | { type: "delta"; text: string }                                  // AI 文本增量
  | { type: "tool_start"; callId: string; name: string; args: unknown } // 工具开始
  | { type: "tool_end"; callId: string; ok: boolean; summary: string }  // 工具结束
  | { type: "done"; rounds: number; promptTokens: number; completionTokens: number }
  | { type: "error"; message: string };
```

### 4.4 会话与上下文管理

- **Phase 1（内存态）**：`HashMap<sessionId, Vec<ChatMessage>>` 存 Rust 侧
  （`Mutex` 保护），弹窗关闭即弃。多轮 = 前端带同一 sessionId 继续发。
- **Phase 3（持久化）**：新表 `agent_sessions` / `agent_messages`
  （role/content/tool_calls_json/tool_call_id），重启可续聊。
- **上下文注入**：`ai_agent_chat` 带可选 `context`：
  `{ currentListId?, selectedTaskIds?, view? }`，Rust 解析出清单名等
  拼进 system（「用户当前在『工作』清单」），让「总结一下这个清单」类指令可直达。
- **历史裁剪**：历史超过 N 条（如 40 条消息）时，保留最近 N 条 + 首条 system，
  防止 token 无限膨胀。

### 4.5 数据同步（Rust 写库 → 前端刷新）

Pinia store 是前端唯一数据源，agent 在 Rust 直接写库会造成 UI 不同步。方案：

- 写工具执行成功后（每轮结束统一发一次即可，避免高频），Rust `app.emit("ai:data-changed")`。
- 前端在 `App.vue`（或 `main.ts`）监听，调用现有 store 的刷新动作
  （`taskStore.refresh()` / `listStore.refreshCounts()` 等，具体复用清单在实施时核对）。
- 与提示音功能的 emit 模式一致，无新机制。

### 4.6 安全阀与用户数据保护

1. **无删除工具**——模型物理上删不了数据（第一版铁律）。
2. **写操作分级**（设置页可配，默认「直接执行」）：
   - `直接执行`：工具立即写库，前端展示每步操作卡片（可追溯）。
   - `需确认`：写工具挂起，前端弹确认卡（列出将执行的操作），用户点确认后
     Rust 继续。实现方式：工具执行前推 `tool_start` 事件 + Channel 回执
     （Phase 2 再做，Phase 1 先只提供直接执行模式）。
3. **轮数上限** 12 轮；**单轮工具调用数上限** 5 个。
4. **Token 可见**：`done` 事件带累计 usage，UI 角标展示。
5. 真实数据保护约定不变：测试验证只使用「日常」清单。

### 4.7 UI 形态

- **Phase 1 改造 `AiAssistantModal` 为对话式**：上半区消息流（复用现有
  Markdown 流式渲染 + 节流逻辑），下半区输入框；原 6 个工具保留为
  **快捷指令**（点选即等价于发送预设消息，如「生成今日小结」），不丢弃既有体验。
- 工具调用渲染为**折叠步骤卡**：`🔧 查询任务… → 完成`，展开可见参数与结果摘要，
  结尾带 ✓/✗ 状态。
- **Phase 3（可选演进）**：迁为右侧面板（与任务详情面板同级互斥），
  支持边聊边看列表变化。是否做看 Phase 1 使用反馈。

### 4.8 模块落点与文件预算

遵守行数硬指标（Rust ≤400 行/文件，每目录 ≤8 文件）：

```
src-tauri/src/ai/
├── mod.rs        # 现有（配置构造）
├── types.rs      # 现有（chat 类型）+ AgentEvent 定义
├── provider.rs   # 现有
├── agent.rs      # 新增：循环引擎（预估 ~200 行）
├── tools.rs      # 新增：工具 schema 注册表（预估 ~300 行）
└── tool_exec.rs  # 新增：工具执行器（查/写 DB，预估 ~350 行）

前端：
src/api/agent.ts                    # 新增：ai_agent_chat 封装 + AgentEvent 类型
src/components/ai/
├── AiChatModal.vue                 # 对话容器（由 AiAssistantModal 改造）
├── AgentMessageList.vue            # 消息流
└── AgentToolCard.vue               # 工具步骤卡
```

## 五、分阶段实施计划

| 阶段 | 内容 | 交付标准 |
| ---- | ---- | ---- |
| **P0 前置重构**（建议） | AI 相关 7 个命令从 `commands.rs` 拆到 `ai/commands_ai.rs`；`provider.rs`（704 行）拆 `provider/{mod,openai,anthropic}.rs` | `cargo check/clippy` 通过，功能零变化 |
| **P1 只读智能体** | agent.rs 引擎 + 5 个只读工具 + `ai_agent_chat` 命令 + Modal 对话化（消息流/输入框/工具卡片/流式） | 能完成：「我今天有什么任务」「『工作』清单里逾期的高优任务有哪些」「分析下本周完成情况」 |
| **P2 写能力 + 同步** | 4 个写工具 + `ai:data-changed` 事件 + 前端刷新 + 设置页 agent 开关与提示词（`ai_prompt_agent`） | 能完成：「把刚才提到的三件事建成任务放到『工作』」「把 XX 任务改到周五」且列表实时更新 |
| **P3 会话持久化 + 上下文** | agent_sessions/messages 表（migration）+ 历史裁剪 + context 注入（当前清单/选中）+ 快捷指令迁移 | 重启可续聊；「总结一下这个清单」直达当前清单 |
| **P4 远期（不承诺）** | 写操作确认模式、右侧面板形态、定时智能体（每日自动生成小结推送到收件箱）、网页内容抓取工具（复用 `fetch_url_title`） | 视 P1-P3 反馈定 |

## 六、待确认决策点

1. **写操作默认模式**：直接执行（推荐，快、操作卡片可追溯）vs 默认需确认？
2. **UI 形态**：Phase 1 先做 Modal 对话化（推荐，改动小）还是直接上右侧面板？
3. **会话持久化优先级**：P3 是否需要提前（如果多轮上下文是核心场景）？
4. **原有 6 个命令的去留**：推荐全部保留作为快捷入口（内部可逐步改为走
   agent 通道，但不必急）。

## 七、风险与前置重构建议

1. **`commands.rs` 已 4508 行**（硬指标 400），`provider.rs` 704 行 —— 均严重超标。
   agent 功能不应再向 `commands.rs` 加一行。建议 P0 先做上述拆分，
   否则后续维护成本持续恶化（僵化 + 晦涩坏味道）。
2. **流式 + tool_calls 的协议差异**：OpenAI 与 Anthropic 对流式 tool_calls
   的分片拼装不同，实施时需分别验证；若某协议流式拿不稳，降级方案为
   「有工具定义的轮次用非流式 chat()，仅最终轮流式」。
3. **模型能力差异**：小模型多轮工具循环易跑偏（重复调用/不收尾），
   轮数上限 + 强制收尾提示是必要的兜底，文档已计入 P1。
4. **成本**：agent 每轮都带全部历史 + 工具 schema，token 消耗显著高于
   现有单轮功能；usage 展示（P1）与历史裁剪（P3）是对策。
