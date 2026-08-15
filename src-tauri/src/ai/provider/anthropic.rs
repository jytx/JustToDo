// Anthropic（Claude）协议 adapter
//
// 请求：POST {base_url}/v1/messages
// 流式：SSE，event: content_block_delta 携带文本增量，message_stop 表示结束

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{trim_slash, truncate_body, AiError, AiProvider, DeltaFn};
use crate::ai::types::{
    ChatMessage, ChatRequest, ChatResponse, TokenUsage, ToolCall, ToolChoice, ToolDef,
};

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

        // 非系统消息转 Anthropic 格式。
        // 连续的 tool 结果消息必须合并在同一条 user 消息的 content 数组里
        // （Anthropic 协议要求：同一轮的多个 tool_result 不能拆成多条 user）
        let mut messages: Vec<Value> = Vec::new();
        for m in req
            .messages
            .iter()
            .filter(|m| !matches!(m, ChatMessage::system { .. }))
        {
            let v = msg_to_anthropic(m);
            let is_tool_result = matches!(m, ChatMessage::tool { .. });
            if is_tool_result {
                if let Some(last) = messages.last_mut() {
                    if is_tool_result_msg(last) {
                        if let (Some(blocks), Some(adds)) =
                            (last["content"].as_array_mut(), v["content"].as_array())
                        {
                            blocks.extend(adds.iter().cloned());
                            continue;
                        }
                    }
                }
            }
            messages.push(v);
        }

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
        let mut tool_accs: Vec<ToolUseAcc> = Vec::new();
        // 用量：message_start 带输入 token，message_delta 带累计输出 token
        let mut input_tokens: u32 = 0;
        let mut output_tokens: u32 = 0;
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
                    // 用量事件（无 body 依赖，任何 data 帧都先探测一次）
                    if let Ok(uv) = serde_json::from_str::<Value>(json_str) {
                        let ev_type = uv.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if ev_type == "message_start" {
                            input_tokens = uv
                                .pointer("/message/usage/input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                        } else if ev_type == "message_delta" {
                            output_tokens = uv
                                .pointer("/usage/output_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                        }
                    }
                    // 只在 content_block_delta 事件里取文本增量 / 工具参数分片
                    if cur_event == "content_block_delta" {
                        if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                            if let Some(text) = val
                                .get("delta")
                                .and_then(|d| d.get("text"))
                                .and_then(|v| v.as_str())
                            {
                                full_content.push_str(text);
                                on_delta(text);
                            }
                            // 工具调用参数分片：input_json_delta.partial_json 按 index 追加
                            let delta_type = val
                                .get("delta")
                                .and_then(|d| d.get("type"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if delta_type == "input_json_delta" {
                                let idx =
                                    val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                let partial = val
                                    .get("delta")
                                    .and_then(|d| d.get("partial_json"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                if let Some(acc) = tool_accs.iter_mut().find(|a| a.index == idx) {
                                    acc.args.push_str(partial);
                                }
                            }
                        }
                    }
                    // content_block_start：tool_use 块开头，注册累积器（id/name 在此处出现）
                    if cur_event == "content_block_start" {
                        if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                            let block = val.get("content_block").cloned().unwrap_or(json!({}));
                            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                tool_accs.push(ToolUseAcc {
                                    index: val.get("index").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize,
                                    id: block
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    name: block
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    args: String::new(),
                                });
                            }
                        }
                    }
                    // message_stop 事件 → 流结束
                    if cur_event == "message_stop" {
                        return Ok(ChatResponse {
                            content: full_content,
                            tool_calls: finish_tool_use_accs(tool_accs),
                            usage: if input_tokens + output_tokens > 0 {
                                Some(TokenUsage {
                                    prompt_tokens: input_tokens,
                                    completion_tokens: output_tokens,
                                })
                            } else {
                                None
                            },
                        });
                    }
                }
            }
        }

        // 流自然结束
        Ok(ChatResponse {
            content: full_content,
            tool_calls: finish_tool_use_accs(tool_accs),
            usage: if input_tokens + output_tokens > 0 {
                Some(TokenUsage {
                    prompt_tokens: input_tokens,
                    completion_tokens: output_tokens,
                })
            } else {
                None
            },
        })
    }
}

/// 流式工具调用的累积器（Anthropic 按 content block index 组织）
struct ToolUseAcc {
    index: usize,
    id: String,
    name: String,
    /// partial_json 分片拼接（完整后是 JSON 字符串）
    args: String,
}

/// 把累积器转成统一 ToolCall（arguments parse 失败用空对象兜底；无名调用丢弃）
fn finish_tool_use_accs(accs: Vec<ToolUseAcc>) -> Vec<ToolCall> {
    accs.into_iter()
        .filter(|a| !a.name.is_empty())
        .map(|a| ToolCall {
            id: if a.id.is_empty() {
                format!("toolu_{}", a.name)
            } else {
                a.id
            },
            name: a.name,
            arguments: serde_json::from_str(&a.args).unwrap_or(json!({})),
        })
        .collect()
}

/// 判断转换后的消息是否为「工具结果 user 消息」（content 数组首个 block 是 tool_result）
fn is_tool_result_msg(v: &Value) -> bool {
    v.get("role").and_then(|r| r.as_str()) == Some("user")
        && v.get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|b| b.get("type"))
            .and_then(|t| t.as_str())
            == Some("tool_result")
}

fn msg_to_anthropic(m: &ChatMessage) -> Value {
    match m {
        ChatMessage::system { .. } => {
            // system 由 build_body 单独处理，此处不应到达
            json!({ "role": "user", "content": "" })
        }
        ChatMessage::user { content } => json!({ "role": "user", "content": content }),
        ChatMessage::assistant {
            content,
            tool_calls,
        } => {
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
                    // tool_result 的 content 用 text block 数组（Anthropic 标准形态；
                    // 纯字符串官方虽支持，但 MiniMax 等兼容端点只认数组，续聊轮会 400）
                    "content": [{ "type": "text", "text": content }],
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
        prompt_tokens: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        completion_tokens: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    });

    Ok(ChatResponse {
        content,
        tool_calls,
        usage,
    })
}
