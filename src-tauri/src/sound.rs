// 提示音原生播放（macOS NSSound）—— 完全绕开 WebView 音频管线。
//
// 背景：WKWebView 的媒体管线在屏保/锁屏/深度闲置后行为不可预测
// （无声 / 假播放 / resume 需 ~1s），历经多轮前端方案（Web Audio 预解码 +
// 保活 + 手势 resume + HTMLAudio 兜底）均无法 100% 根治。NSSound 是
// AppKit 进程内播放，不受 WebKit 策略影响，稳定且低延迟。
//
// 三类场景统一入口：
// - 任务完成：前端勾选 → invoke("play_sound")
// - 到期 / 每日提醒：Rust 后台发系统通知的回调里直接调 play_by_setting
//   （连前端都不经，可靠性最高）
#[cfg(target_os = "macos")]
mod imp {
    use objc2::AllocAnyThread;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager};

    /// 音效 value（与前端 SOUND_OPTIONS 一致）→ 音效文件名；
    /// "none" 表示静音，不在此表内。
    const SOUND_FILES: &[(&str, &str)] = &[
        ("jingle", "jingle.aac"),
        ("default", "default.wav"),
        ("pulse", "pulse.mp3"),
        ("blocks", "blocks.mp3"),
        ("harp", "harp.mp3"),
        ("leap", "leap.mp3"),
        ("music_box", "music_box.mp3"),
        ("ladder", "ladder.mp3"),
        ("spiral", "spiral.aac"),
        ("knock", "knock.aac"),
        ("drip", "drip.aac"),
    ];

    /// 解析音效文件路径：优先打包资源目录（release），回退源码目录（dev）。
    /// 返回 None 表示文件缺失（理论上不会发生——resources 已含全部音效）。
    fn resolve_sound_path(file: &str, app: &AppHandle) -> Option<PathBuf> {
        // release：app.path().resolve(..., Resource) → JustToDo.app/Contents/Resources/sounds/
        if let Ok(p) = app.path().resolve(
            format!("sounds/{file}"),
            tauri::path::BaseDirectory::Resource,
        ) {
            if p.exists() {
                return Some(p);
            }
        }
        // dev：cwd 是 src-tauri/（tauri dev 的工作目录），直接读源码目录
        let dev_path = std::env::current_dir().ok()?.join("sounds").join(file);
        dev_path.exists().then_some(dev_path)
    }

    /// 在主线程执行的播放动作（AppKit 对象规范要求主线程操作）。
    /// 缓存放在主线程 thread_local：NSSound 实例可重复 play（重播会从头开始），
    /// 预创建避免每次播放都读文件解码；无需跨线程共享（避开 Send 问题）。
    fn play_on_main(file_name: String, path: String) {
        thread_local! {
            static CACHE: std::cell::RefCell<HashMap<String, objc2::rc::Retained<objc2_app_kit::NSSound>>> =
                std::cell::RefCell::new(HashMap::new());
        }
        CACHE.with(|cache| {
            let mut map = cache.borrow_mut();
            // 命中缓存或首次创建后统一播放（Retained 为引用计数，clone 零成本）
            let sound = match map.get(&file_name) {
                Some(s) => s.clone(),
                None => {
                    let path = objc2_foundation::NSString::from_str(&path);
                    // initWithContentsOfFile 是关联函数（this 为首参），非链式方法
                    let created = objc2_app_kit::NSSound::initWithContentsOfFile_byReference(
                        objc2_app_kit::NSSound::alloc(),
                        &path,
                        true,
                    );
                    let Some(s) = created else {
                        eprintln!("[JustToDo] NSSound 加载失败: {}", file_name);
                        return;
                    };
                    map.insert(file_name.clone(), s.clone());
                    s
                }
            };
            // NSSound 重复 play 会自动从头开始（打断上一次），无需显式 stop
            if !sound.play() {
                eprintln!("[JustToDo] NSSound 播放失败: {}", file_name);
            }
        });
    }

    /// 按设置 value 播放（三类场景统一入口）。
    /// value 为 "none" 或未知值时不播；文件缺失等错误仅记日志（提示音失败不应影响主流程）。
    pub fn play_by_value(app: &AppHandle, value: &str) {
        let Some((_, file)) = SOUND_FILES.iter().find(|(v, _)| *v == value) else {
            return; // "none"（静音）或非法值
        };
        let Some(path) = resolve_sound_path(file, app) else {
            eprintln!("[JustToDo] 音效文件不存在: {}", file);
            return;
        };
        let file_name = file.to_string();
        let path_str = path.display().to_string();
        // AppKit 对象须在主线程操作；播放动作极轻（缓存命中时仅一次 play 调用）
        let _ = app.run_on_main_thread(move || play_on_main(file_name, path_str));
    }
}

#[cfg(target_os = "macos")]
pub use imp::play_by_value;

/// 非 macOS 平台暂无原生播放实现（项目当前仅打包 macOS），
/// 保留空实现保证命令注册与调用点编译通过
#[cfg(not(target_os = "macos"))]
pub fn play_by_value(_app: &tauri::AppHandle, _value: &str) {}

/// 前端 IPC 命令：按设置 value 播放提示音（任务完成 / 设置页试听）
#[tauri::command]
pub fn play_sound(app: tauri::AppHandle, value: String) {
    play_by_value(&app, &value);
}
