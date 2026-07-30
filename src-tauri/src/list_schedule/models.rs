// 清单生成计划 —— 数据模型
// 设计依据：discuss/2026-07-30-list-schedule-design.md

use serde::{Deserialize, Serialize};

/// 清单生成计划 —— 用户配置的"自动建清单"规则
///
/// 每条计划 = 路径模板 + 频率 + 颜色。
/// 后台 tick 命中频率时，渲染路径模板并逐级创建目录/清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSchedule {
    pub id: String,
    /// 计划名称，如"每日工作清单"
    pub name: String,
    /// 路径模板，如 "工作/日志/{{YYYY}}/{{MM}}/{{YYYY-MM-DD}}"
    pub path_template: String,
    /// 频率：daily / weekly / monthly / yearly / workday
    pub freq: String,
    /// 生成项类型：folder=目录 / list=清单（与频率解耦，由用户显式指定）
    pub leaf_type: String,
    /// 生成清单的颜色
    pub color: String,
    /// 是否启用
    pub enabled: bool,
    /// 显示排序
    pub position: i64,
    /// 创建时间字面量
    pub created_at: String,
}

/// 新建计划入参（前端 camelCase，serde 自动转 snake_case）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduleInput {
    pub name: String,
    pub path_template: String,
    pub freq: String,
    /// 生成项类型：folder=目录 / list=清单
    pub leaf_type: String,
    pub color: String,
}

/// 更新计划入参（所有字段可选）
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScheduleInput {
    pub name: Option<String>,
    pub path_template: Option<String>,
    pub freq: Option<String>,
    pub leaf_type: Option<String>,
    pub color: Option<String>,
    pub enabled: Option<bool>,
}

/// 节假日缓存条目（对应 holidays 表一行）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Holiday {
    /// YYYY-MM-DD
    pub date: String,
    pub year: i32,
    /// true=放假，false=调休补班
    pub is_off_day: bool,
    /// 节假日名称，如"元旦"
    pub name: Option<String>,
}

/// 预览结果：某条计划在指定日期的模拟运行结果（不实际创建）
#[derive(Debug, Clone, Serialize)]
pub struct SchedulePreview {
    /// 计划名称
    pub name: String,
    /// 频率
    pub freq: String,
    /// 该日是否命中（是否会被生成）
    pub hit: bool,
    /// 渲染后的完整路径
    pub path: String,
    /// 最末段是否为目录
    pub is_folder: bool,
}

// ─── holiday-cn 接口返回结构（仅取需要的字段）──────────────

/// holiday-cn 单日数据
#[derive(Debug, Deserialize)]
pub struct HolidayCnDay {
    pub date: String,
    // JSON 原始字段为 camelCase 的 isOffDay，需 rename 对齐
    #[serde(rename = "isOffDay")]
    pub is_off_day: bool,
    pub name: String,
}

/// holiday-cn 年度数据
#[derive(Debug, Deserialize)]
pub struct HolidayCnYear {
    // year 字段为接口返回的一部分，保留以保证数据模型完整（反序列化需要）
    #[allow(dead_code)]
    pub year: i32,
    pub days: Vec<HolidayCnDay>,
}
