// OpenAI 兼容协议 adapter（也用于 DeepSeek/通义/Ollama 等）
//
// 请求：POST {base_url}/chat/completions
// 流式：SSE，data: {choices:[{delta:{content}}]}，结束帧 data: [DONE]

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{trim_slash, truncate_body, AiError, AiProvider, DeltaFn};
use crate::ai::types::{
    ChatMessage, ChatRequest, ChatResponse, TokenUsage, ToolCall, ToolChoice, ToolDef,
};

/// OpenAI 兼容协议 adapter
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
        let text = resp
            .text()
            .await
            .map_err(|e| AiError::Parse(e.to_string()))?;
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
                                      // 要求流式末帧携带 usage（token 统计）；多数兼容端点支持，不支持的多数字段被忽略
        body["stream_options"] = json!({ "include_usage": true });

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
        // 文本增量与工具调用分片同时累积（agent 循环依赖流式 tool_calls）；
        // usage 在最后一个 chunk（include_usage 开启时 choices 为空、顶层带 usage）
        let mut full_content = String::new();
        let mut tool_accs: Vec<ToolCallAcc> = Vec::new();
        let mut usage: Option<TokenUsage> = None;
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
                            tool_calls: finish_tool_accs(tool_accs),
                            usage,
                        });
                    }
                    // 解析 JSON，取 choices[0].delta 的 content / tool_calls
                    if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                        // usage 帧（多为流末尾的独立 chunk）
                        if let Some(u) = val.get("usage").filter(|u| u.is_object()) {
                            usage = Some(TokenUsage {
                                prompt_tokens: u
                                    .get("prompt_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0)
                                    as u32,
                                completion_tokens: u
                                    .get("completion_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0)
                                    as u32,
                            });
                        }
                        let delta = val
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"));
                        if let Some(text) = delta
                            .and_then(|d| d.get("content"))
                            .and_then(|v| v.as_str())
                        {
                            full_content.push_str(text);
                            on_delta(text);
                        }
                        // 工具调用分片：按 index 拼装（id/name 首帧出现，arguments 逐片追加）
                        if let Some(tcs) = delta
                            .and_then(|d| d.get("tool_calls"))
                            .and_then(|v| v.as_array())
                        {
                            for tc in tcs {
                                let idx =
                                    tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                while tool_accs.len() <= idx {
                                    tool_accs.push(ToolCallAcc::default());
                                }
                                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                    tool_accs[idx].id = id.to_string();
                                }
                                if let Some(func) = tc.get("function") {
                                    if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                        tool_accs[idx].name = name.to_string();
                                    }
                                    if let Some(args) =
                                        func.get("arguments").and_then(|v| v.as_str())
                                    {
                                        tool_accs[idx].args.push_str(args);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 流自然结束（未收到 [DONE]，兼容部分兼容协议）
        Ok(ChatResponse {
            content: full_content,
            tool_calls: finish_tool_accs(tool_accs),
            usage,
        })
    }
}

/// 流式工具调用的累积器（OpenAI 按 index 分片下发）
#[derive(Default)]
struct ToolCallAcc {
    id: String,
    name: String,
    /// arguments 分片拼接（完整后是 JSON 字符串）
    args: String,
}

/// 把累积器转成统一 ToolCall（arguments parse 失败用空对象兜底；无名调用丢弃）
fn finish_tool_accs(accs: Vec<ToolCallAcc>) -> Vec<ToolCall> {
    accs.into_iter()
        .filter(|a| !a.name.is_empty())
        .map(|a| ToolCall {
            id: if a.id.is_empty() {
                format!("call_{}", a.name)
            } else {
                a.id
            },
            name: a.name,
            arguments: serde_json::from_str(&a.args).unwrap_or(json!({})),
        })
        .collect()
}

fn msg_to_openai(m: &ChatMessage) -> Value {
    match m {
        ChatMessage::system { content } => json!({ "role": "system", "content": content }),
        ChatMessage::user { content } => json!({ "role": "user", "content": content }),
        ChatMessage::assistant {
            content,
            tool_calls,
        } => {
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
                    let args_str = func
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or("{}");
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
