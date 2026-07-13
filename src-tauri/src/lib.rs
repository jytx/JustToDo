// JustToDo — Tauri 后端入口
// 文档：https://v2.tauri.app/develop/calling-rust/

mod commands;
mod db;
mod models;

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

            // 后台定时检查重复任务实例（启动时立即检查一次，之后每小时检查）
            // 适配 macOS 长时间不关应用的使用习惯，跨午夜也能生成新实例
            {
                let pool_clone = pool.clone();
                tauri::async_runtime::spawn(async move {
                    let mut first = true;
                    loop {
                        match commands::task_generate_recurring_inner(&pool_clone).await {
                            Ok(n) => {
                                if n > 0 {
                                    println!("[JustToDo] 生成了 {} 个重复任务实例", n);
                                }
                            }
                            Err(e) => println!("[JustToDo] 生成重复任务失败: {}", e),
                        }
                        // 启动时立即执行（上面已跑），之后每 1 小时检查一次
                        if first {
                            first = false;
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
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
