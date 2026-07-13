// 数据模型 —— 与前端 TS 类型一一对应
// snake_case 字段由 serde 自动序列化为 JSON，前端直接用

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub note: String,
    pub list_id: String,
    pub parent_id: Option<String>,
    pub priority: i32,
    pub due_start_at: Option<String>,
    pub due_end_at: Option<String>,
    pub done: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub recurrence_freq: Option<String>,
    pub recurrence_interval: i32,
    pub recurrence_end_at: Option<String>,
    pub recurrence_count: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskList {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub created_at: String,
    pub parent_id: Option<String>,
    pub is_folder: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

/// 创建任务的参数
#[derive(Debug, Deserialize)]
pub struct CreateTaskInput {
    pub title: String,
    pub list_id: String,
    pub parent_id: Option<String>,
    pub priority: Option<i32>,
    pub due_start_at: Option<String>,
    pub due_end_at: Option<String>,
    pub recurrence_freq: Option<String>,
    pub recurrence_interval: Option<i32>,
    pub recurrence_end_at: Option<String>,
    pub recurrence_count: Option<i32>,
}

/// 更新任务的参数（所有字段可选）
#[derive(Debug, Deserialize)]
pub struct UpdateTaskInput {
    pub title: Option<String>,
    pub note: Option<String>,
    pub priority: Option<i32>,
    pub due_start_at: Option<String>,
    pub due_end_at: Option<String>,
    pub list_id: Option<String>,
    pub recurrence_freq: Option<Option<String>>,
    pub recurrence_interval: Option<i32>,
    pub recurrence_end_at: Option<Option<String>>,
    pub recurrence_count: Option<Option<i32>>,
}
