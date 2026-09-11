// 原生通知模块 —— macOS UNUserNotificationCenter 带操作按钮的任务提醒通知
//
// 为什么不用 tauri-plugin-notification 发这一路：
// 它底层是 notify-rust，不支持 macOS 自定义通知按钮。这里直接用
// objc2-user-notifications 绑定 UNUserNotificationCenter：
//   - 启动时注册 category（挂「5/10 分钟后提醒」两个 action）+ delegate
//   - delegate 收按钮回调 → 按 identifier（= task id）写贪睡/打开任务
//   - willPresent 返回 Banner|Sound|List：app 在前台时通知照常弹出
//
// 关键设计：**通知 identifier 直接用 task id**
//   - 按钮回调里 request.identifier() 能精确还原是哪个任务
//   - 同一任务贪睡后再触发时 identifier 相同，系统自动替换旧通知不堆积
//
// 交互语义（与 macOS 时钟闹钟一致）：
//   - 「5分钟后提醒」/「10分钟后提醒」→ task_snooze_inner 写 snooze_until
//   - 点击通知本体（默认动作）→ 激活窗口 + emit 事件让前端打开任务详情
//   - 不理会（通知自动收起/手动划掉）→ 不再提醒（notified_at 机制，无需处理）

#[cfg(target_os = "macos")]
mod platform {
    // delegate 方法名保留 Objective-C selector 风格（与协议声明一致）
    #![allow(non_snake_case)]

    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSArray, NSObjectProtocol, NSSet, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
        UNNotificationActionOptionNone, UNNotificationCategory, UNNotificationCategoryOptionNone,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::{Emitter, Manager};

    use crate::commands;

    /// category id（挂在任务到期提醒通知上，系统据此显示两个贪睡按钮）
    const CATEGORY_TASK_REMINDER: &str = "JT_TASK_REMINDER";
    /// action id：按钮回调里区分「5 分钟后」与「10 分钟后」
    const ACTION_SNOOZE_5: &str = "JT_SNOOZE_5";
    const ACTION_SNOOZE_10: &str = "JT_SNOOZE_10";
    /// 点击通知本体的系统保留 action id（UNNotificationDefaultActionIdentifier 值）
    const DEFAULT_ACTION_ID: &str = "com.apple.UNNotificationDefaultActionIdentifier";

    /// delegate 回调上下文：pool 写贪睡、app emit 前端事件 + 激活窗口。
    /// delegate 回调发生在系统线程，用 OnceLock 全局共享（setup 时存入一次）。
    struct CallbackContext {
        app: tauri::AppHandle,
        pool: sqlx::SqlitePool,
    }
    static CONTEXT: OnceLock<CallbackContext> = OnceLock::new();

    /// delegate 实例要全局强持有：UNUserNotificationCenter.delegate 是 weak
    /// property，不持有会被释放导致回调丢失。
    static DELEGATE: OnceLock<Retained<TaskReminderDelegate>> = OnceLock::new();

    /// 诊断日志：GUI .app 的 stdout 被丢弃，println 看不到——追加写固定文件。
    /// 每个关键节点（初始化/权限/发送/willPresent/按钮回调）都落一行，
    /// 排查「声音响了横幅没弹」这类前台显示问题全靠它。
    fn notify_log(msg: &str) {
        use std::io::Write;
        let path = std::env::home_dir()
            .map(|h| h.join("Library/Logs/JustToDo/notify.log"))
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp/justtodo-notify.log"));
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(path.as_path()));
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(
                f,
                "[{}] {}",
                chrono::Local::now().format("%m-%d %H:%M:%S"),
                msg
            );
        }
        println!("[JustToDo][notify] {}", msg);
    }

    // UNUserNotificationCenterDelegate 实现（define_class 生成 Objective-C 类）
    define_class!(
        #[unsafe(super(NSObject))]
        struct TaskReminderDelegate;

        unsafe impl NSObjectProtocol for TaskReminderDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for TaskReminderDelegate {
            /// 用户与通知交互（点按钮 / 点通知本体 / 划掉）后回调
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                notify_log(&format!("交互回调 action={}", response.actionIdentifier()));
                handle_notification_response(response);
                // completionHandler 必须调用，否则系统认为交互未完成
                completion_handler.call(());
            }

            /// app 在前台时如何展示通知：返回 Banner|Sound|List（横幅 + 声音 + 通知中心）
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn userNotificationCenter_willPresentNotification_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                // 前台放行横幅+声音+通知中心。此回调被调用本身即证明 delegate 存活。
                let opts = UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::Sound
                    | UNNotificationPresentationOptions::List;
                notify_log("willPresent 被调用 → 放行 Banner|Sound|List");
                completion_handler.call((opts,));
            }
        }
    );

    /// 处理通知交互：identifier = task id，action 区分动作类型
    fn handle_notification_response(response: &UNNotificationResponse) {
        let Some(ctx) = CONTEXT.get() else {
            eprintln!("[JustToDo] 通知回调上下文未初始化，忽略交互");
            return;
        };
        let task_id = response.notification().request().identifier().to_string();
        let action = response.actionIdentifier().to_string();
        notify_log(&format!("解析交互 task={} action={}", task_id, action));

        match action.as_str() {
            // 贪睡按钮：写 snooze_until，到点后台扫描再次触发
            ACTION_SNOOZE_5 => spawn_snooze(ctx.pool.clone(), task_id, 5),
            ACTION_SNOOZE_10 => spawn_snooze(ctx.pool.clone(), task_id, 10),
            // 点击通知本体（com.apple.UNNotificationDefaultActionIdentifier）：
            // 激活主窗口 + 通知前端打开任务详情面板
            DEFAULT_ACTION_ID => {
                if let Some(window) = ctx.app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = ctx.app.emit("reminder:open-task", task_id);
            }
            // 划掉 / 其他动作：无需处理（notified_at 已写，本来就不会再提醒）
            _ => {}
        }
    }

    /// 贪睡写库（delegate 回调线程不能阻塞等待 sqlx，丢到异步运行时）。
    /// 成功后 emit 事件让前端刷新选中任务（详情面板立即显示「顺延至 HH:mm」）。
    fn spawn_snooze(pool: sqlx::SqlitePool, task_id: String, minutes: i64) {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = commands::task_snooze_inner(&pool, &task_id, minutes).await {
                eprintln!(
                    "[JustToDo] 贪睡 {} 分钟失败（任务 {}）: {}",
                    minutes, task_id, e
                );
            } else {
                println!("[JustToDo] 任务 {} 已顺延 {} 分钟", task_id, minutes);
                // 通知前端：正开着该任务详情面板时立即刷新顺延状态
                if let Some(ctx) = CONTEXT.get() {
                    let _ = ctx.app.emit("reminder:snoozed", task_id.clone());
                }
            }
        });
    }

    /// 空 NSString 引用数组（category 的 intentIdentifiers 占位）
    const EMPTY_STRINGS: &[&NSString] = &[];

    /// 原生通知可用标志：UNUserNotificationCenter 只能在 .app bundle 内使用——
    /// 散装二进制（tauri dev 直跑 target/debug 可执行文件）调用会抛
    /// NSException 且穿过 dispatch_once 无法被 Rust catch 拦截（直接崩溃）。
    /// 故用可执行文件路径预判：不含 ".app/Contents/MacOS" 一律走回退
    /// （tauri-plugin-notification 普通通知，无按钮但不崩）。打包版正常带按钮。
    static NATIVE_AVAILABLE: AtomicBool = AtomicBool::new(true);

    /// 当前进程是否运行在 .app bundle 内（唯一安全使用 UNUserNotificationCenter 的形态）
    fn in_app_bundle() -> bool {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS"))
            .unwrap_or(false)
    }

    /// 启动时初始化（主线程调用）：注册 category + delegate + 存回调上下文
    pub fn setup(app: tauri::AppHandle, pool: sqlx::SqlitePool) {
        let _ = CONTEXT.set(CallbackContext { app, pool });

        // dev 散装二进制：跳过全部 UNUserNotificationCenter 调用（防崩溃）
        if !in_app_bundle() {
            NATIVE_AVAILABLE.store(false, Ordering::Relaxed);
            notify_log("非 .app bundle 运行（dev），原生按钮通知禁用，回退普通通知");
            return;
        }
        notify_log("setup 开始（.app bundle 内）");

        // 两个贪睡按钮（macOS 横幅最多显示 2 个自定义 action；「我知道了」
        // 不需要按钮——不理会通知即不再提醒，语义天然成立）
        let action_5 = UNNotificationAction::actionWithIdentifier_title_options(
            &NSString::from_str(ACTION_SNOOZE_5),
            &NSString::from_str("5分钟后提醒"),
            UNNotificationActionOptionNone,
        );
        let action_10 = UNNotificationAction::actionWithIdentifier_title_options(
            &NSString::from_str(ACTION_SNOOZE_10),
            &NSString::from_str("10分钟后提醒"),
            UNNotificationActionOptionNone,
        );
        let category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(CATEGORY_TASK_REMINDER),
                &NSArray::from_retained_slice(&[action_5, action_10]),
                &NSArray::from_slice(EMPTY_STRINGS),
                UNNotificationCategoryOptionNone,
            );

        // NSSet 无便捷构造，用 initWithObjects:count: 包单个 category
        let mut objects = [NonNull::from(&*category)];
        let categories: Retained<NSSet<UNNotificationCategory>> =
            unsafe { NSSet::initWithObjects_count(NSSet::alloc(), objects.as_mut_ptr(), 1) };

        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setNotificationCategories(&categories);

        // 请求通知权限（已授权立即返回；未授权/未决定时弹系统询问）。
        // UNUserNotificationCenter 路径没有权限时 addNotificationRequest 会静默失败——
        // 故权限被拒时立即降级（NATIVE_AVAILABLE=false），发送回退 notify-rust
        // 普通通知：至少保证横幅能弹出（无按钮），最差不劣于旧版体验。
        let auth_options = UNAuthorizationOptions::Badge
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Alert;
        let auth_cb: block2::RcBlock<dyn Fn(objc2::runtime::Bool, *mut objc2_foundation::NSError)> =
            block2::RcBlock::new(
                |granted: objc2::runtime::Bool, error: *mut objc2_foundation::NSError| {
                    let err_desc = if error.is_null() {
                        "无".to_string()
                    } else {
                        unsafe { (*error).localizedDescription().to_string() }
                    };
                    notify_log(&format!(
                        "权限请求结果 granted={} error={}",
                        granted.as_bool(),
                        err_desc
                    ));
                    if !granted.as_bool() {
                        NATIVE_AVAILABLE.store(false, Ordering::Relaxed);
                        notify_log("通知权限被拒 → 降级为普通通知（无贪睡按钮）");
                    }
                },
            );
        center.requestAuthorizationWithOptions_completionHandler(auth_options, &auth_cb);

        // delegate 弱引用属性：实例全局持有防释放
        let this: Retained<TaskReminderDelegate> =
            unsafe { msg_send![TaskReminderDelegate::alloc(), init] };
        let _ = DELEGATE.set(this.clone());
        let proto = ProtocolObject::from_retained(this);
        center.setDelegate(Some(&proto));
        notify_log("原生通知已初始化（category+delegate 注册完成）");
    }

    /// 发送任务到期提醒（带贪睡按钮 category）。
    /// identifier = task id（同任务重复触发自动替换旧通知）。
    pub fn send_task_reminder(task_id: &str, title: &str, body: &str) {
        notify_log(&format!("发送提醒通知 task={} title={}", task_id, title));
        send_native(task_id, title, body, true);
    }

    /// 发送普通通知（无按钮；每日汇总提醒 / 系统提示用）。
    /// identifier 固定值：同类通知再次发送时替换旧的，不堆积。
    pub fn send_plain(identifier: &str, title: &str, body: &str) {
        notify_log(&format!("发送普通通知 id={} title={}", identifier, title));
        send_native(identifier, title, body, false);
    }

    /// 统一发送底层：原生不可用时（dev 散装二进制 / 授权被拒）
    /// 回退 tauri-plugin-notification（此时 delegate 未注册或无意义，无覆盖风险）。
    /// 注意：正常打包版**绝不**走 plugin——mac-notification-sys 每次发送都会
    /// setupDelegate() 覆盖我们的 delegate，导致前台横幅不放行、按钮回调丢失。
    fn send_native(identifier: &str, title: &str, body: &str, with_buttons: bool) {
        if !NATIVE_AVAILABLE.load(Ordering::Relaxed) {
            use tauri_plugin_notification::NotificationExt;
            if let Some(ctx) = CONTEXT.get() {
                let res = ctx
                    .app
                    .notification()
                    .builder()
                    .title(title)
                    .body(body)
                    .show();
                if let Err(e) = res {
                    eprintln!("[JustToDo] 回退通知发送失败: {}", e);
                }
            }
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        if with_buttons {
            content.setCategoryIdentifier(&NSString::from_str(CATEGORY_TASK_REMINDER));
        }

        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(identifier),
            &content,
            None,
        );
        let center = UNUserNotificationCenter::currentNotificationCenter();
        // completion 打印发送错误（权限被拒/通知被系统拒时 Apple 静默失败，必须打日志排查）
        let err_cb: block2::RcBlock<dyn Fn(*mut objc2_foundation::NSError)> =
            block2::RcBlock::new(|error: *mut objc2_foundation::NSError| {
                if error.is_null() {
                    notify_log("通知已提交系统（无错误）");
                } else {
                    let desc = unsafe { (*error).localizedDescription() };
                    notify_log(&format!("原生通知发送失败: {}", desc));
                }
            });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&err_cb));
    }
}

#[cfg(target_os = "macos")]
pub use platform::{send_plain, send_task_reminder, setup};

/// 非 macOS 平台空实现（保编译；该项目当前仅 macOS 使用原生通知增强）
#[cfg(not(target_os = "macos"))]
pub fn setup(_app: tauri::AppHandle, _pool: sqlx::SqlitePool) {}

#[cfg(not(target_os = "macos"))]
pub fn send_task_reminder(_task_id: &str, _title: &str, _body: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn send_plain(_identifier: &str, _title: &str, _body: &str) {}
