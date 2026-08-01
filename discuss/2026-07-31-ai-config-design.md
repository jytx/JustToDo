# AI 配置维护区块设计（2026-07-31）

> 用途：评审「设置页新增 AI 配置区块 + Rust AI 抽象层」的方案、数据流、改动范围。
> 确认后再开 `-plan.md` 实现计划。
>
> 这是 AI 能力接入 JustToDo 的**第一步**：先把 Provider 配置维护起来、搭好
> Rust 端的 AI 调用抽象层（含 tools 能力），作为后续所有 AI 功能的基础。
> 本阶段**不做任何 AI 功能**，只维护配置 + 提供底层调用能力。
>
> 关联：`discuss/2026-07-30-future-features-roadmap.md`（P1：AI 助手）

---

## 一、功能目标

1. **设置页新增「AI」区块**：配置 Provider（OpenAI 兼容 / Anthropic）、API 地址、Key、模型
2. **「测试连接」按钮**：验证配置可用性
3. **「启用 AI」总开关**：关掉后后续 AI 入口隐藏
4. **Rust 端 AI 抽象层**：封装 chat 调用，**内置 tools（function calling）能力**，
   为后续「自然语言建任务、拆子任务」等 AI 功能提供统一调用接口

**本阶段边界**：只维护配置 + 搭抽象层，不实现任何 AI 功能。功能开关留到后续。

---

## 二、已确认的决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Provider 协议 | OpenAI 兼容 + Anthropic | 覆盖最广：OpenAI 协议通吃 DeepSeek/通义/Moonshot/本地 Ollama；Anthropic 覆盖 Claude |
| API Key 存储 | 明文存 SQLite | 与现有设置项一致，本地优先应用常见做法 |
| 测试连接 | 要 | 避免 key 配错后到处排查 |
| 总开关 | 要 | 隐私友好，让用户明确掌控 |
| 功能开关 | **暂不加** | 功能还没做，避免空壳开关（YAGNI） |
| SDK 包 | **不引入，自己用 reqwest 写** | OpenAI/Anthropic 协议极简；包绑死 schema 不利于接兼容服务；reqwest 已在依赖里零新增 |
| Tools 能力 | **抽象层内置** | 后续「建任务/拆子任务」都要靠 function calling，抽象层一次设计到位 |

---

## 三、数据模型（复用 app_settings KV 表）

**零建表**。`app_settings(key, value)` 是 KV 表，`set_setting` 用 `ON CONFLICT DO UPDATE` upsert，
新增 `ai_*` key 直接写入即可。

### 新增设置 key

| key | 类型 | 内容 | 默认值 |
|-----|------|------|--------|
| `ai_enabled` | string | `"true"`/`"false"` | `"false"`（默认关） |
| `ai_provider` | string | `"openai"`/`"anthropic"` | `"openai"` |
| `ai_base_url` | string | API 地址 | `""`（空） |
| `ai_api_key` | string | 密钥（明文） | `""`（空） |
| `ai_model` | string | 模型名 | `""`（空） |

> **隐私说明**：API Key 明文存在本地 SQLite，与附件路径等其他设置一致。
> 数据库文件本身在用户本地，不外传。后续若需更高安全性可升级到 keychain。

---

## 四、Rust AI 抽象层（核心，为后续扩展铺路）

**新增模块**：`src-tauri/src/ai/`

### 4.1 为什么需要抽象层

OpenAI 和 Anthropic 的 chat 接口**协议差异显著**（尤其 tools 部分），直接在每个调用点
写两套分支会导致重复且难维护。抽象层把差异收敛在 adapter 里，上层只面对统一的
`ChatRequest` / `ChatResponse` 结构。

### 4.2 OpenAI vs Anthropic 协议差异（tools 部分）

| 维度 | OpenAI | Anthropic |
|------|--------|-----------|
| tools 定义 | `{type:"function", function:{name, description, parameters:{json schema}}}` | `{name, description, input_schema:{json schema}}` |
| 模型返回 | `message.tool_calls: [{id, type:"function", function:{name, arguments(JSON 字符串)}}]` | `content: [{type:"tool_use", id, name, input(对象)}]` |
| 提交结果 | `{role:"tool", tool_call_id, content}` | `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}` |
| 参数格式 | `arguments` 是 **JSON 字符串**（需 parse） | `input` 是**对象**（直接可用） |

差异点多但有规律，adapter 层把它们抹平。

### 4.3 统一数据结构（`src-tauri/src/ai/types.rs`）

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 统一 chat 请求（上层调用方只构造这个）
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatRequest {
    /// 消息列表（role: system/user/assistant/tool）
    pub messages: Vec<ChatMessage>,
    /// 可用工具定义（function calling）；空表示不启用工具
    pub tools: Vec<ToolDef>,
    /// 是否强制模型调用工具（none/auto/required）
    pub tool_choice: ToolChoice,
    /// 温度（可选，None 用模型默认）
    pub temperature: Option<f32>,
    /// 最大 token（可选）
    pub max_tokens: Option<u32>,
}

/// 统一消息
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "role")]
pub enum ChatMessage {
    system { content: String },
    user { content: String },
    assistant { content: String, tool_calls: Vec<ToolCall> },
    /// 工具执行结果（回传给模型）
    tool { tool_call_id: String, content: String },
}

/// 工具定义（与协议无关的统一形态）
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// 参数的 JSON Schema（直接透传，不自己造 schema 库）
    pub parameters: Value,
}

/// 工具调用（模型要求调用的工具）
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// 参数（已 parse 成对象，不再是 JSON 字符串）
    pub arguments: Value,
}

/// tool_choice：不调工具 / 模型自决 / 强制调工具
#[derive(Serialize, Deserialize, Clone, Default)]
pub enum ToolChoice {
    #[default]
    auto,
    none,
    required,
}

/// 统一 chat 响应
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatResponse {
    /// 模型回复的文本（无工具调用时）
    pub content: String,
    /// 模型要求调用的工具（有则上层执行后回传）
    pub tool_calls: Vec<ToolCall>,
    /// 本次消耗 token（用于成本展示；拿不到则 None）
    pub usage: Option<TokenUsage>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}
```

> **关键设计**：
> - `ToolDef.parameters` 直接用 `serde_json::Value` 透传 JSON Schema，
>   不自己造 schema 构造库（YAGNI，调用方手写 schema 即可）
> - `ToolCall.arguments` 统一成 `Value` 对象，抹平 OpenAI 的「JSON 字符串」差异
> - `ChatResponse` 把「纯文本回复」和「工具调用」分两个字段，上层判断清晰

### 4.4 Provider Trait + 两个 Adapter（`src-tauri/src/ai/provider.rs`）

```rust
use super::types::*;
use async_trait::async_trait;

/// Provider 抽象 —— 上层只调 chat()，不关心协议细节
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// 发起 chat 请求，返回统一响应
    async fn chat(&self, req: &ChatRequest) -> Result<ChatResponse, AiError>;
    /// 测试连接（发最小请求验证 key/地址/模型可用）
    async fn test_connection(&self) -> Result<String, AiError>;
}

/// 统一错误（含 HTTP 状态码 + 响应体，便于「测试连接」展示具体错误）
#[derive(Debug)]
pub enum AiError {
    /// 配置缺失（key/地址/模型空）
    ConfigMissing(String),
    /// HTTP 错误（含状态码 + 响应体）
    Http { status: u16, body: String },
    /// 网络错误（超时、DNS 等）
    Network(String),
    /// 响应解析失败
    Parse(String),
}

// ── OpenAI 兼容 adapter ──
pub struct OpenAiProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}
impl OpenAiProvider {
    pub fn new(base_url: String, api_key: String, model: String) -> Self { ... }
}
#[async_trait]
impl AiProvider for OpenAiProvider {
    async fn chat(&self, req: &ChatRequest) -> Result<ChatResponse, AiError> {
        // 1. ChatRequest → OpenAI 请求体（tools 转成 {type:"function", function:{...}}）
        // 2. POST {base_url}/chat/completions, header Authorization: Bearer
        // 3. 解析响应：content + tool_calls（arguments JSON 字符串 → Value）
    }
    async fn test_connection(&self) -> Result<String, AiError> {
        // POST {base_url}/chat/completions, max_tokens:1, content:"hi"
    }
}

// ── Anthropic adapter ──
pub struct AnthropicProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}
#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn chat(&self, req: &ChatRequest) -> Result<ChatResponse, AiError> {
        // 1. ChatRequest → Anthropic 请求体（tools 用 input_schema；system 消息单独提出来；
        //    tool 结果用 role:user + content:[{type:"tool_result",...}]）
        // 2. POST {base_url}/v1/messages, headers x-api-key + anthropic-version
        // 3. 解析响应：content 数组里提取 text block + tool_use block
    }
    async fn test_connection(&self) -> Result<String, AiError> { ... }
}

/// 工厂：按 provider 类型构造对应 adapter
pub fn build_provider(
    provider: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<Box<dyn AiProvider>, AiError> {
    match provider {
        "anthropic" => Ok(Box::new(AnthropicProvider::new(...))),
        _ => Ok(Box::new(OpenAiProvider::new(...))),
    }
}
```

> **Anthropic adapter 的特殊处理**：
> - system 消息在 Anthropic 里是**顶层字段**（不在 messages 数组里），adapter 要单独抽出来
> - tool 结果用 `role:user` + `content:[{type:"tool_result", tool_use_id, content}]`，
>   而非 OpenAI 的 `role:tool`

### 4.5 配置读取辅助（`src-tauri/src/ai/mod.rs`）

```rust
pub mod provider;
pub mod types;

use sqlx::SqlitePool;
use crate::commands::get_setting_inner;
use provider::*;

/// AI 配置快照（从 app_settings 读出的运行时配置）
pub struct AiConfig {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 从 app_settings 读 AI 配置
pub async fn load_config(pool: &SqlitePool) -> Result<AiConfig, AiError> {
    let get = |k: &str| get_setting_inner(pool, k.into());
    Ok(AiConfig {
        enabled: get("ai_enabled").await?.as_deref() == Some("true"),
        provider: get("ai_provider").await?.unwrap_or_default(),
        base_url: get("ai_base_url").await?.unwrap_or_default(),
        api_key: get("ai_api_key").await?.unwrap_or_default(),
        model: get("ai_model").await?.unwrap_or_default(),
    })
}

/// 读配置 + 构造 provider（供 commands 调用）
pub async fn build_from_settings(pool: &SqlitePool) -> Result<Box<dyn AiProvider>, AiError> {
    let cfg = load_config(pool).await?;
    if !cfg.enabled {
        return Err(AiError::ConfigMissing("AI 未启用".into()));
    }
    if cfg.base_url.is_empty() || cfg.api_key.is_empty() || cfg.model.is_empty() {
        return Err(AiError::ConfigMissing("API 地址/Key/模型名 未配置完整".into()));
    }
    build_provider(&cfg.provider, &cfg.base_url, &cfg.api_key, &cfg.model)
}
```

### 4.6 文件组织（遵循"每层不超过 8 个文件"）

```
src-tauri/src/ai/
├── mod.rs        # 模块入口 + 配置读取（load_config / build_from_settings）
├── types.rs      # 统一数据结构（ChatRequest/ChatResponse/Tool*）
└── provider.rs   # AiProvider trait + OpenAi/Anthropic adapter + 工厂
```

---

## 五、前端交互设计

### 区块结构（复用现有 `.settings-section__item` 样式）

```
设置 → AI
┌──────────────────────────────────────────────┐
│  AI                                           │
│  配置 AI 服务，用于自然语言建任务等功能。       │
│                                               │
│  ┌─ 启用 AI ──────────────────── [开关] ──┐  │  ← 总开关
│  │  关闭后所有 AI 功能入口将隐藏            │  │
│  └────────────────────────────────────────┘  │
│                                               │
│  ─────────────（开关打开后显示下方配置）─────  │
│                                               │
│  服务协议： ( ) OpenAI 兼容  ( ) Anthropic     │  ← 协议类型单选
│                                               │
│  API 地址： [https://api.openai.com/v1    ]   │  ← 输入框
│  API Key：  [•••••••••••••••••••••••••••] 👁  │  ← 密码框 + 显隐
│  模型名：   [gpt-4o                       ]   │  ← 输入框
│                                               │
│            [测试连接]                          │  ← 发最小请求验证
│            ✓ 连接成功 / ✗ 错误：xxx            │  ← 测试结果反馈
└──────────────────────────────────────────────┘
```

### 关键交互

1. **总开关关闭时**：下方所有配置项隐藏（`v-if="aiEnabled"`）。
   语义：关掉 = 不用 AI，配置也无需展示。
2. **协议类型切换**：单选切换 OpenAI / Anthropic。
   - 切换时清空模型名（不同协议模型名不通用），地址保留（用户可能改了中转）。
3. **测试连接**：点按钮 → Rust 端发最小请求 → 返回成功/失败。
   - 成功：绿色 `✓ 连接成功（模型 xxx）`
   - 失败：红色 `✗ 错误：HTTP 401 / 网络超时 / ...`
   - 测试中：按钮 loading 状态
4. **保存时机**：输入框 `@change` 即自动保存，复用 store 乐观更新 + 失败回滚。

---

## 六、改动文件清单

| 文件 | 改动 | 后端? |
|------|------|------|
| `src/stores/settings.ts` | 加 5 个 ai_* ref + SETTINGS_KEYS + setter + initialize 读取 | 否 |
| `src/views/SettingsView.vue` | sections 加「AI」项 + AI 区块模板 + 测试连接逻辑 | 否 |
| **`src-tauri/src/ai/mod.rs`** | **新增**：模块入口 + load_config + build_from_settings | 是 |
| **`src-tauri/src/ai/types.rs`** | **新增**：统一数据结构 | 是 |
| **`src-tauri/src/ai/provider.rs`** | **新增**：AiProvider trait + OpenAI/Anthropic adapter + 工厂 | 是 |
| `src-tauri/src/commands.rs` | 新增 `ai_test_connection` 命令（调抽象层） | 是 |
| `src-tauri/src/lib.rs` | `mod ai;` + invoke_handler 注册 `ai_test_connection` | 是 |
| `src-tauri/Cargo.toml` | 加 `async-trait` 依赖（trait 有 async 方法需要） | 是 |

预估总工作量：1 天（含抽象层 + tools 适配）。

---

## 七、后续（不在本阶段）

抽象层搭好后，后续 AI 功能的调用范式：

```rust
// 例：自然语言建任务（后续实现）
let provider = ai::build_from_settings(pool).await?;
let req = ChatRequest {
    messages: vec![
        ChatMessage::system { content: "你是任务解析助手...".into() },
        ChatMessage::user { content: "明天下午3点和老板开会".into() },
    ],
    tools: vec![ToolDef {
        name: "create_task".into(),
        description: "创建一个任务".into(),
        parameters: json!({ "type":"object", "properties": { "title": {...}, "due_at": {...} } }),
    }],
    tool_choice: ToolChoice::auto,
    ..Default::default()
};
let resp = provider.chat(&req).await?;
if !resp.tool_calls.is_empty() {
    let call = &resp.tool_calls[0];
    // call.arguments 是 Value 对象，直接取 title/due_at 建任务
}
```

- 各 AI 功能（自然语言建任务、拆子任务等）会复用这套抽象
- 功能开关：每个 AI 功能独立开关
- 流式输出（streaming）：trait 可加 `chat_stream` 方法返回 Stream
- 本地 Ollama 支持（走 OpenAI 兼容协议，地址填 `http://localhost:11434/v1`）
