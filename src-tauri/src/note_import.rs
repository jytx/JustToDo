// 笔记导入 —— 读取待导入的本地文本文件（md/markdown/txt）
//
// 仅负责安全读取与格式校验（扩展名白名单 + 大小上限），
// Markdown → HTML 的转换在前端完成（marked，与富文本粘贴同一路径），
// 避免在 Rust 侧引入 Markdown 解析依赖。
// 纯函数式实现：不持有全局状态，路径来自前端系统文件选择器（用户显式选择）。

use std::path::Path;

/// 支持导入的扩展名白名单（小写比较，与前端文件选择器 filters 保持一致）
const ALLOWED_EXTS: [&str; 3] = ["md", "markdown", "txt"];

/// 单文件大小上限（与 read_attachment_text 一致；笔记正文为 HTML 字符串入库，不宜过大）
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024;

/// 读取结果：文件名（去扩展名，作笔记标题）+ 文件原文
#[derive(serde::Serialize)]
pub struct ImportedTextFile {
    pub title: String,
    pub content: String,
}

/// 读取本地文本文件用于导入笔记
///
/// - 扩展名不在白名单 / 文件超过 2MB / 非 UTF-8 编码（如 GBK）均返回 Err，
///   由前端逐文件 catch 后汇总提示，不中断批量导入
#[tauri::command]
pub async fn read_import_text(path: String) -> Result<ImportedTextFile, String> {
    let p = Path::new(&path);

    // 扩展名白名单校验（统一小写比较，兼容 .MD/.Txt 等大写扩展名）
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    match ext.as_deref() {
        Some(e) if ALLOWED_EXTS.contains(&e) => {}
        _ => return Err(format!("仅支持导入 {} 文件", ALLOWED_EXTS.join("/"))),
    }

    // 大小上限：先用 metadata 判断，避免大文件整读进内存
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败: {}", e))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("文件超过 2MB，暂不支持导入".to_string());
    }

    // 读取全文：read_to_string 要求 UTF-8，GBK 等编码会报错，
    // 改写为友好提示（后续版本可考虑 encoding_rs 自动检测转换）
    let content = std::fs::read_to_string(&path)
        .map_err(|_| "读取文件内容失败（文件可能不是 UTF-8 编码）".to_string())?;

    // 文件名去扩展名作为笔记标题；取不到时兜底「未命名」
    let title = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .to_string();

    Ok(ImportedTextFile { title, content })
}
