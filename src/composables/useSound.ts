/**
 * 提示音播放 composable —— 三类场景（任务完成 / 到期提醒 / 每日提醒）的播放入口。
 *
 * 播放策略（消除点击勾选后的声音延迟）：
 * 1. 应用启动后后台预解码全部音效（fetch + decodeAudioData 缓存）。已解码时用
 *    AudioBufferSourceNode 播放，几乎零延迟；
 * 2. 未解码（启动瞬间 / fetch 跨域失败）兜底用 preload=auto 的 HTMLAudioElement
 *    立即播放，同时后台继续解码供下次复用。
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
/** 已解码的 AudioBuffer 缓存：url → buffer */
const bufferCache = new Map<string, AudioBuffer>();
/** 解码中的 promise（防并发重复解码）：url → Promise<buffer|null> */
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

/** 解码单个音效并缓存；失败（如生产环境 asset 协议跨域）静默返回 null */
function decodeSound(url: string): Promise<AudioBuffer | null> {
  const existing = decoding.get(url);
  if (existing) return existing;
  const ctx = getAudioCtx();
  if (!ctx) return Promise.resolve(null);
  const task = fetch(url)
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error("bad status"))))
    .then((raw) => ctx.decodeAudioData(raw))
    .then((buffer) => {
      bufferCache.set(url, buffer);
      return buffer;
    })
    .catch(() => null);
  decoding.set(url, task);
  return task;
}

/** 启动时后台预解码全部音效（不阻塞 UI；跨域失败自动跳过） */
export function preloadSounds(): void {
  for (const opt of SOUND_OPTIONS) {
    if (opt.url) void decodeSound(opt.url);
  }
}

// ── HTMLAudio 预加载池（未解码时的即时兜底） ──────────

const audioPool = new Map<string, HTMLAudioElement>();

/** 取预加载池中的元素（懒创建，preload=auto 让浏览器提前缓存资源） */
function getPooledAudio(url: string): HTMLAudioElement {
  let el = audioPool.get(url);
  if (!el) {
    el = new Audio(url);
    el.preload = "auto";
    audioPool.set(url, el);
  }
  return el;
}

// ── 播放 ──────────────────────────────────────────────

/** 当前正在播放的 BufferSource（用于打断上一次） */
let currentSource: AudioBufferSourceNode | null = null;
/** 当前正在播放的兜底元素（用于打断上一次） */
let currentFallback: HTMLAudioElement | null = null;

/** 用已解码 buffer 播放（零延迟）；context 未 running 时先 resume 再播 */
function playBuffer(buffer: AudioBuffer): void {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  currentSource = source;
  source.onended = () => {
    if (currentSource === source) currentSource = null;
  };
  if (ctx.state === "suspended") {
    // 若播放期间被新的声音打断，currentSource 已换，不再 start（避免叠声）
    void ctx.resume().then(() => {
      if (currentSource === source) source.start();
    });
  } else {
    source.start();
  }
}

/** 播放指定 url 的音效；失败静默（资源未就绪等），不影响主流程 */
export function playSound(url: string): void {
  // 打断上一次（BufferSource 与兜底元素双路径都停）
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // 未 start 时 stop 会抛 InvalidStateError，忽略（该节点随后会被替换丢弃）
    }
    currentSource = null;
  }
  if (currentFallback) {
    currentFallback.pause();
    currentFallback.currentTime = 0;
    currentFallback = null;
  }
  // 已解码 → Web Audio 零延迟播放
  const cached = bufferCache.get(url);
  if (cached) {
    playBuffer(cached);
    return;
  }
  // 未解码 → 预加载元素立即兜底，同时后台解码供下次复用
  const el = getPooledAudio(url);
  el.currentTime = 0;
  currentFallback = el;
  void el.play().catch(() => {});
  void decodeSound(url);
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
  if (option?.url) {
    playSound(option.url);
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
