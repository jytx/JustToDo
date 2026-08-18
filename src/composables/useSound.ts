/**
 * 提示音播放 composable —— 三类场景（任务完成 / 到期提醒 / 每日提醒）的播放入口。
 *
 * 双路径策略（低延迟 + 保命兜底）：
 * - 主路径 Web Audio：AudioBufferSourceNode 直连音频渲染回调，真实出声 ~10-20ms
 *   （HTMLAudio 走完整媒体管线，WKWebView 下实测出声延迟 100-300ms，人耳明显可感）。
 *   仅当 context 处于 running 时使用（resume 由首次用户手势触发）；
 * - 兜底路径 HTMLAudio 池元素：context 未就绪（启动初期 resume 前）或意外挂起时
 *   保证有声（慢但稳）；元素 error 自愈 + play 失败重建；
 * - App Nap 已由 Rust 端声明 userInitiated 活动阻止（见 lib.rs），context 不会因
 *   应用闲置被系统重新挂起——这是 Web Audio 可作为常驻主路径的前提；
 * - 节点生命周期：source 播完（onended）与被打断时无条件 disconnect，防止音频图
 *   节点累积（长会话延迟渐增的根因，实测 200 次连点零泄漏）。
 * 打断：新播放打断上一次（快速连点不叠加）。
 *
 * 提醒声音由 Rust 后台发系统通知时同步 emit 事件到前端（见 lib.rs），
 * 补发轮（错过时间后启动 app）payload 为 true，不响，避免启动时突然响一串。
 */
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings";
import { SOUND_OPTIONS, findSoundOption } from "@/utils/sounds";

// ── Web Audio：预解码缓存 ──────────────────────────────

let audioCtx: AudioContext | null = null;
/** 已解码的 AudioBuffer 缓存：dataUrl → buffer（suspended 的 context 也能解码） */
const bufferCache = new Map<string, AudioBuffer>();
/** 解码中的 promise（防并发重复解码）：dataUrl → Promise<buffer|null> */
const decoding = new Map<string, Promise<AudioBuffer | null>>();

/** 懒创建 AudioContext；已失效（closed）时重建并清空解码缓存 */
function getAudioCtx(): AudioContext | null {
  try {
    if (audioCtx && audioCtx.state === "closed") {
      audioCtx = null;
      bufferCache.clear();
      decoding.clear();
    }
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

// ── HTMLAudio：兜底元素池 ──────────────────────────────

const audioPool = new Map<string, HTMLAudioElement>();

/** 取池中元素；不存在或处于 error 状态（损坏自愈）时重建 */
function getPooledAudio(dataUrl: string): HTMLAudioElement {
  let el = audioPool.get(dataUrl);
  if (!el || el.error) {
    el = new Audio(dataUrl);
    el.preload = "auto";
    // 触发预解码（data: URL 无网络，仅本地解码）
    el.load();
    audioPool.set(dataUrl, el);
  }
  return el;
}

// ── 播放 ──────────────────────────────────────────────

/** 当前正在播放的 BufferSource（用于打断 + 释放） */
let currentSource: AudioBufferSourceNode | null = null;
/** 当前正在播放的兜底元素（用于打断） */
let currentFallback: HTMLAudioElement | null = null;

/** 启动预热：预解码全部音效 + 预建兜底元素 + 常驻手势恢复 + 静音保活 */
export function preloadSounds(): void {
  for (const opt of SOUND_OPTIONS) {
    if (opt.dataUrl) {
      void decodeSound(opt.dataUrl);
      getPooledAudio(opt.dataUrl);
    }
  }
  // 常驻手势 resume（非 once）：WebKit 会在音频闲置一段时间后自动 suspend
  // AudioContext（引擎内部策略，与系统 App Nap 无关），首次 resume 挡不住后续挂起。
  // 挂起后下一次点击若不恢复，将永远落回 HTMLAudio 慢路径（~100-300ms 延迟）。
  // 捕获阶段 pointerdown 早于 click 处理器执行，resume 多数情况能在播放前完成。
  const resumeOnGesture = () => {
    if (audioCtx && audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
  };
  window.addEventListener("pointerdown", resumeOnGesture, { capture: true });
  window.addEventListener("keydown", resumeOnGesture, { capture: true });

  // 静音保活：running 期间每 25s 播一个静音样本，保持音频图有活动，
  // 阻止 WebKit 因闲置挂起 context（挂起时本回调不动作，等手势 resume 恢复）
  setInterval(() => {
    const ctx = audioCtx;
    if (!ctx || ctx.state !== "running") return;
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => source.disconnect();
      source.start();
    } catch {
      // 保活失败不影响任何功能，忽略
    }
  }, 25_000);
}

/**
 * 播放指定音效（data: URL）。
 * @param allowWebAudio 是否允许走 Web Audio 低延迟路径：
 *   仅限用户手势链内（勾选完成 / 设置页试听）；提醒等后台触发传 false 走兜底
 *   （后台无手势时 context 可能未恢复，且元素路径已够用——提醒不追求极低延迟）。
 */
export function playSound(dataUrl: string, allowWebAudio: boolean): void {
  // 打断上一次（双路径都停；Web Audio 节点必须 disconnect 防音频图累积）
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // 未 start 时 stop 抛 InvalidStateError，忽略（disconnect 幂等）
    }
    currentSource.disconnect();
    currentSource = null;
  }
  if (currentFallback) {
    currentFallback.pause();
    currentFallback.currentTime = 0;
    currentFallback = null;
  }
  // 主路径：手势链内 + 已解码。running 直接播；suspended 先 resume 再播
  // （resume 几十 ms，仍远优于媒体管线 100-300ms；resume 被拒则落兜底保证有声）
  const cached = bufferCache.get(dataUrl);
  const ctx = audioCtx;
  if (allowWebAudio && cached && ctx) {
    if (ctx.state === "running") {
      playWithBuffer(ctx, cached);
      return;
    }
    if (ctx.state === "suspended") {
      void ctx.resume().then(() => {
        // 期间可能已被新的播放打断/替换，避免叠音
        if (ctx.state === "running" && !currentSource && !currentFallback) {
          playWithBuffer(ctx, cached);
        }
      });
      return;
    }
    // closed 等异常状态：落兜底（下次播放时 getAudioCtx 会重建）
  }
  // 兜底：池元素播放；play 被拒时新建元素重试一次（成功则入池替换）
  const el = getPooledAudio(dataUrl);
  el.currentTime = 0;
  currentFallback = el;
  void el.play().catch(() => {
    const fresh = new Audio(dataUrl);
    fresh.preload = "auto";
    audioPool.set(dataUrl, fresh);
    void fresh.play().catch(() => {});
  });
}

/** 用已解码 buffer 经 Web Audio 播放（节点纪律：ended/打断时 disconnect） */
function playWithBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  currentSource = source;
  source.onended = () => {
    if (currentSource === source) currentSource = null;
    source.disconnect();
  };
  source.start();
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
  // 任务完成在用户手势链内 → 允许 Web Audio 低延迟路径；
  // 到期/每日提醒由后台事件触发（无手势）→ 走 HTMLAudio 兜底（不追求极低延迟）
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
