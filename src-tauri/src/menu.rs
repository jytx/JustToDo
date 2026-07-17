// 原生应用菜单 + 窗口缩放逻辑
//
// 跨平台原生菜单（Windows 显示在窗口标题栏下方，macOS 显示在屏幕顶端系统菜单栏）。
// 「视图」菜单含：放大 / 缩小 / 实际大小。
//
// 缩放的实际驱动在 Rust 端完成（window.set_zoom），前端按钮/快捷键通过 invoke 调用命令。

use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::menu::MenuEvent;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// 自定义菜单项 id —— on_menu_event 中据此分发
pub const ZOOM_IN_ID: &str = "zoom_in";
pub const ZOOM_OUT_ID: &str = "zoom_out";
pub const ZOOM_RESET_ID: &str = "zoom_reset";
/// 窗口居中（Tauri 无预定义项，用自定义 MenuItem + window.center() 实现）
pub const WINDOW_CENTER_ID: &str = "window_center";
/// 切换开发者工具（控制台）
pub const HELP_TOGGLE_DEVTOOLS_ID: &str = "help_toggle_devtools";

/// 缩放步长与上下限（与浏览器一致）
pub const ZOOM_STEP: f64 = 1.2;
pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 2.0;

/// 判断某个菜单事件是否是缩放(webview zoom)相关项
pub fn is_zoom_event(event: &MenuEvent) -> bool {
    matches!(
        event.id().as_ref(),
        ZOOM_IN_ID | ZOOM_OUT_ID | ZOOM_RESET_ID
    )
}

/// 判断某个菜单事件是否是自定义窗口操作项（如居中）
pub fn is_window_op_event(event: &MenuEvent) -> bool {
    matches!(event.id().as_ref(), WINDOW_CENTER_ID)
}

/// 判断某个菜单事件是否是帮助类自定义项（如切换控制台）
pub fn is_help_event(event: &MenuEvent) -> bool {
    matches!(event.id().as_ref(), HELP_TOGGLE_DEVTOOLS_ID)
}

// ─── 原生菜单构造 ────────────────────────────────────────────
//
// 用 Submenu::new + append 方式构造，比 with_items 更稳妥，
// 不依赖局部变量的生命周期。

/// 构造「应用」子菜单（macOS 必需，Windows 上无害）
fn build_app_submenu(app: &AppHandle<Wry>) -> tauri::Result<Submenu<Wry>> {
    let about_meta = AboutMetadata {
        name: Some("JustToDo".to_string()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let sub = Submenu::new(app, "JustToDo", true)?;
    sub.append(&PredefinedMenuItem::about(app, Some("关于 JustToDo"), Some(about_meta))?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&PredefinedMenuItem::services(app, Some("服务"))?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&PredefinedMenuItem::hide(app, Some("隐藏 JustToDo"))?)?;
    sub.append(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&PredefinedMenuItem::quit(app, Some("退出 JustToDo"))?)?;
    Ok(sub)
}

/// 构造「编辑」子菜单（保留 Undo/复制粘贴等原生能力）
fn build_edit_submenu(app: &AppHandle<Wry>) -> tauri::Result<Submenu<Wry>> {
    let sub = Submenu::new(app, "编辑", true)?;
    sub.append(&PredefinedMenuItem::undo(app, Some("撤销"))?)?;
    sub.append(&PredefinedMenuItem::redo(app, Some("重做"))?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&PredefinedMenuItem::cut(app, Some("剪切"))?)?;
    sub.append(&PredefinedMenuItem::copy(app, Some("复制"))?)?;
    sub.append(&PredefinedMenuItem::paste(app, Some("粘贴"))?)?;
    sub.append(&PredefinedMenuItem::select_all(app, Some("全选"))?)?;
    Ok(sub)
}

/// 构造「视图」子菜单（本功能核心：缩放）
fn build_view_submenu(app: &AppHandle<Wry>) -> tauri::Result<Submenu<Wry>> {
    let sub = Submenu::new(app, "视图", true)?;
    sub.append(&MenuItem::with_id(
        app, ZOOM_IN_ID, "放大", true, Some("CmdOrCtrl+Plus"),
    )?)?;
    sub.append(&MenuItem::with_id(
        app, ZOOM_OUT_ID, "缩小", true, Some("CmdOrCtrl+Minus"),
    )?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&MenuItem::with_id(
        app, ZOOM_RESET_ID, "实际大小", true, Some("CmdOrCtrl+Zero"),
    )?)?;
    Ok(sub)
}

/// 构造「窗口」子菜单（窗口控制操作）
fn build_window_submenu(app: &AppHandle<Wry>) -> tauri::Result<Submenu<Wry>> {
    let sub = Submenu::new(app, "窗口", true)?;
    // 最小化
    sub.append(&PredefinedMenuItem::minimize(app, Some("最小化"))?)?;
    // 最大化/还原（Windows 标题栏图标系统菜单里的 "Zoom" 即此项）
    sub.append(&PredefinedMenuItem::maximize(app, Some("缩放"))?)?;
    // 全屏
    sub.append(&PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    // 居中（Tauri 无预定义项，自定义实现）
    sub.append(&MenuItem::with_id(
        app, WINDOW_CENTER_ID, "居中", true, None::<&str>,
    )?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    // 关闭窗口
    sub.append(&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?)?;
    Ok(sub)
}

/// 构造「帮助」子菜单
fn build_help_submenu(app: &AppHandle<Wry>) -> tauri::Result<Submenu<Wry>> {
    let sub = Submenu::new(app, "帮助", true)?;
    // 切换开发者工具（控制台）—— 调试用，点击后打开/关闭 webview DevTools
    sub.append(&MenuItem::with_id(
        app, HELP_TOGGLE_DEVTOOLS_ID, "切换控制台", true, Some("F12"),
    )?)?;
    Ok(sub)
}

/// 构造完整主菜单树
pub fn build_main_menu(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&build_app_submenu(app)?)?;
    menu.append(&build_edit_submenu(app)?)?;
    menu.append(&build_view_submenu(app)?)?;
    menu.append(&build_window_submenu(app)?)?;
    menu.append(&build_help_submenu(app)?)?;
    Ok(menu)
}

// ─── 缩放逻辑 ────────────────────────────────────────────

/// 把任意缩放值钳制到 [ZOOM_MIN, ZOOM_MAX]，保留两位小数避免浮点漂移
pub fn clamp_zoom(v: f64) -> f64 {
    let clamped = v.clamp(ZOOM_MIN, ZOOM_MAX);
    (clamped * 100.0).round() / 100.0
}

/// 统一的 zoom 应用入口：设置窗口缩放 + 更新内存缓存 + 持久化 + 通知前端
///
/// 所有缩放操作（命令、快捷键）最终都落到这里。
pub fn apply_zoom(app: &AppHandle, next: f64) -> tauri::Result<f64> {
    let clamped = clamp_zoom(next);

    // 1. 应用到窗口
    if let Some(window) = app.get_webview_window("main") {
        window.set_zoom(clamped)?;
    }

    // 2. 更新内存缓存
    if let Some(state) = app.try_state::<std::sync::Arc<std::sync::Mutex<f64>>>() {
        *state.lock().unwrap() = clamped;
    }

    // 3. 持久化（后台异步，失败仅打日志）
    let app_clone = app.clone();
    let value_str = clamped.to_string();
    tauri::async_runtime::spawn(async move {
        if let Some(pool) = app_clone.try_state::<sqlx::SqlitePool>() {
            let sql = "INSERT INTO app_settings (key, value) VALUES ($1, $2)
                       ON CONFLICT(key) DO UPDATE SET value = $2";
            if let Err(e) = sqlx::query(sql)
                .bind("zoom_level")
                .bind(&value_str)
                .execute(pool.inner())
                .await
            {
                eprintln!("[JustToDo] 持久化 zoom_level 失败: {}", e);
            }
        }
    });

    // 4. 通知前端同步状态
    let _ = app.emit("zoom-changed", clamped);

    Ok(clamped)
}

/// 读取当前缓存的 zoom 值（无缓存时返回默认 1.0）
fn current_zoom(app: &AppHandle) -> f64 {
    app.try_state::<std::sync::Arc<std::sync::Mutex<f64>>>()
        .map(|s| *s.lock().unwrap())
        .unwrap_or(1.0)
}

/// Tauri 命令：放大（前端按钮/快捷键调用）
#[tauri::command]
pub fn zoom_in(app: AppHandle) -> Result<f64, String> {
    apply_zoom(&app, current_zoom(&app) * ZOOM_STEP).map_err(|e| e.to_string())
}

/// Tauri 命令：缩小
#[tauri::command]
pub fn zoom_out(app: AppHandle) -> Result<f64, String> {
    apply_zoom(&app, current_zoom(&app) / ZOOM_STEP).map_err(|e| e.to_string())
}

/// Tauri 命令：恢复 100%
#[tauri::command]
pub fn zoom_reset(app: AppHandle) -> Result<f64, String> {
    apply_zoom(&app, 1.0).map_err(|e| e.to_string())
}
