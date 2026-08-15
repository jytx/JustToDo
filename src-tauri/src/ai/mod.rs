// AI 模块入口 —— 配置读取 + Provider 构造
//
// 职责：
// 1. 从 app_settings KV 表读 AI 配置（enabled/provider/base_url/api_key/model）
// 2. 校验配置完整性后，按 provider 类型构造对应 adapter
//
// 上层 commands（如 ai_test_connection、后续各 AI 功能命令）通过
// build_from_settings(pool) 拿到一个 Box<dyn AiProvider>，直接调 chat()。
//
// 详见 discuss/2026-07-31-ai-config-design.md

pub mod agent;
pub mod agent_store;
pub mod commands;
pub mod provider;
pub mod tool_exec;
pub mod tools;
pub mod types;

use sqlx::SqlitePool;

use crate::commands::get_setting_inner;

// pub use 同时承担「内部使用」和「对外重导出」双重职责
pub use provider::{build_provider, AiError, AiProvider};
// 对外重导出统一数据结构（ChatRequest 等），供后续 AI 功能命令使用
#[allow(unused_imports)]
pub use types::*;

/// AI 配置快照（从 app_settings 读出的运行时配置）
pub struct AiConfig {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 从 app_settings 表读 AI 配置（5 个 ai_* key）
pub async fn load_config(pool: &SqlitePool) -> Result<AiConfig, AiError> {
    // 辅助：读单个 key，错误统一包成 ConfigMissing
    let get = |k: &'static str| async move {
        get_setting_inner(pool, k.into())
            .await
            .map_err(AiError::ConfigMissing)
    };

    let enabled = get("ai_enabled").await?.as_deref() == Some("true");
    let provider = get("ai_provider").await?.unwrap_or_default();
    let base_url = get("ai_base_url").await?.unwrap_or_default();
    let api_key = get("ai_api_key").await?.unwrap_or_default();
    let model = get("ai_model").await?.unwrap_or_default();

    Ok(AiConfig {
        enabled,
        provider,
        base_url,
        api_key,
        model,
    })
}

/// 读配置 + 校验 + 构造 provider（供 commands 调用）。
/// - AI 未启用 → ConfigMissing 错误
/// - base_url/api_key/model 任一为空 → ConfigMissing 错误
/// - 校验通过 → 返回对应协议的 provider
pub async fn build_from_settings(pool: &SqlitePool) -> Result<Box<dyn AiProvider>, AiError> {
    let cfg = load_config(pool).await?;
    if !cfg.enabled {
        return Err(AiError::ConfigMissing("AI 未启用，请到设置中开启".into()));
    }
    if cfg.base_url.trim().is_empty() {
        return Err(AiError::ConfigMissing("未配置 API 地址".into()));
    }
    if cfg.api_key.trim().is_empty() {
        return Err(AiError::ConfigMissing("未配置 API Key".into()));
    }
    if cfg.model.trim().is_empty() {
        return Err(AiError::ConfigMissing("未配置模型名".into()));
    }
    build_provider(&cfg.provider, &cfg.base_url, &cfg.api_key, &cfg.model)
}
