/**
 * 提示音播放 composable —— 三类场景（任务完成 / 到期提醒 / 每日提醒）的播放入口。
 *
 * 音效以 base64 内嵌（见 utils/sounds.ts 的 dataUrl），播放不依赖网络协议：
 * - 任务完成 / 试听（用户手势链内）：优先 Web Audio 预解码缓存，零延迟；
 *   AudioContext 若 suspended 则先调度 start 再 resume（手势链内 resume 有效）。
 * - 到期 / 每日提醒（Rust 后台事件触发，无手势）：AudioContext 无法恢复，
 *   必须走 HTMLAudio 元素播放（data: URL 无网络 I/O，解码即播）。
 * 打断：新播放打断上一次（快速连点不叠加）。
 *
 * 提醒声音由 Rust 后台发系统通知时同步 emit 事件到前端（见 lib.rs），
 * 补发轮（错过时间后启动 app）payload 为 true，不响，避免启动时突然响一串。
 */
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings";
import { SOUND_OPTIONS, findSoundOption } from "@/utils/sounds";

// ── Web Audio 预解码缓存 ──────────────────────────────

let audioCtx: AudioContext | null = null;
/** 已解码的 AudioBuffer 缓存：dataUrl → buffer */
const bufferCache = new Map<string, AudioBuffer>();
/** 解码中的 promise（防并发重复解码）：dataUrl → Promise<buffer|null> */
const decoding = new Map<string, Promise<AudioBuffer | null>>();

/** 懒创建 AudioContext；环境不支持时返回 null（整体降级到 HTMLAudio 路径） */
function getAudioCtx(): AudioContext | null {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/** data: URL → ArrayBuffer（base64 解码） */
function dataUrlToBytes(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

/** 解码单个音效并缓存；失败（环境不支持等）静默返回 null */
function decodeSound(dataUrl: string): Promise<AudioBuffer | null> {
  const existing = decoding.get(dataUrl);
  if (existing) return existing;
  const ctx = getAudioCtx();
  if (!ctx) return Promise.resolve(null);
  const task = Promise.resolve(dataUrlToBytes(dataUrl))
    .then((raw) => ctx.decodeAudioData(raw))
    .then((buffer) => {
      bufferCache.set(dataUrl, buffer);
      return buffer;
    })
    .catch(() => null);
  decoding.set(dataUrl, task);
  return task;
}

/** 启动时后台预解码全部音效并预创建兜底元素（不阻塞 UI） */
export function preloadSounds(): void {
  for (const opt of SOUND_OPTIONS) {
    if (opt.dataUrl) {
      void decodeSound(opt.dataUrl);
      getPooledAudio(opt.dataUrl);
    }
  }
}

// ── HTMLAudio 预加载池（提醒等无手势场景 / 未解码时的兜底） ──

const audioPool = new Map<string, HTMLAudioElement>();

/** 取预加载池中的元素（懒创建；data: URL 无需网络加载，解码即播） */
function getPooledAudio(dataUrl: string): HTMLAudioElement {
  let el = audioPool.get(dataUrl);
  if (!el) {
    el = new Audio(dataUrl);
    el.preload = "auto";
    audioPool.set(dataUrl, el);
  }
  return el;
}

// ── 播放 ──────────────────────────────────────────────

/** 当前正在播放的 BufferSource（用于打断上一次） */
let currentSource: AudioBufferSourceNode | null = null;
/** 当前正在播放的兜底元素（用于打断上一次） */
let currentFallback: HTMLAudioElement | null = null;

/**
 * 播放指定音效（data: URL）。
 * @param allowWebAudio 是否允许走 Web Audio 零延迟路径：
 *   仅限用户手势链内（勾选完成 / 设置页试听）；提醒等后台触发必须传 false。
 */
export function playSound(dataUrl: string, allowWebAudio: boolean): void {
  // 打断上一次（BufferSource 与兜底元素双路径都停）
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // 未 start 时 stop 会抛 InvalidStateError，忽略（该节点随后被替换丢弃）
    }
    currentSource = null;
  }
  if (currentFallback) {
    currentFallback.pause();
    currentFallback.currentTime = 0;
    currentFallback = null;
  }
  // Web Audio 零延迟路径：仅手势链内且已解码
  const cached = bufferCache.get(dataUrl);
  const ctx = audioCtx;
  if (allowWebAudio && cached && ctx) {
    const source = ctx.createBufferSource();
    source.buffer = cached;
    source.connect(ctx.destination);
    currentSource = source;
    source.onended = () => {
      if (currentSource === source) currentSource = null;
    };
    // 先调度 start：context 若 suspended，resume 完成时立即出声（Web Audio 规范保证
    // 已调度的 source 在 context running 后播放），避免 resume().then(start) 串行延迟
    source.start();
    if (ctx.state === "suspended") {
      // 手势链内调用 resume（勾选/试听都在用户点击中），尽快恢复上下文
      void ctx.resume();
    }
    return;
  }
  // 兜底：HTMLAudio 元素播放（data: URL 无网络 I/O），同时后台解码供下次手势内零延迟
  const el = getPooledAudio(dataUrl);
  el.currentTime = 0;
  currentFallback = el;
  void el.play().catch(() => {});
  void decodeSound(dataUrl);
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
  if (!option?.dataUrl) return;
  // 任务完成在用户手势链内，允许 Web Audio 零延迟路径；
  // 提醒由后台事件触发（无手势，AudioContext 无法恢复），必须走 HTMLAudio
  playSound(option.dataUrl, scene === "completion");
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
