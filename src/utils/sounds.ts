/**
 * 提示音常量表 —— 集中维护三类场景（任务完成 / 到期提醒 / 每日提醒）可选的全部音效。
 *
 * 音效字节以 base64 内嵌（vite 插件生成 src/generated/sounds.ts），每个选项提供
 * data: URL 直接可播——不依赖网络协议，dev / 打包行为一致、播放无网络 I/O 延迟。
 * value 是存进 SQLite 设置的值（文件名去扩展名）；「无（静音）」用 "none"。
 */
import { SOUND_DATA } from "@/generated/sounds";

/** 单个音效选项：value 为设置存储值；dataUrl 为 data: URL（「无」为 null） */
export type SoundOption = {
  value: string;
  label: string;
  dataUrl: string | null;
};

/** 音效文件清单：文件名（SOUND_DATA 的 key）→ 展示名 */
const SOUND_FILES: { file: string; value: string; label: string }[] = [
  { file: "jingle.aac", value: "jingle", label: "叮当" },
  { file: "default.wav", value: "default", label: "经典叮" },
  { file: "pulse.mp3", value: "pulse", label: "脉冲" },
  { file: "blocks.mp3", value: "blocks", label: "敲击" },
  { file: "harp.mp3", value: "harp", label: "竖琴" },
  { file: "leap.mp3", value: "leap", label: "跳跃" },
  { file: "music_box.mp3", value: "music_box", label: "八音盒" },
  { file: "ladder.mp3", value: "ladder", label: "阶梯" },
  { file: "spiral.aac", value: "spiral", label: "螺旋" },
  { file: "knock.aac", value: "knock", label: "敲门" },
  { file: "drip.aac", value: "drip", label: "滴水" },
];

/** 文件扩展名 → data: URL 的 mime 类型 */
function mimeOf(file: string): string {
  const ext = file.split(".").pop() ?? "";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  return "audio/aac";
}

/** 全部可选音效（含「无（静音）」），顺序即设置页下拉展示顺序 */
export const SOUND_OPTIONS: SoundOption[] = [
  { value: "none", label: "无（静音）", dataUrl: null },
  ...SOUND_FILES.map(({ file, value, label }) => ({
    value,
    label,
    dataUrl: `data:${mimeOf(file)};base64,${SOUND_DATA[file]}`,
  })),
];

/** 按 value 查音效选项；查不到（设置里存了旧值/非法值）时视为「无」 */
export function findSoundOption(value: string): SoundOption | null {
  return SOUND_OPTIONS.find((o) => o.value === value) ?? null;
}
