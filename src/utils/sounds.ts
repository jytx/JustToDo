/**
 * 提示音常量表 —— 集中维护三类场景（任务完成 / 到期提醒 / 每日提醒）可选的全部音效。
 *
 * 实际播放由 Rust 端 NSSound 完成（src-tauri/sound.rs，音效文件打包进 app 资源），
 * 前端只负责场景 → value 的选择与设置存储；播放调用见 composables/useSound.ts。
 * value 是存进 SQLite 设置的值（文件名去扩展名）；「无（静音）」用 "none"。
 */

/** 单个音效选项：value 为设置存储值（同时是 Rust 端 SOUND_FILES 的 key） */
export type SoundOption = {
  value: string;
  label: string;
};

/** 全部可选音效（含「无（静音）」），顺序即设置页下拉展示顺序 */
export const SOUND_OPTIONS: SoundOption[] = [
  { value: "none", label: "无（静音）" },
  { value: "jingle", label: "叮当" },
  { value: "default", label: "经典叮" },
  { value: "pulse", label: "脉冲" },
  { value: "blocks", label: "敲击" },
  { value: "harp", label: "竖琴" },
  { value: "leap", label: "跳跃" },
  { value: "music_box", label: "八音盒" },
  { value: "ladder", label: "阶梯" },
  { value: "spiral", label: "螺旋" },
  { value: "knock", label: "敲门" },
  { value: "drip", label: "滴水" },
];

/** 是否可试听（「无」不可） */
export function isPreviewable(value: string): boolean {
  return value !== "none" && SOUND_OPTIONS.some((o) => o.value === value);
}

/** 按 value 查音效选项；查不到（设置里存了旧值/非法值）时视为「无」 */
export function findSoundOption(value: string): SoundOption | null {
  return SOUND_OPTIONS.find((o) => o.value === value) ?? null;
}
