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

/// 任务附件元数据（文件实体存附件目录，这里只存元信息）
/// 与 ChecklistItem 一样作为 JSON 数组存在 tasks.attachments 列
///
/// 字段命名：serde rename_all = "camelCase"，使 JSON 字段与前端 TS 接口
/// 直接对应（originalName / storedName / createdAt）。
/// 附件是前端构造、前端消费的元数据（Rust 仅做存取），全程 camelCase
/// 最省转换；区别于 Task 等历史结构保持 snake_case 的惯例。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// 附件唯一 ID（UUID，与文件名中的 UUID 一致）
    pub id: String,
    /// 用户原始文件名（如 "需求文档.md"）
    pub original_name: String,
    /// 落盘后的文件名（UUID.ext，如 "a3f5...c1.md"）
    pub stored_name: String,
    /// MIME 类型（如 "text/markdown"、"video/mp4"），未知则 "application/octet-stream"
    pub mime: String,
    /// 文件大小（字节）
    pub size: i64,
    /// 添加时间（本地时间字面量，与任务 created_at 同格式）
    pub created_at: String,
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
    /// 附件列表（与 note 富文本分离；migration 018 默认 "[]"）
    pub attachments: Vec<Attachment>,
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

/// 任务-标签关联条目（批量查询接口用）。
/// 扁平结构：一条记录 = 一个任务的一个标签关联。
/// 前端拿到后按 task_id 分组成 taskId → Tag[] 映射。
/// 注意：字段命名带 tag_ 前缀，避免与 task 自身字段歧义；
/// Tauri 序列化保持 snake_case，前端对应同名字段读取。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskTagLink {
    pub task_id: String,
    pub tag_id: String,
    pub tag_name: String,
    pub tag_created_at: String,
    pub tag_position: i64,
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
    /// 附件列表（整组覆盖；前端负责构造完整数组）
    pub attachments: Option<Vec<Attachment>>,
}
