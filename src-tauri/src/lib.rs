// JustToDo — Tauri 后端入口
// 文档：https://v2.tauri.app/develop/calling-rust/

mod commands;
mod db;
mod menu;
mod models;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Manager;

/// IPC 连通性测试命令
#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 获取 app data 目录，在其中创建数据库
            let app_data_dir = app.path().app_data_dir().expect("无法获取 app data 目录");
            std::fs::create_dir_all(&app_data_dir).expect("无法创建 app data 目录");

            let db_path = app_data_dir.join("justtodo.db");
            let db_url = format!("sqlite://{}", db_path.display());
            println!("[JustToDo] 数据库路径: {}", db_path.display());

            // 初始化数据库连接池（同步阻塞，确保 setup 完成后 pool 就绪）
            let pool = tauri::async_runtime::block_on(async { db::init_pool(&db_url).await })
                .expect("数据库初始化失败");

            // 后台定时检查重复任务实例
            // 间隔由 app_settings.recurrence_check_interval 控制（分钟），可在设置页修改
            // Arc<AtomicU64> 在前后台共享，set_setting 修改时同步更新
            let check_interval_secs = {
                // 从数据库读初始值（单位：分钟 → 秒），失败默认 60 秒（1 分钟）
                // 提醒精度为分钟级，1 分钟扫描一次足够
                let mins = tauri::async_runtime::block_on(async {
                    commands::get_setting_inner(&pool, "recurrence_check_interval".to_string())
                        .await
                        .ok()
                        .flatten()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(1)
                });
                Arc::new(AtomicU64::new(mins * 60))
            };
            app.manage(check_interval_secs.clone());

            {
                let pool_clone = pool.clone();
                let interval_clone = check_interval_secs.clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // 启动时立刻跑一次提醒扫描（补发过去 24h 内的过期提醒）
                    use tauri_plugin_notification::NotificationExt;
                    match commands::task_check_reminders_inner(&pool_clone, |reminder| {
                        let res = app_handle
                            .notification()
                            .builder()
                            .title(&reminder.title)
                            .body(&reminder.body)
                            .show();
                        if let Err(e) = res {
                            eprintln!("[JustToDo] 启动补发通知失败：{}", e);
                        }
                    })
                    .await
                    {
                        Ok(n) if n > 0 => println!("[JustToDo] 启动补发了 {} 条提醒", n),
                        Ok(_) => {}
                        Err(e) => println!("[JustToDo] 启动扫描提醒失败: {}", e),
                    }

                    loop {
                        match commands::task_generate_recurring_inner(&pool_clone).await {
                            Ok(n) => {
                                if n > 0 {
                                    println!("[JustToDo] 生成了 {} 个重复任务实例", n);
                                }
                            }
                            Err(e) => println!("[JustToDo] 生成重复任务失败: {}", e),
                        }
                        // 同一轮内复用 app_handle 做提醒扫描
                        match commands::task_check_reminders_inner(&pool_clone, |reminder| {
                            let res = app_handle
                                .notification()
                                .builder()
                                .title(&reminder.title)
                                .body(&reminder.body)
                                .show();
                            if let Err(e) = res {
                                eprintln!("[JustToDo] 通知失败：{}", e);
                            }
                        })
                        .await
                        {
                            Ok(n) if n > 0 => println!("[JustToDo] 触发了 {} 条提醒", n),
                            Ok(_) => {}
                            Err(e) => println!("[JustToDo] 扫描提醒失败: {}", e),
                        }
                        // 读当前间隔（秒）
                        let secs = interval_clone.load(Ordering::Relaxed);
                        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                    }
                });
            }

            app.manage(pool.clone());

            // 当前 zoom 级别的内存缓存（WebviewWindow 无 zoom getter，用 State 记录）
            let current_zoom = Arc::new(std::sync::Mutex::new(1.0_f64));

            // 清空窗口标题，避免 macOS Overlay 模式下显示 "JustToDo" 文字
            // （titleBarStyle: Overlay 下，标题文字依然会浮在左上角）
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("");

                // 修正最大化窗口偏右问题：把窗口左上角钉到 (0, 0)
                use tauri::PhysicalPosition;
                let _ = window.set_position(PhysicalPosition::new(0, 0));

                // 挂载原生菜单（视图 → 放大/缩小/实际大小）
                // macOS：显示在屏幕顶端系统菜单栏（需 app 级菜单）
                // Windows：显示在窗口标题栏下方（window 级菜单）
                // 两边都设置，确保跨平台都能显示
                match menu::build_main_menu(app.handle()) {
                    Ok(main_menu) => {
                        // macOS 关键：设为 app 级菜单才会出现在系统菜单栏
                        let app_handle = app.handle();
                        match app_handle.set_menu(main_menu) {
                            Ok(_) => println!("[JustToDo] app 级菜单挂载成功"),
                            Err(e) => eprintln!("[JustToDo] app set_menu 失败: {}", e),
                        }
                        // Windows：再给窗口单独设一份（app 级在 Windows 上不自动应用到窗口）
                        match menu::build_main_menu(app.handle()) {
                            Ok(win_menu) => {
                                if let Err(e) = window.set_menu(win_menu) {
                                    eprintln!("[JustToDo] window set_menu 失败: {}", e);
                                } else {
                                    println!("[JustToDo] window 级菜单挂载成功");
                                }
                            }
                            Err(e) => eprintln!("[JustToDo] 构造窗口菜单失败: {}", e),
                        }
                    }
                    Err(e) => eprintln!("[JustToDo] 构造菜单失败: {}", e),
                }

                // 启动时恢复持久化的缩放级别
                let restored_zoom = tauri::async_runtime::block_on(async {
                    commands::get_setting_inner(&pool, "zoom_level".to_string())
                        .await
                        .ok()
                        .flatten()
                        .and_then(|v| v.parse::<f64>().ok())
                        .map(menu::clamp_zoom)
                        .unwrap_or(1.0)
                });
                let _ = window.set_zoom(restored_zoom);
                *current_zoom.lock().unwrap() = restored_zoom;
            }

            app.manage(current_zoom.clone());

            Ok(())
        })
        .on_menu_event(|app, event| {
            // 自定义窗口居中
            if menu::is_window_op_event(&event) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.center();
                }
                return;
            }

            // 帮助 → 切换控制台（DevTools）
            if menu::is_help_event(&event) {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
                return;
            }

            // 仅处理缩放菜单项，其他（PredefinedMenuItem）由系统自行处理
            if !menu::is_zoom_event(&event) {
                return;
            }
            let current = app
                .try_state::<std::sync::Arc<std::sync::Mutex<f64>>>()
                .map(|s| *s.lock().unwrap())
                .unwrap_or(1.0);
            let next = match event.id().as_ref() {
                menu::ZOOM_IN_ID => current * menu::ZOOM_STEP,
                menu::ZOOM_OUT_ID => current / menu::ZOOM_STEP,
                menu::ZOOM_RESET_ID => 1.0,
                _ => return,
            };
            if let Err(e) = menu::apply_zoom(app, next) {
                eprintln!("[JustToDo] 应用 zoom 失败: {}", e);
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            menu::zoom_in,
            menu::zoom_out,
            menu::zoom_reset,
            commands::list_get_all,
            commands::list_create,
            commands::list_delete,
            commands::list_rename,
            commands::list_move,
            commands::list_reorder,
            commands::list_set_sort_pref,
            commands::list_get_sort_pref,
            commands::task_count_by_list,
            commands::task_count_by_tag,
            commands::task_count_smart_view,
            commands::task_get_by_list,
            commands::task_get_by_due_range,
            commands::task_get_smart_view,
            commands::task_create,
            commands::task_update,
            commands::task_toggle,
            commands::task_reorder,
            commands::task_delete,
            commands::task_get_by_id,
            commands::task_get_subtasks,
            commands::task_generate_recurring,
            commands::task_check_reminders,
            commands::get_setting,
            commands::set_setting,
            commands::tag_get_all,
            commands::tag_create,
            commands::tag_set_sort_pref,
            commands::tag_get_sort_pref,
            commands::tag_delete,
            commands::tag_rename,
            commands::tag_reorder,
            commands::search_tasks,
            commands::habit_get_all,
            commands::habit_create,
            commands::habit_update,
            commands::habit_delete,
            commands::habit_toggle_check,
            commands::habit_get_logs,
            commands::habit_reorder,
            commands::get_attachment_path,
            commands::set_attachment_dir,
            commands::save_image,
            commands::get_attachment_fullpath,
            commands::task_get_tags,
            commands::task_add_tag,
            commands::task_remove_tag,
            commands::task_get_by_tag,
        ]);

    // 仅在开发模式下启用 MCP 插件（用于 AI 辅助 GUI 测试，不影响 release 构建）
    #[cfg(dev)]
    let builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("JustToDo".to_string())
            .start_socket_server(true)
            .socket_path(std::path::PathBuf::from("/tmp/tauri-mcp.sock")),
    ));

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
