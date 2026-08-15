// AI 命令层 —— 全部 #[tauri::command]，从 commands.rs 拆出（2026-08-15 重构）
//
// 按功能分文件：
// - summary.rs    每日小结 / 周报（ai_summary）
// - scope.rs      清单/目录/多选总结（ai_summary_scope）
// - parse_task.rs 自然语言建任务多意图路由（ai_parse_task）
// - breakdown.rs  任务拆解（ai_breakdown_task）
// - extract.rs    文本提取任务（ai_extract_tasks）
// - polish.rs     文本润色（ai_polish_text）
//
// 公共辅助（load_prompt / priority_label / parse_subtasks_from_content）在本文件。
// 详见 discuss/2026-07-31-ai-config-design.md 与各分文件头注释。

pub mod breakdown;
pub mod extract;
pub mod parse_task;
pub mod polish;
pub mod scope;
pub mod summary;

use tauri::State;

use crate::commands::{get_setting_inner, CmdResult};

/// 读取自定义提示词：读 app_settings，为空或不存在则回落默认值。
pub(crate) async fn load_prompt(pool: &sqlx::SqlitePool, key: &str, default: &str) -> String {
    match get_setting_inner(pool, key.to_string()).await {
        Ok(Some(v)) if !v.trim().is_empty() => v,
        _ => default.to_string(),
    }
}

/// 优先级数字 → 中文标签（组装 prompt 用，省 token 且模型易读）
pub(crate) fn priority_label(p: i32) -> &'static str {
    match p {
        3 => "高",
        2 => "中",
        1 => "低",
        _ => "无",
    }
}

/// 从模型返回的纯文本 content 中提取 subtasks 数组。
/// 部分模型不调工具，而是把结果当 JSON 文本返回。这里做容错提取
/// （breakdown 与 extract 两个命令共用）。
pub(crate) fn parse_subtasks_from_content(content: &str) -> Vec<serde_json::Value> {
    // 尝试找到第一个 { 到最后一个 }，当作 JSON 解析
    let start = match content.find('{') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match content.rfind('}') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let json_str = &content[start..=end];
    let parsed: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    parsed
        .get("subtasks")
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
}

/// 测试 AI 连接：读配置 → 构造 provider → 发最小请求。
///
/// 返回 `serde_json::Value`（始终 Ok，错误信息放 message 字段），
/// 这样前端不会进 catch，统一按 `{ ok, message }` 渲染结果。
/// 只有真正的 IPC 错误（如 panic）才会进 Err。
#[tauri::command]
pub async fn ai_test_connection(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<serde_json::Value> {
    // 构造 provider（内部会校验 enabled / base_url / key / model 是否完整）
    let provider = match crate::ai::build_from_settings(pool.inner()).await {
        Ok(p) => p,
        Err(e) => {
            return Ok(serde_json::json!({
                "ok": false,
                "message": format!("{}", e),
            }));
        }
    };
    // 发最小请求验证连通性
    match provider.test_connection().await {
        Ok(model_name) => Ok(serde_json::json!({
            "ok": true,
            "message": format!("连接成功（模型 {}）", model_name),
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "message": format!("{}", e),
        })),
    }
}
