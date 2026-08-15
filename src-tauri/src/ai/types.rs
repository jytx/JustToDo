// AI 抽象层 —— 统一数据结构
//
// 本文件定义与 Provider 协议无关的统一 chat 请求/响应类型。
// 上层调用方（各 AI 功能）只构造 ChatRequest，由 provider adapter
// 负责翻译成 OpenAI / Anthropic 各自的请求体。
//
// 详见 discuss/2026-07-31-ai-config-design.md

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// AI 流式输出的单条增量消息（经 Tauri Channel 推给前端）。
/// 供非 agent 的流式命令（总结/润色等）使用；agent 会话用 AgentEvent。
#[derive(Serialize, Clone)]
pub struct StreamChunk {
    /// 本次增量文本（流过程中有，结束帧为 None）
    pub delta: Option<String>,
    /// 流是否结束（true = 最后一帧）
    pub done: bool,
}

/// 统一 chat 请求（上层调用方只构造这个）
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ChatRequest {
    /// 消息列表（system/user/assistant/tool 四种角色）
    pub messages: Vec<ChatMessage>,
    /// 可用工具定义（function calling）；空 Vec 表示不启用工具
    pub tools: Vec<ToolDef>,
    /// 是否强制模型调用工具（默认 auto：模型自行决定）
    #[serde(default)]
    pub tool_choice: ToolChoice,
    /// 温度（可选，None 用模型默认）
    pub temperature: Option<f32>,
    /// 最大 token（可选）
    pub max_tokens: Option<u32>,
}

/// 统一消息（四种角色用 enum 表达，序列化时带 role tag）
// variant 名故意小写，匹配 serde 序列化的 role 值（system/user/assistant/tool），
// 与 OpenAI/Anthropic 协议一致，adapter 里直接透传无需映射。
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "role")]
#[allow(non_camel_case_types)]
pub enum ChatMessage {
    /// 系统指令（设定模型行为）
    system { content: String },
    /// 用户输入
    user { content: String },
    /// 模型回复（含可选的工具调用请求）
    assistant {
        content: String,
        #[serde(default)]
        tool_calls: Vec<ToolCall>,
    },
    /// 工具执行结果（回传给模型，配合上一轮的 tool_calls）
    tool {
        /// 对应 OpenAI 的 tool_call_id / Anthropic 的 tool_use_id
        tool_call_id: String,
        content: String,
    },
}

/// 工具定义（与协议无关的统一形态）。
/// parameters 是参数的 JSON Schema，直接透传给 Provider，
/// 不自己造 schema 构造库（调用方手写 schema 即可）。
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// 参数的 JSON Schema（如 {"type":"object","properties":{...}}）
    pub parameters: Value,
}

/// 模型要求调用的工具
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolCall {
    /// 调用 id（用于回传工具结果时配对）
    pub id: String,
    pub name: String,
    /// 参数（已 parse 成对象；抹平 OpenAI 的「JSON 字符串」差异）
    pub arguments: Value,
}

/// tool_choice：控制模型是否/如何调用工具
#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
pub enum ToolChoice {
    /// 模型自行决定是否调工具（默认）
    #[default]
    #[serde(rename = "auto")]
    Auto,
    /// 禁止调工具
    #[serde(rename = "none")]
    None,
    /// 强制调工具
    #[serde(rename = "required")]
    Required,
}

/// 统一 chat 响应
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ChatResponse {
    /// 模型回复的文本（无工具调用时为正常回复；有工具调用时可能为空）
    #[serde(default)]
    pub content: String,
    /// 模型要求调用的工具（有则上层执行后回传，开启多轮工具循环）
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// 本次消耗 token（用于成本展示；拿不到则 None）
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

/// token 消耗统计
#[derive(Serialize, Deserialize, Clone)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}
