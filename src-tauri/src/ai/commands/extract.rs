// AI 文本提取任务 —— 从会议纪要/邮件/聊天记录中提取行动项草稿，前端预览确认后落库

use tauri::State;

use super::{load_prompt, parse_subtasks_from_content};
use crate::ai::{build_from_settings, ChatMessage, ChatRequest, ToolChoice, ToolDef};
use crate::commands::{now, CmdResult};

/// AI 文本提取任务的默认系统提示词。
/// 指导模型从一段文本（会议纪要/邮件/聊天记录）中提取可执行的行动项。
pub const DEFAULT_PROMPT_EXTRACT_TASKS: &str = r#"你是一个任务提取助手。用户会给你一段文本（如会议纪要、邮件、聊天记录），你需要从中提取出所有隐含的、需要执行的待办任务，并调用 extract_tasks 工具返回。

提取规则：
1. 只提取"需要有人去做"的行动项，跳过纯信息陈述、已完成的、讨论性内容。
2. 标题：把口语化/隐含的行动项改写成简洁明确的任务标题（动作短语），如「整理本月销售数据」「回复客户合同邮件」。
3. 优先级：识别紧迫程度。明确提到「紧急/尽快/马上」→3，正常 →2，低优先级 →1，无法判断 →0。
4. 截止时间：从文本中识别明确的截止日期（如「周五前」「下周一」「7月15号前」），换算成具体时间。
   时间格式 YYYY-MM-DDTHH:mm:ss（本地时间），只到日期的用当天 23:59:59。无明确截止则省略。
5. 备注(note)：如果行动项有关键背景信息（如负责人、具体要求），用 HTML 的 <p> 标签简短记录。无则省略。
6. 如果文本中确实没有可提取的行动项，返回空数组。

示例：
- 「明天开会讨论Q3规划，小王负责准备数据，周五前发给大家」→
  ①「准备Q3规划会议数据」(负责人小王) ②「发送Q3规划数据给团队」(周五前)"#;

/// AI 文本提取任务命令。
/// 参数 text: 用户粘贴的文本（会议纪要/邮件等）。
/// 返回 { ok, subtasks: [{title, priority, dueStartAt, dueEndAt, note}] }。
#[tauri::command]
pub async fn ai_extract_tasks(
    pool: State<'_, sqlx::SqlitePool>,
    text: String,
) -> CmdResult<serde_json::Value> {
    let provider = match build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    };

    let now = now();
    let prompt_tpl = load_prompt(
        pool.inner(),
        "ai_prompt_extract_tasks",
        DEFAULT_PROMPT_EXTRACT_TASKS,
    )
    .await;
    let system_prompt = format!("{}\n\n当前时间：{}", prompt_tpl, now);

    // 定义 extract_tasks 工具（与 breakdown_task 结构一致，仅名称不同）
    let extract_tool = ToolDef {
        name: "extract_tasks".into(),
        description: "从用户提供的文本中提取出需要执行的待办任务时调用此工具。返回一个任务数组"
            .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "subtasks": {
                    "type": "array",
                    "description": "提取出的任务列表，按文本中出现顺序排列",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "任务标题（简洁明确的动作短语）"
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
                            "note": {
                                "type": "string",
                                "description": "任务背景说明（HTML 的 <p> 标签）。记录负责人、具体要求等，无则省略"
                            }
                        },
                        "required": ["title"]
                    }
                }
            },
            "required": ["subtasks"]
        }),
    };

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system {
                content: system_prompt,
            },
            ChatMessage::user {
                content: text.clone(),
            },
        ],
        tools: vec![extract_tool],
        tool_choice: ToolChoice::Auto,
        ..Default::default()
    };

    match provider.chat(&req).await {
        Ok(resp) => {
            // 优先从 tool_calls 解析（标准路径），兜底从 content 文本提取 JSON
            let subtasks = if let Some(call) = resp.tool_calls.first() {
                let args = &call.arguments;
                args.get("subtasks")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .map(|item| {
                                serde_json::json!({
                                    "title": item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                                    "priority": item.get("priority").and_then(|v| v.as_i64()).unwrap_or(0),
                                    "dueStartAt": item.get("dueStartAt").and_then(|v| v.as_str()),
                                    "dueEndAt": item.get("dueEndAt").and_then(|v| v.as_str()),
                                    "note": item.get("note").and_then(|v| v.as_str()).unwrap_or(""),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            } else {
                parse_subtasks_from_content(&resp.content)
            };

            if subtasks.is_empty() {
                return Ok(serde_json::json!({
                    "ok": false,
                    "message": "未从文本中提取到任务，请尝试更详细的内容"
                }));
            }
            Ok(serde_json::json!({ "ok": true, "subtasks": subtasks }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    }
}
