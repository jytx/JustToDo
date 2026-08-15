// AI 任务拆解 —— 把大任务拆成 3-8 个子任务草稿，前端预览确认后落库

use tauri::State;

use super::{load_prompt, parse_subtasks_from_content};
use crate::ai::{build_from_settings, ChatMessage, ChatRequest, ToolChoice, ToolDef};
use crate::commands::{now, row_to_task, CmdResult};

/// AI 任务拆解的默认系统提示词。
/// 指导模型把一个大任务拆成 3-8 个可执行的子任务，每项含标题/优先级/截止时间/备注。
pub const DEFAULT_PROMPT_BREAKDOWN_TASK: &str = r#"你是一个任务拆解助手。用户会给你一个大任务，你需要把它拆解成 3-8 个具体、可执行的子任务，并调用 breakdown_task 工具返回。

拆解规则：
1. 子任务数量：3-8 个，过少不够细致，过多难以管理。大任务本身不要作为一个子任务。
2. 标题：简洁明确的动作短语，如「收集本月销售数据」「撰写汇报大纲」「制作 PPT」。
3. 优先级：识别子任务的重要性和紧急程度。「关键路径/必须先完成」→3，「一般」→2，「辅助/可选」→1，无法判断→0。
4. 截止时间：如果父任务有截止时间，子任务应合理分布在父任务截止之前（前面的子任务更早）；
   若无明确截止时间，可省略。时间格式 YYYY-MM-DDTHH:mm:ss（本地时间），只到日期的用当天 23:59:59。
5. 备注(note)：为每个子任务生成一段简短的执行说明（HTML 的 <p> 标签），说明具体要做什么、注意什么。
   要基于实际任务内容来写，不要套模板或编造无关内容。
6. 子任务之间应有合理的先后顺序，按顺序排列。

示例：
- 大任务「准备季度汇报」→ 子任务：收集本季度数据 / 撰写汇报大纲 / 制作PPT / 内部评审彩排
- 大任务「组织团建活动」→ 子任务：确定活动预算 / 调查参与人数和意向 / 预订场地 / 发布活动通知 / 准备活动物资"#;

/// AI 任务拆解命令。
/// 参数 task_id: 要拆解的（大）任务 ID。后端先查出任务标题和备注作为输入。
/// 返回 { ok, subtasks: [{title, priority, dueStartAt, dueEndAt, note}] }。
#[tauri::command]
pub async fn ai_breakdown_task(
    pool: State<'_, sqlx::SqlitePool>,
    task_id: String,
) -> CmdResult<serde_json::Value> {
    // 查出大任务（标题 + 备注作为拆解输入）
    let row = match sqlx::query("SELECT * FROM tasks WHERE id = $1")
        .bind(&task_id)
        .fetch_optional(pool.inner())
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(
                serde_json::json!({ "ok": false, "message": format!("查询任务失败: {}", e) }),
            )
        }
    };
    let task = match row.as_ref().map(row_to_task) {
        Some(t) => t,
        None => return Ok(serde_json::json!({ "ok": false, "message": "任务不存在" })),
    };

    let provider = match build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    };

    let now = now();
    let prompt_tpl = load_prompt(
        pool.inner(),
        "ai_prompt_breakdown_task",
        DEFAULT_PROMPT_BREAKDOWN_TASK,
    )
    .await;
    let system_prompt = format!("{}\n\n当前时间：{}", prompt_tpl, now);

    // 定义 breakdown_task 工具（返回子任务数组）
    let breakdown_tool = ToolDef {
        name: "breakdown_task".into(),
        description: "把用户的大任务拆解成多个可执行的子任务时调用此工具。返回一个子任务数组"
            .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "subtasks": {
                    "type": "array",
                    "description": "拆解出的子任务列表（3-8 个），按执行先后顺序排列",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "子任务标题（简洁明确的动作短语）"
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
                                "description": "子任务执行说明（HTML 的 <p> 标签）。简短说明具体要做什么"
                            }
                        },
                        "required": ["title"]
                    }
                }
            },
            "required": ["subtasks"]
        }),
    };

    // 组装给模型的输入：任务标题 + 备注（如有）
    let user_content = if task.note.trim().is_empty() {
        format!("请拆解这个任务：{}", task.title)
    } else {
        format!("请拆解这个任务：{}\n\n任务详情：{}", task.title, task.note)
    };

    let req = ChatRequest {
        messages: vec![
            ChatMessage::system {
                content: system_prompt,
            },
            ChatMessage::user {
                content: user_content,
            },
        ],
        tools: vec![breakdown_tool],
        // 用 Auto 而非 Required：部分兼容协议的模型（如 MiniMax 经 Anthropic 协议）
        // 不支持强制工具调用，Auto 兼容性最好。提示词已明确要求调用工具。
        tool_choice: ToolChoice::Auto,
        ..Default::default()
    };

    match provider.chat(&req).await {
        Ok(resp) => {
            // 优先从 tool_calls 解析（标准路径）
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
                // 兜底：部分模型不返回 tool_calls，而是把 JSON 放在 content 文本里
                parse_subtasks_from_content(&resp.content)
            };

            if subtasks.is_empty() {
                return Ok(serde_json::json!({
                    "ok": false,
                    "message": "AI 未能拆解出子任务，请尝试更具体的任务描述"
                }));
            }
            Ok(serde_json::json!({ "ok": true, "subtasks": subtasks }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": format!("{}", e) })),
    }
}
