// AI Provider 抽象层 —— 上层只调 chat()，不关心协议细节
//
// 内置 OpenAI 兼容协议 + Anthropic 协议两个 adapter（见子模块）：
// - openai.rs    OpenAI 兼容协议（覆盖 OpenAI 官方 / DeepSeek / 通义 / Moonshot / Ollama 等）
// - anthropic.rs Anthropic 协议（Claude 系列）
//
// 两个协议的 tools（function calling）差异较大，在此统一收敛：
// - tools 定义：OpenAI 用 {type:"function",function:{parameters}}；Anthropic 用 {input_schema}
// - 模型返回：OpenAI 的 tool_calls[].function.arguments 是 JSON 字符串；Anthropic 的 input 是对象
// - 工具结果：OpenAI 用 role:"tool"；Anthropic 用 role:"user" + content:[{type:"tool_result"}]
// - system 消息：OpenAI 在 messages 里；Anthropic 是顶层独立字段
//
// 详见 discuss/2026-07-31-ai-config-design.md

mod anthropic;
mod openai;

use async_trait::async_trait;

use super::types::{ChatRequest, ChatResponse};

/// 流式增量回调：每收到一段文本 delta 就回调一次（参数为增量文本）
pub type DeltaFn = Box<dyn Fn(&str) + Send + Sync>;

/// Provider 抽象 —— 上层只调 chat() / chat_stream() / test_connection()，不关心协议细节
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// 发起 chat 请求（一次性返回完整响应），用于结构化输出（tool_calls）等场景
    async fn chat(&self, req: &ChatRequest) -> Result<ChatResponse, AiError>;

    /// 发起流式 chat 请求（SSE），每收到文本 delta 调 on_delta 回调。
    /// 结束后返回汇总的完整响应（content 为拼好的全文）。
    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_delta: DeltaFn,
    ) -> Result<ChatResponse, AiError>;

    /// 测试连接（发最小请求验证 key/地址/模型可用），成功返回模型名
    async fn test_connection(&self) -> Result<String, AiError>;
}

/// 统一错误（含 HTTP 状态码 + 响应体，便于「测试连接」展示具体错误）
#[derive(Debug)]
pub enum AiError {
    /// 配置缺失（key/地址/模型空，或 AI 未启用）
    ConfigMissing(String),
    /// HTTP 错误（含状态码 + 响应体，用于给用户精确报错）
    Http { status: u16, body: String },
    /// 网络错误（超时、DNS、连接拒绝等）
    Network(String),
    /// 响应解析失败（协议不符或返回结构异常）
    Parse(String),
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::ConfigMissing(msg) => write!(f, "配置错误：{}", msg),
            AiError::Http { status, body } => write!(f, "HTTP {}：{}", status, body),
            AiError::Network(msg) => write!(f, "网络错误：{}", msg),
            AiError::Parse(msg) => write!(f, "响应解析失败：{}", msg),
        }
    }
}

// ──────────────────────────────────────────────────────────
// 工厂函数
// ──────────────────────────────────────────────────────────

/// 按 provider 类型构造对应 adapter。
/// - "anthropic" → AnthropicProvider
/// - 其他（含 "openai" / 未知值）→ OpenAiProvider（OpenAI 兼容是默认兜底）
pub fn build_provider(
    provider: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<Box<dyn AiProvider>, AiError> {
    match provider {
        "anthropic" => Ok(Box::new(anthropic::AnthropicProvider::new(
            base_url.to_string(),
            api_key.to_string(),
            model.to_string(),
        ))),
        _ => Ok(Box::new(openai::OpenAiProvider::new(
            base_url.to_string(),
            api_key.to_string(),
            model.to_string(),
        ))),
    }
}

// ──────────────────────────────────────────────────────────
// 辅助函数（子模块共用）

/// 去掉 base_url 末尾的斜杠，避免拼接出双斜杠
fn trim_slash(s: &str) -> String {
    s.trim_end_matches('/').to_string()
}

/// 错误响应体截断（避免超长 body 刷屏）
fn truncate_body(s: &str) -> String {
    const MAX: usize = 500;
    if s.len() > MAX {
        format!("{}...(已截断)", &s[..MAX])
    } else {
        s.to_string()
    }
}
