// AI Provider 抽象层 —— 上层只调 chat()，不关心协议细节
//
// 内置 OpenAI 兼容协议 + Anthropic 协议两个 adapter：
// - OpenAI 兼容协议覆盖最广：OpenAI 官方 / DeepSeek / 通义 / Moonshot / 本地 Ollama 等
// - Anthropic 协议覆盖 Claude 系列
//
// 两个协议的 tools（function calling）差异较大，在此统一收敛：
// - tools 定义：OpenAI 用 {type:"function",function:{parameters}}；Anthropic 用 {input_schema}
// - 模型返回：OpenAI 的 tool_calls[].function.arguments 是 JSON 字符串；Anthropic 的 input 是对象
// - 工具结果：OpenAI 用 role:"tool"；Anthropic 用 role:"user" + content:[{type:"tool_result"}]
// - system 消息：OpenAI 在 messages 里；Anthropic 是顶层独立字段
//
// 详见 discuss/2026-07-31-ai-config-design.md

use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{
    ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolChoice, ToolDef, TokenUsage,
};

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
// OpenAI 兼容 adapter
// ──────────────────────────────────────────────────────────

/// OpenAI 兼容协议 adapter（也用于 DeepSeek/通义/Ollama 等）
pub struct OpenAiProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl OpenAiProvider {
    pub fn new(base_url: String, api_key: String, model: String) -> Self {
        Self {
            // 复用项目已引入的 reqwest（holiday.rs 同款）。
            // 加 60s 超时：AI 生成耗时较长但仍需上限，避免接口无响应时弹窗永远 loading。
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            base_url,
            api_key,
            model,
        }
    }

    /// 把统一 ChatRequest 翻译成 OpenAI /chat/completions 请求体
    fn build_body(&self, req: &ChatRequest) -> Value {
        let mut body = json!({
            "model": self.model,
            "messages": req.messages.iter().map(msg_to_openai).collect::<Vec<_>>(),
        });
        if !req.tools.is_empty() {
            body["tools"] = json!(req.tools.iter().map(tool_to_openai).collect::<Vec<_>>());
            body["tool_choice"] = json!(match req.tool_choice {
                ToolChoice::Auto => "auto",
                ToolChoice::None => "none",
                ToolChoice::Required => "required",
            });
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(m) = req.max_tokens {
            body["max_tokens"] = json!(m);
        }
        body
    }
}

#[async_trait]
impl AiProvider for OpenAiProvider {
    async fn chat(&self, req: &ChatRequest) -> Result<ChatResponse, AiError> {
        let url = format!("{}/chat/completions", trim_slash(&self.base_url));
        let body = self.build_body(req);
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AiError::Network(e.to_string()))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| AiError::Parse(e.to_string()))?;
        if !status.is_success() {
            return Err(AiError::Http {
                status: status.as_u16(),
                body: truncate_body(&text),
            });
        }
        let val: Value = serde_json::from_str(&text)
            .map_err(|e| AiError::Parse(format!("非合法 JSON：{}", e)))?;
        parse_openai_response(&val)
    }

    async fn test_connection(&self) -> Result<String, AiError> {
        let req = ChatRequest {
            messages: vec![ChatMessage::user {
                content: "hi".into(),
            }],
            max_tokens: Some(1),
            ..Default::default()
        };
        self.chat(&req).await?;
        Ok(self.model.clone())
    }

    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_delta: DeltaFn,
    ) -> Result<ChatResponse, AiError> {
        use futures_util::StreamExt;

        let url = format!("{}/chat/completions", trim_slash(&self.base_url));
        let mut body = self.build_body(req);
        body["stream"] = json!(true); // 开启 SSE 流式

        // 流式请求用无超时 client，避免长文本生成被 60s 掐断
        let stream_client = reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let resp = stream_client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AiError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AiError::Http {
                status: status.as_u16(),
                body: truncate_body(&text),
            });
        }

        // 逐块读 SSE，按行解析 data: {...delta.content...}
        let mut full_content = String::new();
        let mut buf = String::new(); // 半行缓冲（SSE 块边界不一定在换行处）
        let mut stream = resp.bytes_stream();
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|e| AiError::Network(e.to_string()))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));

            // 按换行切分，最后一段可能不完整，留在 buf 里
            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim().to_string();
                buf = buf[nl + 1..].to_string();

                // SSE 格式：data: {json} 或 data: [DONE]
                if let Some(json_str) = line.strip_prefix("data: ") {
                    if json_str.trim() == "[DONE]" {
                        // 流结束
                        return Ok(ChatResponse {
                            content: full_content,
                            tool_calls: vec![],
                            usage: None,
                        });
                    }
                    // 解析 JSON，取 choices[0].delta.content
                    if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                        if let Some(delta) = val.get("choices").and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta")).and_then(|d| d.get("content"))
                            .and_then(|v| v.as_str())
                        {
                            full_content.push_str(delta);
                            on_delta(delta);
                        }
                    }
                }
            }
        }

        // 流自然结束（未收到 [DONE]，兼容部分兼容协议）
        Ok(ChatResponse {
            content: full_content,
            tool_calls: vec![],
            usage: None,
        })
    }
}
fn msg_to_openai(m: &ChatMessage) -> Value {
    match m {
        ChatMessage::system { content } => json!({ "role": "system", "content": content }),
        ChatMessage::user { content } => json!({ "role": "user", "content": content }),
        ChatMessage::assistant { content, tool_calls } => {
            let mut v = json!({ "role": "assistant", "content": content });
            if !tool_calls.is_empty() {
                v["tool_calls"] = json!(tool_calls.iter().map(call_to_openai).collect::<Vec<_>>());
            }
            v
        }
        ChatMessage::tool {
            tool_call_id,
            content,
        } => {
            json!({ "role": "tool", "tool_call_id": tool_call_id, "content": content })
        }
    }
}

/// 统一 ToolDef → OpenAI tools 定义（{type:"function",function:{name,description,parameters}}）
fn tool_to_openai(t: &ToolDef) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
        }
    })
}

/// 统一 ToolCall → OpenAI tool_calls 格式（arguments 序列化回 JSON 字符串）
fn call_to_openai(c: &ToolCall) -> Value {
    json!({
        "id": c.id,
        "type": "function",
        "function": {
            "name": c.name,
            "arguments": c.arguments.to_string(),
        }
    })
}

/// 解析 OpenAI 响应体 → 统一 ChatResponse
fn parse_openai_response(val: &Value) -> Result<ChatResponse, AiError> {
    let choice = val
        .get("choices")
        .and_then(|c| c.get(0))
        .ok_or_else(|| AiError::Parse("响应缺少 choices".into()))?;
    let msg = choice
        .get("message")
        .ok_or_else(|| AiError::Parse("响应缺少 message".into()))?;

    // 文本内容
    let content = msg
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 工具调用（OpenAI 的 arguments 是 JSON 字符串，需 parse 成对象）
    let tool_calls: Vec<ToolCall> = msg
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|tc| {
                    let id = tc.get("id")?.as_str()?.to_string();
                    let func = tc.get("function")?;
                    let name = func.get("name")?.as_str()?.to_string();
                    let args_str = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                    // arguments 解析失败时用空对象兜底，不整体失败
                    let arguments = serde_json::from_str(args_str).unwrap_or(json!({}));
                    Some(ToolCall {
                        id,
                        name,
                        arguments,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // token 用量
    let usage = val.get("usage").map(|u| TokenUsage {
        prompt_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        completion_tokens: u
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
    });

    Ok(ChatResponse {
        content,
        tool_calls,
        usage,
    })
}

// ──────────────────────────────────────────────────────────
// Anthropic adapter
// ──────────────────────────────────────────────────────────

/// Anthropic（Claude）协议 adapter
pub struct AnthropicProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl AnthropicProvider {
    pub fn new(base_url: String, api_key: String, model: String) -> Self {
        Self {
            // 60s 超时，与 OpenAiProvider 一致
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            base_url,
            api_key,
            model,
        }
    }

    /// 把统一 ChatRequest 翻译成 Anthropic /v1/messages 请求体。
    /// 关键差异：
    /// - system 消息是顶层独立字段（不在 messages 数组里），需单独抽出
    /// - tool 结果用 role:"user" + content:[{type:"tool_result"}]（不是 role:"tool"）
    /// - assistant 的工具调用历史用 content:[{type:"tool_use"}] 表达
    fn build_body(&self, req: &ChatRequest) -> Value {
        // 抽出 system 消息合并成顶层 system 字段
        let system_prompt: String = req
            .messages
            .iter()
            .filter_map(|m| match m {
                ChatMessage::system { content } => Some(content.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        // 非系统消息转 Anthropic 格式
        let messages: Vec<Value> = req
            .messages
            .iter()
            .filter(|m| !matches!(m, ChatMessage::system { .. }))
            .map(msg_to_anthropic)
            .collect();

        let mut body = json!({
            "model": self.model,
            "messages": messages,
            // Anthropic 强制要求 max_tokens，给一个合理上限
            "max_tokens": req.max_tokens.unwrap_or(4096),
        });
        if !system_prompt.is_empty() {
            body["system"] = json!(system_prompt);
        }
        if !req.tools.is_empty() {
            body["tools"] = json!(req.tools.iter().map(tool_to_anthropic).collect::<Vec<_>>());
            // Anthropic 的 tool_choice 是对象形式：{ "type": "auto"|"none"|"any" }
            let tc_type = match req.tool_choice {
                ToolChoice::Auto => "auto",
                ToolChoice::None => "none",
                ToolChoice::Required => "any",
            };
            body["tool_choice"] = json!({ "type": tc_type });
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        body
    }
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn chat(&self, req: &ChatRequest) -> Result<ChatResponse, AiError> {
        let url = format!("{}/v1/messages", trim_slash(&self.base_url));
        let body = self.build_body(req);
        let resp = self
            .client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| AiError::Network(e.to_string()))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| AiError::Parse(e.to_string()))?;
        if !status.is_success() {
            return Err(AiError::Http {
                status: status.as_u16(),
                body: truncate_body(&text),
            });
        }
        let val: Value = serde_json::from_str(&text)
            .map_err(|e| AiError::Parse(format!("非合法 JSON：{}", e)))?;
        parse_anthropic_response(&val)
    }

    async fn test_connection(&self) -> Result<String, AiError> {
        let req = ChatRequest {
            messages: vec![ChatMessage::user {
                content: "hi".into(),
            }],
            max_tokens: Some(1),
            ..Default::default()
        };
        self.chat(&req).await?;
        Ok(self.model.clone())
    }

    async fn chat_stream(
        &self,
        req: &ChatRequest,
        on_delta: DeltaFn,
    ) -> Result<ChatResponse, AiError> {
        use futures_util::StreamExt;

        let url = format!("{}/v1/messages", trim_slash(&self.base_url));
        let mut body = self.build_body(req);
        body["stream"] = json!(true); // 开启 SSE 流式

        // 流式请求用无超时 client，避免长文本生成被 60s 掐断
        let stream_client = reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let resp = stream_client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| AiError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AiError::Http {
                status: status.as_u16(),
                body: truncate_body(&text),
            });
        }

        // Anthropic SSE 有 event: 和 data: 成对出现：
        //   event: content_block_delta
        //   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
        // text 增量在 content_block_delta 的 delta.text 里；message_stop 表示结束。
        let mut full_content = String::new();
        let mut buf = String::new();
        let mut cur_event = String::new(); // 当前 event 类型
        let mut stream = resp.bytes_stream();
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|e| AiError::Network(e.to_string()))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim_end().to_string();
                buf = buf[nl + 1..].to_string();
                let line = line.trim();

                if line.is_empty() {
                    // 空行分隔事件，清空当前 event
                    cur_event.clear();
                    continue;
                }
                if let Some(ev) = line.strip_prefix("event: ") {
                    cur_event = ev.trim().to_string();
                } else if let Some(json_str) = line.strip_prefix("data: ") {
                    // 只在 content_block_delta 事件里取文本增量
                    if cur_event == "content_block_delta" {
                        if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                            if let Some(text) = val.get("delta").and_then(|d| d.get("text"))
                                .and_then(|v| v.as_str())
                            {
                                full_content.push_str(text);
                                on_delta(text);
                            }
                        }
                    }
                    // message_stop 事件 → 流结束
                    if cur_event == "message_stop" {
                        return Ok(ChatResponse {
                            content: full_content,
                            tool_calls: vec![],
                            usage: None,
                        });
                    }
                }
            }
        }

        // 流自然结束
        Ok(ChatResponse {
            content: full_content,
            tool_calls: vec![],
            usage: None,
        })
    }
}
fn msg_to_anthropic(m: &ChatMessage) -> Value {
    match m {
        ChatMessage::system { .. } => {
            // system 由 build_body 单独处理，此处不应到达
            json!({ "role": "user", "content": "" })
        }
        ChatMessage::user { content } => json!({ "role": "user", "content": content }),
        ChatMessage::assistant { content, tool_calls } => {
            // content 数组：先放文本 block，再放每个 tool_use block
            let mut blocks: Vec<Value> = Vec::new();
            if !content.is_empty() {
                blocks.push(json!({ "type": "text", "text": content }));
            }
            for tc in tool_calls {
                blocks.push(json!({
                    "type": "tool_use",
                    "id": tc.id,
                    "name": tc.name,
                    "input": tc.arguments,
                }));
            }
            json!({ "role": "assistant", "content": blocks })
        }
        ChatMessage::tool {
            tool_call_id,
            content,
        } => {
            // Anthropic 工具结果：role=user + content 数组里的 tool_result block
            json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                }]
            })
        }
    }
}

/// 统一 ToolDef → Anthropic tools 定义（用 input_schema 而非 parameters）
fn tool_to_anthropic(t: &ToolDef) -> Value {
    json!({
        "name": t.name,
        "description": t.description,
        "input_schema": t.parameters,
    })
}

/// 解析 Anthropic 响应体 → 统一 ChatResponse。
/// Anthropic 把文本和工具调用都放在 content 数组里（不同 type 的 block）。
fn parse_anthropic_response(val: &Value) -> Result<ChatResponse, AiError> {
    let content_arr = val
        .get("content")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AiError::Parse("响应缺少 content 数组".into()))?;

    let mut content = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    for block in content_arr {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    content.push_str(t);
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Anthropic 的 input 已经是对象，无需 parse
                let arguments = block.get("input").cloned().unwrap_or(json!({}));
                if !id.is_empty() && !name.is_empty() {
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        arguments,
                    });
                }
            }
            _ => {}
        }
    }

    let usage = val.get("usage").map(|u| TokenUsage {
        prompt_tokens: u
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        completion_tokens: u
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
    });

    Ok(ChatResponse {
        content,
        tool_calls,
        usage,
    })
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
        "anthropic" => Ok(Box::new(AnthropicProvider::new(
            base_url.to_string(),
            api_key.to_string(),
            model.to_string(),
        ))),
        _ => Ok(Box::new(OpenAiProvider::new(
            base_url.to_string(),
            api_key.to_string(),
            model.to_string(),
        ))),
    }
}

// ──────────────────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────────────────

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
