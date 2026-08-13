/**
 * 提示音常量表 —— 集中维护三类场景（任务完成 / 到期提醒 / 每日提醒）可选的全部音效。
 *
 * 音效资源来自滴答清单提取的提示音库（src/assets/sounds/ 下共 11 个，均很小）。
 * value 是存进 SQLite 设置的值（文件名去扩展名）；「无（静音）」用 "none"。
 */
import defaultUrl from "@/assets/sounds/default.wav";
import jingleUrl from "@/assets/sounds/jingle.aac";
import pulseUrl from "@/assets/sounds/pulse.mp3";
import blocksUrl from "@/assets/sounds/blocks.mp3";
import harpUrl from "@/assets/sounds/harp.mp3";
import leapUrl from "@/assets/sounds/leap.mp3";
import musicBoxUrl from "@/assets/sounds/music_box.mp3";
import ladderUrl from "@/assets/sounds/ladder.mp3";
import spiralUrl from "@/assets/sounds/spiral.aac";
import knockUrl from "@/assets/sounds/knock.aac";
import dripUrl from "@/assets/sounds/drip.aac";

/** 单个音效选项：value 为设置存储值；url 为播放地址，「无」为 null */
export type SoundOption = {
  value: string;
  label: string;
  url: string | null;
};

/** 全部可选音效（含「无（静音）」），顺序即设置页下拉展示顺序 */
export const SOUND_OPTIONS: SoundOption[] = [
  { value: "none", label: "无（静音）", url: null },
  { value: "jingle", label: "叮当", url: jingleUrl },
  { value: "default", label: "经典叮", url: defaultUrl },
  { value: "pulse", label: "脉冲", url: pulseUrl },
  { value: "blocks", label: "敲击", url: blocksUrl },
  { value: "harp", label: "竖琴", url: harpUrl },
  { value: "leap", label: "跳跃", url: leapUrl },
  { value: "music_box", label: "八音盒", url: musicBoxUrl },
  { value: "ladder", label: "阶梯", url: ladderUrl },
  { value: "spiral", label: "螺旋", url: spiralUrl },
  { value: "knock", label: "敲门", url: knockUrl },
  { value: "drip", label: "滴水", url: dripUrl },
];

/** 按 value 查音效选项；查不到（设置里存了旧值/非法值）时视为「无」 */
export function findSoundOption(value: string): SoundOption | null {
  return SOUND_OPTIONS.find((o) => o.value === value) ?? null;
}
