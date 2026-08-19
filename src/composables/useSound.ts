/**
 * 提示音播放 composable —— 三类场景（任务完成 / 到期提醒 / 每日提醒）的播放入口。
 *
 * 播放全部由 Rust 端 NSSound 原生完成（src-tauri/sound.rs）：WKWebView 的
 * Web 音频管线在屏保/锁屏/深度闲置后行为不可预测（无声/假播放/resume 慢），
 * 历经多轮前端方案无法根治后改用原生播放——稳定、低延迟、不受任何 WebKit
 * 策略影响。
 *
 * - 任务完成 / 设置页试听：前端 invoke("play_sound") 触发
 * - 到期 / 每日提醒：Rust 后台发系统通知的回调里直接播放（不经前端），
 *   补发轮（错过时间后启动 app）不响，避免启动时突然响一串
 */
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings";
import { findSoundOption } from "@/utils/sounds";

/** 播放指定音效（value）；"none" / 非法值不播 */
export function playSound(value: string): void {
  if (value === "none") return;
  void invoke("play_sound", { value }).catch(() => {});
}

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
  const value = valueByScene[scene];
  if (findSoundOption(value)) {
    playSound(value);
  }
}
