// 数据模型 —— 与前端 TS 类型一一对应
// snake_case 字段由 serde 自动序列化为 JSON，前端直接用

use serde::{Deserialize, Serialize};

/// 检查项（独立于 note 富文本）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChecklistItem {
    pub id: String,
    pub title: String,
    pub done: bool,
    /// 排序权重（数字小 = 排前）
    pub order: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub note: String,
    pub list_id: String,
    pub parent_id: Option<String>,
    pub priority: i32,
    /// 本地时间字面量（"YYYY-MM-DDTHH:mm:ss"，无时区标记）。
    /// 与前端 toLocalIso() / utils/date.nowLocalIso() 输出格式一致。
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
    /// 重复实例的来源模板 id（null = 普通任务或自身即模板）
    pub recurrence_origin_id: Option<String>,
    /// 提前多少分钟提醒（null = 不提醒；0 = 准点；N = 提前 N 分钟）
    pub remind_offset_minutes: Option<i32>,
    /// 通知触发时间戳（null = 还没通知过）
    pub notified_at: Option<String>,
    /// 检查项列表（与 note 富文本分离；migration 009 默认 "[]"）
    pub checklist: Vec<ChecklistItem>,
}

/// 任务模板 —— "任务参数预设"，独立于 tasks 表
/// 应用模板时由前端 taskStore.createTask + db.updateTask(note) 两步落库
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub title: String,
    /// HTML 富文本（RichTextEditor 输出）
    pub note: String,
    pub is_builtin: bool,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建模板的参数（id/时间戳由 Rust 端生成）
#[derive(Debug, Deserialize)]
pub struct CreateTemplateInput {
    pub name: String,
    pub title: String,
    pub note: String,
}

/// 更新模板的参数（所有字段可选；与 UpdateTaskInput 同模式）
#[derive(Debug, Deserialize)]
pub struct UpdateTemplateInput {
    pub name: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
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
    /// 侧边栏手动排序 key（整数间隔，新增/拖动时取相邻中点）
    pub position: i64,
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
    pub remind_offset_minutes: Option<i32>,
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
    /// Option<Option<i32>> 允许显式清空提醒（传 null）
    pub remind_offset_minutes: Option<Option<i32>>,
    /// 检查项列表（整组覆盖；前端负责构造完整数组）
    pub checklist: Option<Vec<ChecklistItem>>,
}
