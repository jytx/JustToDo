/**
 * 提示音播放 composable —— 三类场景（任务完成 / 到期提醒 / 每日提醒）的播放入口。
 *
 * 播放策略（刻意极简，无共享可坏状态）：
 * - 每次播放创建全新 Audio 元素播 data: URL（base64 内嵌，无网络 I/O）；
 * - 不用 Web Audio / AudioContext：打包版 WKWebView 中 context 会因系统闲置
 *   被 App Nap 挂起（suspended/closed、resume 被拒），行为不可控，是历次
 *   「延迟大 / 无声」问题的温床；全新元素由 WKWebView 重新激活媒体管道，最稳。
 * - 播放失败（元素状态损坏等）时静默放弃，不影响主流程。
 * 打断：新播放打断上一次（快速连点不叠加）。
 *
 * 提醒声音由 Rust 后台发系统通知时同步 emit 事件到前端（见 lib.rs），
 * 补发轮（错过时间后启动 app）payload 为 true，不响，避免启动时突然响一串。
 */
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings";
import { findSoundOption } from "@/utils/sounds";

/** 当前正在播放的元素（用于打断上一次） */
let currentAudio: HTMLAudioElement | null = null;

/** 播放指定音效（data: URL）；失败静默（资源异常等），不影响主流程 */
export function playSound(dataUrl: string): void {
  // 打断上一次
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  const el = new Audio(dataUrl);
  currentAudio = el;
  el.onended = () => {
    if (currentAudio === el) currentAudio = null;
  };
  void el.play().catch(() => {});
}

/** 启动预热（保留接口兼容；实际无需预热——data: URL 每次即建即播） */
export function preloadSounds(): void {
  /* no-op */
}

// ── 场景播放 ──────────────────────────────────────────

/** 三类声音场景 */
export type SoundScene = "completion" | "due" | "daily";

/** 按场景播放：读设置里该场景选中的音效，选「无」则不响 */
export function playSceneSound(scene: SoundScene): void {
  const settings = useSettingsStore();
  // 场景 → 设置字段 的映射（保持与 settings store 导出一致）
  const valueByScene: Record<SoundScene, string> = {
    completion: settings.completionSound,
    due: settings.dueReminderSound,
    daily: settings.dailyReminderSound,
  };
  const option = findSoundOption(valueByScene[scene]);
  if (option?.dataUrl) {
    playSound(option.dataUrl);
  }
}

/**
 * 注册提醒声音监听：Rust 后台触发到期/每日提醒时 emit 事件，
 * 前端据此播放对应场景音效。catchUp=true 为启动补发，不响。
 */
export function setupReminderSounds(): void {
  void listen<boolean>("reminder:due", (event) => {
    if (!event.payload) playSceneSound("due");
  });
  void listen<boolean>("reminder:daily", (event) => {
    if (!event.payload) playSceneSound("daily");
  });
}
