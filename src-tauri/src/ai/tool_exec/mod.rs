// AI Agent 工具执行器 —— 按名称分发到具体实现
//
// 约定（与 agent.rs / tools.rs 配合）：
// - 返回统一形态：成功 { ok:true, summary:"一句话结果", data:... }；失败 { ok:false, error:"原因" }
//   summary 供前端工具卡直接展示；error 回传给模型自行纠正（不中断会话）
// - 名称 → ID 在本层解析（list_name/tag_name 等），找不到返回明确错误
//
// 文件组织：mod.rs 分发 + 通用辅助；read.rs 只读工具；write.rs 写工具（P2）

pub mod read;

use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

use crate::ai::commands::priority_label;

/// 工具入口：按名称分发。未知工具返回错误 JSON（agent 循环不中断）。
pub async fn execute(pool: &SqlitePool, name: &str, args: &Value) -> Value {
    match name {
        "query_tasks" | "search_items" | "get_task" | "list_folders" | "get_stats" => {
            read::dispatch(pool, name, args).await
        }
        _ => json!({ "ok": false, "error": format!("未知工具: {}", name) }),
    }
}

// ─── 动态 WHERE 构造（位置参数 + 类型化绑定）──────────────────

/// 绑定参数（SQLite TEXT 与 INTEGER 必须区分绑定，否则等值比较失效）
pub(crate) enum Param {
    Text(String),
    Int(i64),
}

/// 动态条件构造器：clauses 为 "col = $N" 片段，params 按序绑定
pub(crate) struct WhereBuilder {
    clauses: Vec<String>,
    params: Vec<Param>,
}

impl WhereBuilder {
    pub(crate) fn new() -> Self {
        WhereBuilder { clauses: vec![], params: vec![] }
    }

    /// 追加一个条件并绑定参数（clause 中用 {} 占位）
    pub(crate) fn add(&mut self, clause: &str, param: Param) {
        self.params.push(param);
        let n = self.params.len();
        self.clauses.push(clause.replace("{}", &format!("${}", n)));
    }

    pub(crate) fn add_raw(&mut self, clause: &str) {
        self.clauses.push(clause.to_string());
    }

    fn sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.clauses.join(" AND "))
        }
    }

    /// 绑定到查询并执行（返回全部行，调用方控制 LIMIT）
    pub(crate) async fn fetch(
        self,
        pool: &SqlitePool,
        base: &str,
    ) -> Result<Vec<sqlx::sqlite::SqliteRow>, String> {
        let sql = format!("{}{}", base, self.sql());
        let mut q = sqlx::query(&sql);
        for p in &self.params {
            q = match p {
                Param::Text(s) => q.bind(s),
                Param::Int(i) => q.bind(i),
            };
        }
        q.fetch_all(pool).await.map_err(|e| format!("查询失败: {}", e))
    }
}

/// 任务行 → 给模型的精简 JSON（省 token：只留决策需要的字段）
pub(crate) fn row_to_brief(row: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": row.try_get::<String, _>("id").unwrap_or_default(),
        "标题": row.try_get::<String, _>("title").unwrap_or_default(),
        "状态": if row.try_get::<i64, _>("done").unwrap_or(0) == 1 { "已完成" } else { "未完成" },
        "优先级": priority_label(row.try_get::<i64, _>("priority").unwrap_or(0) as i32),
        "截止": row.try_get::<Option<String>, _>("due_end_at").ok().flatten(),
        "清单": row.try_get::<Option<String>, _>("list_name").ok().flatten(),
    })
}

/// 把 list_name 解析为 list id（精确优先，其次包含匹配）
pub(crate) async fn resolve_list_id(
    pool: &SqlitePool,
    name: &str,
    kind: &str,
) -> Result<Option<String>, String> {
    let exact: Option<String> = sqlx::query_scalar(
        "SELECT id FROM lists WHERE name = $1 AND kind = $2 AND is_folder = 0 LIMIT 1",
    )
    .bind(name)
    .bind(kind)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("查询清单失败: {}", e))?;
    if exact.is_some() {
        return Ok(exact);
    }
    sqlx::query_scalar(
        "SELECT id FROM lists WHERE name LIKE $1 AND kind = $2 AND is_folder = 0 LIMIT 1",
    )
    .bind(format!("%{}%", name))
    .bind(kind)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("查询清单失败: {}", e))
}
