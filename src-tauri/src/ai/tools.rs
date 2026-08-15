// AI Agent 应用内工具 —— schema 注册表
//
// 原则（详见 discuss/2026-08-15-ai-agent-design.md §4.2）：
// - 工具入参用「名称」不用内部 ID（执行器负责名称→ID 解析，失败回传让模型自纠）
// - 日期支持相对词枚举（today/tomorrow/...）与绝对 YYYY-MM-DD，执行器统一解析
// - 第一版 9 个工具：5 读 + 4 写；不提供删除类工具
//
// 本文件只定义 schema（给模型看的说明），执行逻辑在 tool_exec.rs。

use crate::ai::types::ToolDef;

/// 全部工具定义（P1 先注册只读 5 个；P2 追加写工具）
pub fn tool_defs() -> Vec<ToolDef> {
    vec![
        query_tasks_def(),
        search_items_def(),
        get_task_def(),
        list_folders_def(),
        get_stats_def(),
    ]
}

fn query_tasks_def() -> ToolDef {
    ToolDef {
        name: "query_tasks".into(),
        description: "按条件查询任务或笔记列表（结构化查询，适合「今天有什么任务」「某清单里逾期的高优任务」类问题）".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "list_name": { "type": "string", "description": "清单或笔记本名称（精确或包含匹配）；省略表示所有清单" },
                "status": { "type": "string", "enum": ["undone", "done", "all"], "description": "完成状态，默认 undone（未完成）" },
                "due": { "type": "string", "enum": ["today", "tomorrow", "this_week", "overdue", "no_date", "has_date"], "description": "截止时间过滤：today=今天到期，overdue=已逾期，no_date=无截止日期；省略表示不限" },
                "priority": { "type": "integer", "enum": [0, 1, 2, 3], "description": "优先级过滤：0=无 1=低 2=中 3=高；省略表示不限" },
                "tag_name": { "type": "string", "description": "标签名过滤；省略表示不限" },
                "kind": { "type": "string", "enum": ["task", "note"], "description": "实体类型，默认 task（任务）" },
                "limit": { "type": "integer", "description": "返回条数上限，默认 50" }
            }
        }),
    }
}

fn search_items_def() -> ToolDef {
    ToolDef {
        name: "search_items".into(),
        description: "按关键词搜索任务/笔记的标题（模糊匹配，适合「帮我找一下关于XX的任务」）"
            .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "搜索关键词" },
                "kind": { "type": "string", "enum": ["task", "note"], "description": "实体类型，默认 task" },
                "limit": { "type": "integer", "description": "返回条数上限，默认 20" }
            },
            "required": ["query"]
        }),
    }
}

fn get_task_def() -> ToolDef {
    ToolDef {
        name: "get_task".into(),
        description:
            "查单个任务/笔记的详情（含子任务列表、标签、备注正文），适合需要完整信息的场景".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "task_id": { "type": "string", "description": "任务 ID（从 query_tasks/search_items 结果中获得）" },
                "title": { "type": "string", "description": "任务标题（无 ID 时可按标题精确匹配）" }
            }
        }),
    }
}

fn list_folders_def() -> ToolDef {
    ToolDef {
        name: "list_folders".into(),
        description: "列出全部清单/笔记本/目录树（含每个清单的任务数量），适合回答「我有哪些清单」「笔记在哪个本子里」".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "enum": ["task", "note"], "description": "task=清单树，note=笔记本树；省略表示全部" }
            }
        }),
    }
}

fn get_stats_def() -> ToolDef {
    ToolDef {
        name: "get_stats".into(),
        description: "查询任务完成统计（完成数/未完成数/逾期数），适合「今天完成了多少」「本周进展如何」类问题".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "range": { "type": "string", "enum": ["today", "this_week", "last_7_days"], "description": "统计时间范围，默认 today" }
            }
        }),
    }
}
