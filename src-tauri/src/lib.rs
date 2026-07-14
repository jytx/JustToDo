// JustToDo — Tauri 后端入口
// 文档：https://v2.tauri.app/develop/calling-rust/

mod commands;
mod db;
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
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 获取 app data 目录，在其中创建数据库
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("无法获取 app data 目录");
            std::fs::create_dir_all(&app_data_dir).expect("无法创建 app data 目录");

            let db_path = app_data_dir.join("justtodo.db");
            let db_url = format!("sqlite://{}", db_path.display());
            println!("[JustToDo] 数据库路径: {}", db_path.display());

            // 初始化数据库连接池（同步阻塞，确保 setup 完成后 pool 就绪）
            let pool = tauri::async_runtime::block_on(async {
                db::init_pool(&db_url).await
            })
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

            app.manage(pool);

            // 清空窗口标题，避免 macOS Overlay 模式下显示 "JustToDo" 文字
            // （titleBarStyle: Overlay 下，标题文字依然会浮在左上角）
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
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
            commands::test_notify,
            commands::get_setting,
            commands::set_setting,
            commands::tag_get_all,
            commands::tag_create,
            commands::tag_set_sort_pref,
            commands::tag_get_sort_pref,
            commands::tag_delete,
            commands::tag_rename,
            commands::search_tasks,
            commands::habit_get_all,
            commands::habit_create,
            commands::habit_delete,
            commands::habit_toggle_check,
            commands::habit_get_logs,
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
    {
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new("JustToDo".to_string())
                .start_socket_server(true)
                .socket_path(std::path::PathBuf::from("/tmp/tauri-mcp.sock")),
        ));
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
