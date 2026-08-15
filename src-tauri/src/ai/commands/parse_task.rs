// AI 自然语言建任务（tools/function calling 首个落地）
// 用户输入「明天3点和老板开会 #工作 高优」，AI 用 parse_task 工具
// 解析出 {title, priority, dueStartAt, dueEndAt, tagNames}，前端填充属性栏待确认。

use tauri::State;

use super::load_prompt;
use crate::ai::{build_from_settings, ChatMessage, ChatRequest, ToolChoice, ToolDef};
use crate::commands::{now, CmdResult};

/// 默认解析提示词（可自定义，读 ai_prompt_parse_task 设置）
pub const DEFAULT_PROMPT_PARSE_TASK: &str = r#"你是一个任务解析助手。根据用户的自然语言输入，提取任务的结构化信息并调用 parse_task 工具。

规则：
1. 标题：提取去掉时间/优先级/标签等修饰词后的核心内容
2. 优先级：识别「高优/紧急/重要」→3，「中/一般」→2，「低」→1，无明确表示→0
3. 截止时间：解析「明天/后天/下周一/3点/下午」等表达，换算成具体时间。若只提到日期无具体时间，结束时间用当天 23:59:59
4. 标签：识别 # 后面的词作为标签名（不含#）
5. 无法确定的字段不要编造，省略即可（除了 title 必填）
6. 时间格式：YYYY-MM-DDTHH:mm:ss（本地时间）
7. 详情正文(note)：总结并扩充用户输入的内容，生成一段简洁的任务描述（HTML 的 <p> 标签即可）。
   要基于用户实际输入来总结，不要套模板或编造无关内容。例如：
   - 「周五早上开周会」→ 「<p>周五早上召开周例会，回顾本周工作进展，同步下周计划，讨论遇到的问题。</p>」
   - 「准备季度汇报」→ 「<p>准备季度工作汇报，整理本季度主要成果、数据分析及下季度计划。</p>」
   简单的任务（如「买菜」）可省略 note"#;

/// 自然语言建任务解析命令。
/// 参数 input: 用户输入的自然语言。
/// 返回 { ok, parsed: {title, priority, dueStartAt, dueEndAt, tagNames} }。
#[tauri::command]
pub async fn ai_parse_task(
    pool: State<'_, sqlx::SqlitePool>,
    input: String,
) -> CmdResult<serde_json::Value> {
    // 当前时间作锚点（让模型算出正确的绝对日期）
    let now = now();

    // 读自定义提示词（空用默认）
    let prompt_tpl = load_prompt(
        pool.inner(),
        "ai_prompt_parse_task",
        DEFAULT_PROMPT_PARSE_TASK,
    )
    .await;
    let system_prompt = format!("{}\n\n当前时间：{}", prompt_tpl, now);

    // 定义 parse_task 工具（建任务意图）
    let parse_tool = ToolDef {
        name: "parse_task".into(),
        description: "用户想创建一个新任务时调用此工具。解析自然语言输入，提取任务的结构化信息"
            .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "任务标题（去掉时间/优先级/标签等修饰词后的核心内容）"
                },
                "priority": {
                    "type": "integer",
                    "enum": [0, 1, 2, 3],
                    "description": "优先级：0=无 1=低 2=中 3=高"
                },
                "dueStartAt": {
                    "type": "string",
                    "description": "截止开始时间，本地格式 YYYY-MM-DDTHH:mm:ss，无则省略"
                },
                "dueEndAt": {
                    "type": "string",
                    "description": "截止结束时间，本地格式 YYYY-MM-DDTHH:mm:ss，无则省略"
                },
                "tagNames": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "标签名称列表（不含#）"
                },
                "note": {
                    "type": "string",
                    "description": "任务详情正文（HTML 的 <p> 标签）。总结并扩充用户输入的内容，生成简洁的任务描述。不要套模板或编造无关内容"
                }
            },
            "required": ["title"]
        }),
    };

    // 定义 summarize_list 工具（总结当前清单意图）
    let summarize_tool = ToolDef {
        name: "summarize_list".into(),
        description: "用户想总结、分析、回顾当前清单/列表中的任务时调用此工具。如「总结下这个清单」「分析下任务情况」".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {}
        }),
    };

    // 定义 smart_summary 工具（每日/周报意图）
    let smart_summary_tool = ToolDef {
        name: "smart_summary".into(),
        description: "用户想查看每日小结、周报、或回顾今天/本周的任务完成情况时调用。如「总结下今天」「看看本周进展」".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["daily", "weekly"],
                    "description": "daily=今天，weekly=本周"
                }
            },
            "required": ["mode"]
        }),
    };

    // 定义 create_note 工具（创建笔记意图）
    let create_note_tool = ToolDef {
        name: "create_note".into(),
        description:
            "用户想记录想法、灵感、笔记（而非待办任务）时调用。如「记录个想法」「写个笔记」".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "笔记标题（核心内容）"
                },
                "note": {
                    "type": "string",
                    "description": "笔记正文（HTML 的 <p> 标签）。总结并扩充用户输入的内容"
                },
                "tagNames": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "标签名称列表（不含#）"
                }
            },
            "required": ["title"]
        }),
    };

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system {
                content: system_prompt,
            },
            ChatMessage::user {
                content: input.clone(),
            },
        ],
        tools: vec![
            parse_tool,
            summarize_tool,
            smart_summary_tool,
            create_note_tool,
        ],
        tool_choice: ToolChoice::Auto,
        ..Default::default()
    };

    let provider = match build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    };

    match provider.chat(&req).await {
        Ok(resp) => {
            // 根据模型调用的工具名判断意图（tool_choice: Auto，模型自行选择）
            if let Some(call) = resp.tool_calls.first() {
                let tool_name = call.name.as_str();
                let args = &call.arguments;
                match tool_name {
                    "summarize_list" => {
                        // 总结当前清单意图：前端据此触发 ai_summary_scope
                        Ok(serde_json::json!({
                            "ok": true,
                            "intent": "summarize_list",
                        }))
                    }
                    "smart_summary" => {
                        // 每日/周报意图：前端据此触发 smart 总结
                        let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("daily");
                        Ok(serde_json::json!({
                            "ok": true,
                            "intent": "smart_summary",
                            "mode": if mode == "weekly" { "weekly" } else { "daily" },
                        }))
                    }
                    "create_note" => {
                        // 创建笔记意图：前端据此创建笔记（kind=note）
                        Ok(serde_json::json!({
                            "ok": true,
                            "intent": "create_note",
                            "parsed": {
                                "title": args.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                                "note": args.get("note").and_then(|v| v.as_str()).unwrap_or(""),
                                "tagNames": args.get("tagNames").and_then(|v| v.as_array())
                                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
                                    .unwrap_or_default(),
                            }
                        }))
                    }
                    _ => {
                        // 默认当作建任务（parse_task）
                        Ok(serde_json::json!({
                            "ok": true,
                            "intent": "create_task",
                            "parsed": {
                                "title": args.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                                "priority": args.get("priority").and_then(|v| v.as_i64()).unwrap_or(0),
                                "dueStartAt": args.get("dueStartAt").and_then(|v| v.as_str()),
                                "dueEndAt": args.get("dueEndAt").and_then(|v| v.as_str()),
                                "tagNames": args.get("tagNames").and_then(|v| v.as_array())
                                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
                                    .unwrap_or_default(),
                                "note": args.get("note").and_then(|v| v.as_str()).unwrap_or(""),
                            }
                        }))
                    }
                }
            } else {
                // 模型没调工具（返回纯文本），fallback：原样返回标题，提示不支持
                Ok(serde_json::json!({
                    "ok": false,
                    "intent": "unsupported",
                    "message": "暂不支持此操作，请直接输入任务内容创建",
                    "fallback_title": input,
                }))
            }
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    }
}
