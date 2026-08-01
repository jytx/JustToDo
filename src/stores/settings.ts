// 应用设置 store —— 集中持久化主题/强调色/自动今天/检查间隔
// 复用现有 SQLite `app_settings` KV 表与 `db.getSetting/setSetting` IPC

import { defineStore } from "pinia";
import { ref } from "vue";
import * as db from "@/api/db";
import { useTheme } from "@/composables/useTheme";
import { isValidHHmm } from "@/utils/date";

/** 主题模式：light | dark | system */
export type ThemeMode = "light" | "dark" | "system";

/** 主题模式可选值（供 UI 与校验复用） */
const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

/** 设置 key 常量 —— 集中维护避免散落字符串 */
export const SETTINGS_KEYS = {
  themeMode: "theme_mode",
  accentColor: "accent_color",
  newTasksDueToday: "new_tasks_due_today",
  recurrenceCheckInterval: "recurrence_check_interval",
  startupView: "startup_view",
  zoomLevel: "zoom_level",
  templateDefaultListId: "template_default_list_id",
  templateDefaultNoteId: "template_default_note_id",
  dailyReminderTimes: "daily_reminder_times",
  // ── AI 配置（详见 discuss/2026-07-31-ai-config-design.md）──
  /** AI 总开关（关掉后所有 AI 功能入口隐藏） */
  aiEnabled: "ai_enabled",
  /** 服务协议：openai（OpenAI 兼容）/ anthropic */
  aiProvider: "ai_provider",
  /** API 地址（base_url） */
  aiBaseUrl: "ai_base_url",
  /** API Key（明文存本地 SQLite） */
  aiApiKey: "ai_api_key",
  /** 模型名 */
  aiModel: "ai_model",
  /** AI 总结智能裁剪阈值（任务数超过时弹确认是否裁剪，默认 50） */
  aiSummaryTruncateThreshold: "ai_summary_truncate_threshold",
  // ── AI 提示词（用户可自定义，空字符串表示用默认）──
  /** 每日/周报提示词（支持 {mode} 占位符） */
  aiPromptSmart: "ai_prompt_smart",
  /** 清单/目录总结提示词 */
  aiPromptList: "ai_prompt_list",
  /** 多选任务总结提示词 */
  aiPromptTasks: "ai_prompt_tasks",
  /** 笔记摘要提示词 */
  aiPromptNote: "ai_prompt_note",
} as const;

/** 每日汇总提醒时点配置 —— 上限 8 个（与 Rust 端 parse_daily_times 一致） */
const MAX_DAILY_REMINDER_TIMES = 8;

/** 启动时打开的目标视图 */
export type StartupView = "today" | "all" | "inbox";

const STARTUP_VIEWS: readonly StartupView[] = ["today", "all", "inbox"];

/** AI 服务协议类型：openai（OpenAI 兼容，覆盖 DeepSeek/通义/Ollama 等）/ anthropic */
export type AiProvider = "openai" | "anthropic";

/** AI 协议可选值（供 UI 与校验复用） */
const AI_PROVIDERS: readonly AiProvider[] = ["openai", "anthropic"];

const DEFAULT_THEME_MODE: ThemeMode = "system";
const DEFAULT_ACCENT_COLOR = "#4F46E5";
const DEFAULT_NEW_TASKS_DUE_TODAY = true;
const DEFAULT_RECURRENCE_CHECK_INTERVAL = 60;
const DEFAULT_STARTUP_VIEW: StartupView = "today";

/** 模板应用时的默认目标清单 id（'inbox' 是预置不可删清单） */
const DEFAULT_TEMPLATE_LIST_ID = "inbox";
/** 笔记模板默认笔记本：默认指向 migration 023 预置的"默认笔记本" */
const DEFAULT_TEMPLATE_NOTE_ID = "default-notebook";

// ── AI 默认值 ──
/** AI 默认关闭（隐私友好，用户显式开启） */
const DEFAULT_AI_ENABLED = false;
/** 默认协议 OpenAI 兼容（覆盖最广） */
const DEFAULT_AI_PROVIDER: AiProvider = "openai";
const DEFAULT_AI_BASE_URL = "";
const DEFAULT_AI_API_KEY = "";
const DEFAULT_AI_MODEL = "";
/** AI 总结裁剪阈值默认 50（任务数超过时前端弹确认是否裁剪） */
const DEFAULT_AI_SUMMARY_TRUNCATE_THRESHOLD = 50;

// ── AI 提示词默认值（与 Rust 端 DEFAULT_PROMPT_* 常量保持一致）──
// 供设置页「恢复默认」和初始显示使用。smart 支持 {mode} 占位符。
export const DEFAULT_PROMPT_SMART = `你是一个温暖、专业的任务总结助手。请根据用户{mode}的任务数据，生成一份简洁的中文 Markdown 小结。

要求：
1. 用 Markdown 格式输出，包含以下部分（用二级标题）：
   - 「{mode}完成」：列出已完成的主要任务，肯定用户的努力
   - 「待办提醒」：列出需要关注的事项（如果有），按紧急程度排序
   - 「小结」：1-2 句鼓励性的总结
2. 语气积极、鼓励，让用户有成就感
3. 如果某部分没有数据，简要说明（例如：今天暂无逾期待办，很棒！）
4. 不要编造数据，只基于提供的任务
5. 语言简洁，控制在 300 字以内`;

export const DEFAULT_PROMPT_LIST = `你是一个温暖、专业的任务总结助手。请根据用户提供的任务列表，生成一份简洁的中文 Markdown 总结。

要求：
1. 用 Markdown 格式输出，包含以下部分（用二级标题）：
   - 「概览」：任务总数、完成情况
   - 「重点任务」：挑出最重要的几项（高优先级、即将截止的）
   - 「小结」：1-2 句总结性、鼓励性的话
2. 语气积极、专业
3. 不要编造数据，只基于提供的任务
4. 语言简洁，控制在 300 字以内`;

/** 多选总结默认提示词（与清单/目录相同，但用户可独立定制） */
export const DEFAULT_PROMPT_TASKS = DEFAULT_PROMPT_LIST;

export const DEFAULT_PROMPT_NOTE = `你是一个专业的笔记摘要助手。请根据用户提供的笔记列表，生成一份简洁的中文 Markdown 摘要。

要求：
1. 用 Markdown 格式输出，包含以下部分（用二级标题）：
   - 「笔记概览」：笔记数量、整体主题
   - 「要点提炼」：每篇笔记的核心要点（1-2 句）
   - 「小结」：这些笔记之间的关联或整体价值
2. 语气客观、专业
3. 不要编造内容，只基于提供的笔记
4. 语言简洁，控制在 400 字以内`;

/** 窗口缩放级别上下限（与 Rust 端 menu.rs 保持一致） */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const DEFAULT_ZOOM_LEVEL = 1.0;

/** 16 进制颜色 #RRGGBB 校验 */
function isValidHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

function parseThemeMode(v: string | null): ThemeMode {
  if (v && (THEME_MODES as readonly string[]).includes(v)) {
    return v as ThemeMode;
  }
  return DEFAULT_THEME_MODE;
}

function parseAccentColor(v: string | null): string {
  if (v && isValidHexColor(v)) return v;
  return DEFAULT_ACCENT_COLOR;
}

function parseBoolean(v: string | null, fallback: boolean): boolean {
  if (v === null) return fallback;
  return v === "true";
}

function parseIntervalMinutes(v: string | null): number {
  if (!v) return DEFAULT_RECURRENCE_CHECK_INTERVAL;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RECURRENCE_CHECK_INTERVAL;
  return Math.min(1440, Math.floor(n));
}

function parseStartupView(v: string | null): StartupView {
  if (v && (STARTUP_VIEWS as readonly string[]).includes(v)) {
    return v as StartupView;
  }
  return DEFAULT_STARTUP_VIEW;
}

/** 解析模板默认清单 id；空或不存在则回落到 inbox */
function parseTemplateListId(v: string | null): string {
  if (v && v.trim()) return v;
  return DEFAULT_TEMPLATE_LIST_ID;
}

/**
 * 解析每日汇总提醒时点 CSV 字符串（"09:00,17:00"）为合法 HH:mm 列表
 * - 去重、去空
 * - 严格 24h HH:mm 校验（委托 isValidHHmm）
 * - 字典序排序（HH:mm 字典序 == 时间序）
 * - 最多 MAX_DAILY_REMINDER_TIMES 个
 * - 与 Rust 端 parse_daily_times 保持一致
 */
function parseDailyReminderTimes(v: string | null): string[] {
  if (!v) return [];
  const seen: string[] = [];
  for (const tok of v.split(",")) {
    const t = tok.trim();
    if (!t || !isValidHHmm(t)) continue;
    if (!seen.includes(t)) seen.push(t);
    if (seen.length >= MAX_DAILY_REMINDER_TIMES) break;
  }
  seen.sort();
  return seen;
}

/** 解析并钳制缩放级别（保留两位小数，与 Rust 端 clamp_zoom 一致） */
function parseZoomLevel(v: string | null): number {
  if (!v) return DEFAULT_ZOOM_LEVEL;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_ZOOM_LEVEL;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
  return Math.round(clamped * 100) / 100;
}

/** 解析 AI 协议类型，非法值回落到默认（openai） */
function parseAiProvider(v: string | null): AiProvider {
  if (v && (AI_PROVIDERS as readonly string[]).includes(v)) {
    return v as AiProvider;
  }
  return DEFAULT_AI_PROVIDER;
}

/** 解析 AI 总结裁剪阈值（1-500，非法值回落默认 50） */
function parseTruncateThreshold(v: string | null): number {
  if (!v) return DEFAULT_AI_SUMMARY_TRUNCATE_THRESHOLD;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AI_SUMMARY_TRUNCATE_THRESHOLD;
  return Math.min(500, Math.floor(n));
}

export const useSettingsStore = defineStore("settings", () => {
  // 主题：复用 composable 的 mode ref（与 useTheme 共享状态）
  const theme = useTheme();

  // 默认值：避免在加载完成前渲染异常
  const themeMode = ref<ThemeMode>(DEFAULT_THEME_MODE);
  const accentColor = ref<string>(DEFAULT_ACCENT_COLOR);
  const newTasksDueToday = ref<boolean>(DEFAULT_NEW_TASKS_DUE_TODAY);
  const recurrenceCheckInterval = ref<number>(DEFAULT_RECURRENCE_CHECK_INTERVAL);
  const startupView = ref<StartupView>(DEFAULT_STARTUP_VIEW);
  const zoomLevel = ref<number>(DEFAULT_ZOOM_LEVEL);
  const templateDefaultListId = ref<string>(DEFAULT_TEMPLATE_LIST_ID);
  /** 笔记模板默认笔记本：笔记模板应用时（非笔记本视图）的兜底目标 */
  const templateDefaultNoteId = ref<string>(DEFAULT_TEMPLATE_NOTE_ID);
  /** 每日固定时点提醒时刻列表（HH:mm，24h 制，字典序升序） */
  const dailyReminderTimes = ref<string[]>([]);

  // ── AI 配置 ──
  const aiEnabled = ref<boolean>(DEFAULT_AI_ENABLED);
  const aiProvider = ref<AiProvider>(DEFAULT_AI_PROVIDER);
  const aiBaseUrl = ref<string>(DEFAULT_AI_BASE_URL);
  const aiApiKey = ref<string>(DEFAULT_AI_API_KEY);
  const aiModel = ref<string>(DEFAULT_AI_MODEL);
  const aiSummaryTruncateThreshold = ref<number>(DEFAULT_AI_SUMMARY_TRUNCATE_THRESHOLD);
  // AI 提示词（默认显示全文，用户可改；后端读到空用默认兜底）
  const aiPromptSmart = ref<string>(DEFAULT_PROMPT_SMART);
  const aiPromptList = ref<string>(DEFAULT_PROMPT_LIST);
  const aiPromptTasks = ref<string>(DEFAULT_PROMPT_TASKS);
  const aiPromptNote = ref<string>(DEFAULT_PROMPT_NOTE);

  const initialized = ref(false);
  const loading = ref(false);
  /** 保存中的 key 集合，用于 UI 反馈 */
  const savingKeys = ref<Set<string>>(new Set());
  const error = ref<string | null>(null);

  function isSaving(key: string): boolean {
    return savingKeys.value.has(key);
  }

  /**
   * 内部通用保存 —— 失败回滚到上一次成功值，并写入错误状态
   */
  async function persist(
    key: string,
    raw: string,
    prev: string | null,
  ): Promise<boolean> {
    savingKeys.value.add(key);
    try {
      await db.setSetting(key, raw);
      error.value = null;
      return true;
    } catch (e) {
      error.value = `保存 ${key} 失败：${String(e)}`;
      console.error("[SettingsStore] setSetting 失败:", key, e);
      // 回滚：把上一次成功值重新写回 store
      if (prev !== null) {
        await db.setSetting(key, prev).catch(() => {});
      }
      return false;
    } finally {
      savingKeys.value.delete(key);
    }
  }

  /** 初始化：一次性从 DB 读取全部设置并应用到 UI */
  async function initialize(): Promise<void> {
    if (initialized.value || loading.value) return;
    loading.value = true;
    try {
      const [themeRaw, accentRaw, dueTodayRaw, intervalRaw, startupRaw, zoomRaw, tplListRaw, tplNoteRaw, dailyTimesRaw, aiEnabledRaw, aiProviderRaw, aiBaseUrlRaw, aiApiKeyRaw, aiModelRaw, aiTruncateRaw, aiPromptSmartRaw, aiPromptListRaw, aiPromptTasksRaw, aiPromptNoteRaw] = await Promise.all([
        db.getSetting(SETTINGS_KEYS.themeMode).catch(() => null),
        db.getSetting(SETTINGS_KEYS.accentColor).catch(() => null),
        db.getSetting(SETTINGS_KEYS.newTasksDueToday).catch(() => null),
        db.getSetting(SETTINGS_KEYS.recurrenceCheckInterval).catch(() => null),
        db.getSetting(SETTINGS_KEYS.startupView).catch(() => null),
        db.getSetting(SETTINGS_KEYS.zoomLevel).catch(() => null),
        db.getSetting(SETTINGS_KEYS.templateDefaultListId).catch(() => null),
        db.getSetting(SETTINGS_KEYS.templateDefaultNoteId).catch(() => null),
        db.getSetting(SETTINGS_KEYS.dailyReminderTimes).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiEnabled).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiProvider).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiBaseUrl).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiApiKey).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiModel).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiSummaryTruncateThreshold).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptSmart).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptList).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptTasks).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptNote).catch(() => null),
      ]);

      const mode = parseThemeMode(themeRaw);
      const accent = parseAccentColor(accentRaw);
      const dueToday = parseBoolean(dueTodayRaw, DEFAULT_NEW_TASKS_DUE_TODAY);
      const interval = parseIntervalMinutes(intervalRaw);
      const startup = parseStartupView(startupRaw);
      const zoom = parseZoomLevel(zoomRaw);
      const tplList = parseTemplateListId(tplListRaw);
      // 笔记模板默认笔记本：空值回落 default-notebook（与任务清单回落 inbox 对称）
      const tplNote = tplNoteRaw && tplNoteRaw.trim() ? tplNoteRaw : DEFAULT_TEMPLATE_NOTE_ID;
      const dailyTimes = parseDailyReminderTimes(dailyTimesRaw);

      themeMode.value = mode;
      accentColor.value = accent;
      newTasksDueToday.value = dueToday;
      recurrenceCheckInterval.value = interval;
      startupView.value = startup;
      zoomLevel.value = zoom;
      templateDefaultListId.value = tplList;
      templateDefaultNoteId.value = tplNote ?? DEFAULT_TEMPLATE_NOTE_ID;
      dailyReminderTimes.value = dailyTimes;

      // AI 配置
      aiEnabled.value = parseBoolean(aiEnabledRaw, DEFAULT_AI_ENABLED);
      aiProvider.value = parseAiProvider(aiProviderRaw);
      aiBaseUrl.value = aiBaseUrlRaw ?? DEFAULT_AI_BASE_URL;
      aiApiKey.value = aiApiKeyRaw ?? DEFAULT_AI_API_KEY;
      aiModel.value = aiModelRaw ?? DEFAULT_AI_MODEL;
      aiSummaryTruncateThreshold.value = parseTruncateThreshold(aiTruncateRaw);
      // AI 提示词：为空（未自定义）则用默认全文，非空用自定义
      aiPromptSmart.value = aiPromptSmartRaw?.trim() ? aiPromptSmartRaw : DEFAULT_PROMPT_SMART;
      aiPromptList.value = aiPromptListRaw?.trim() ? aiPromptListRaw : DEFAULT_PROMPT_LIST;
      aiPromptTasks.value = aiPromptTasksRaw?.trim() ? aiPromptTasksRaw : DEFAULT_PROMPT_TASKS;
      aiPromptNote.value = aiPromptNoteRaw?.trim() ? aiPromptNoteRaw : DEFAULT_PROMPT_NOTE;

      // 先应用强调色（不依赖模式），再应用主题
      theme.setAccentColor(accent);
      theme.setMode(mode);

      // 监听 Rust 端菜单触发的 zoom 变化事件，同步本地 ref
      // 实际窗口缩放由 Rust 端 set_zoom 完成，前端仅维护状态用于 UI 显示
      listenZoomChanged();

      initialized.value = true;
    } catch (e) {
      error.value = `读取设置失败：${String(e)}`;
      console.error("[SettingsStore] 初始化失败:", e);
      // 即使失败也保持默认值，标记为已初始化避免重复尝试
      initialized.value = true;
    } finally {
      loading.value = false;
    }
  }

  /** 切换主题模式并持久化 */
  async function setThemeMode(mode: ThemeMode): Promise<void> {
    const prev = themeMode.value;
    themeMode.value = mode;
    theme.setMode(mode);
    const raw = mode;
    const ok = await persist(SETTINGS_KEYS.themeMode, raw, prev);
    if (!ok) {
      // 回滚 mode ref 与 UI
      themeMode.value = prev;
      theme.setMode(prev);
    }
  }

  /** 切换强调色并持久化 */
  async function setAccentColor(color: string): Promise<void> {
    if (!isValidHexColor(color)) return;
    const prev = accentColor.value;
    accentColor.value = color;
    theme.setAccentColor(color);
    const ok = await persist(SETTINGS_KEYS.accentColor, color, prev);
    if (!ok) {
      accentColor.value = prev;
      theme.setAccentColor(prev);
    }
  }

  /** 切换"自动今天"开关并持久化 */
  async function setNewTasksDueToday(v: boolean): Promise<void> {
    const prev = newTasksDueToday.value;
    newTasksDueToday.value = v;
    const raw = v ? "true" : "false";
    const ok = await persist(SETTINGS_KEYS.newTasksDueToday, raw, String(prev));
    if (!ok) {
      newTasksDueToday.value = prev;
    }
  }

  /** 修改后台检查间隔并持久化（Rust 端依赖该值） */
  async function setRecurrenceCheckInterval(minutes: number): Promise<void> {
    const n = Math.max(1, Math.min(1440, Math.floor(Number(minutes) || 1)));
    const prev = recurrenceCheckInterval.value;
    recurrenceCheckInterval.value = n;
    const ok = await persist(
      SETTINGS_KEYS.recurrenceCheckInterval,
      String(n),
      String(prev),
    );
    if (!ok) {
      recurrenceCheckInterval.value = prev;
    }
  }

  /** 修改启动时打开的视图并持久化 */
  async function setStartupView(v: StartupView): Promise<void> {
    if (!(STARTUP_VIEWS as readonly string[]).includes(v)) return;
    const prev = startupView.value;
    startupView.value = v;
    const ok = await persist(SETTINGS_KEYS.startupView, v, prev);
    if (!ok) {
      startupView.value = prev;
    }
  }

/** 修改模板默认清单并持久化 */
async function setTemplateDefaultListId(v: string): Promise<void> {
  if (!v || !v.trim()) return;
  const prev = templateDefaultListId.value;
  templateDefaultListId.value = v;
  const ok = await persist(SETTINGS_KEYS.templateDefaultListId, v, prev);
  if (!ok) {
    templateDefaultListId.value = prev;
  }
}

/** 修改笔记模板默认笔记本并持久化 */
async function setTemplateDefaultNoteId(v: string): Promise<void> {
  if (!v || !v.trim()) return;
  const prev = templateDefaultNoteId.value;
  templateDefaultNoteId.value = v;
  const ok = await persist(SETTINGS_KEYS.templateDefaultNoteId, v, prev);
  if (!ok) {
    templateDefaultNoteId.value = prev;
  }
}

/**
 * 规范化每日汇总提醒时点：去重 + 合法性校验 + 排序 + 上限裁剪
 * 纯函数（只读入参，返回新数组），供 setter 共用。
 */
function normalizeDailyReminderTimes(times: readonly string[]): string[] {
  const seen: string[] = [];
  for (const t of times) {
    const s = typeof t === "string" ? t.trim() : "";
    if (!s || !isValidHHmm(s)) continue;
    if (!seen.includes(s)) seen.push(s);
    if (seen.length >= MAX_DAILY_REMINDER_TIMES) break;
  }
  seen.sort();
  return seen;
}

/**
 * 修改每日固定时点提醒时刻列表并持久化
 * - 入参合法性由 normalizeDailyReminderTimes 兜底（UI 也应预校验）
 * - 持久化为 CSV "09:00,17:00"；Rust 端 parse_daily_times 解析
 * - 失败回滚到上一次成功的列表
 */
async function setDailyReminderTimes(times: readonly string[]): Promise<void> {
  const valid = normalizeDailyReminderTimes(times);
  const prev = [...dailyReminderTimes.value];
  dailyReminderTimes.value = valid;
  const ok = await persist(
    SETTINGS_KEYS.dailyReminderTimes,
    valid.join(","),
    prev.join(","),
  );
  if (!ok) {
    dailyReminderTimes.value = prev;
  }
}

// ── AI 配置 setter ──────────────────────────────────────
// 均走 persist（乐观更新 + 失败回滚），与现有设置项一致。

/** 切换 AI 总开关并持久化 */
async function setAiEnabled(v: boolean): Promise<void> {
  const prev = aiEnabled.value;
  aiEnabled.value = v;
  const ok = await persist(SETTINGS_KEYS.aiEnabled, v ? "true" : "false", String(prev));
  if (!ok) aiEnabled.value = prev;
}

/** 切换 AI 服务协议并持久化。
 *  注意：不同协议的模型名不通用，UI 层在切换时应同步清空 aiModel。 */
async function setAiProvider(v: AiProvider): Promise<void> {
  if (!(AI_PROVIDERS as readonly string[]).includes(v)) return;
  const prev = aiProvider.value;
  aiProvider.value = v;
  const ok = await persist(SETTINGS_KEYS.aiProvider, v, prev);
  if (!ok) aiProvider.value = prev;
}

/** 修改 API 地址并持久化 */
async function setAiBaseUrl(v: string): Promise<void> {
  const prev = aiBaseUrl.value;
  aiBaseUrl.value = v;
  const ok = await persist(SETTINGS_KEYS.aiBaseUrl, v, prev);
  if (!ok) aiBaseUrl.value = prev;
}

/** 修改 API Key 并持久化（明文存本地 SQLite） */
async function setAiApiKey(v: string): Promise<void> {
  const prev = aiApiKey.value;
  aiApiKey.value = v;
  const ok = await persist(SETTINGS_KEYS.aiApiKey, v, prev);
  if (!ok) aiApiKey.value = prev;
}

/** 修改模型名并持久化 */
async function setAiModel(v: string): Promise<void> {
  const prev = aiModel.value;
  aiModel.value = v;
  const ok = await persist(SETTINGS_KEYS.aiModel, v, prev);
  if (!ok) aiModel.value = prev;
}

/** 修改 AI 总结裁剪阈值并持久化（1-500） */
async function setAiSummaryTruncateThreshold(v: number): Promise<void> {
  const n = parseTruncateThreshold(String(v));
  const prev = aiSummaryTruncateThreshold.value;
  aiSummaryTruncateThreshold.value = n;
  const ok = await persist(SETTINGS_KEYS.aiSummaryTruncateThreshold, String(n), String(prev));
  if (!ok) aiSummaryTruncateThreshold.value = prev;
}

// ── AI 提示词 setter（4 个场景，照搬三步式）──
async function setAiPromptSmart(v: string): Promise<void> {
  const prev = aiPromptSmart.value;
  aiPromptSmart.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptSmart, v, prev);
  if (!ok) aiPromptSmart.value = prev;
}
async function setAiPromptList(v: string): Promise<void> {
  const prev = aiPromptList.value;
  aiPromptList.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptList, v, prev);
  if (!ok) aiPromptList.value = prev;
}
async function setAiPromptTasks(v: string): Promise<void> {
  const prev = aiPromptTasks.value;
  aiPromptTasks.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptTasks, v, prev);
  if (!ok) aiPromptTasks.value = prev;
}
async function setAiPromptNote(v: string): Promise<void> {
  const prev = aiPromptNote.value;
  aiPromptNote.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptNote, v, prev);
  if (!ok) aiPromptNote.value = prev;
}

  /**
   * 监听 Rust 端 zoom-changed 事件
   *
   * Rust 端原生菜单（菜单栏「视图」）触发缩放时会 emit 此事件，
   * 前端接收后同步本地 ref，保证按钮 UI 与原生菜单状态一致。
   * 监听只挂载一次（幂等）。
   */
  let zoomListenRegistered = false;
  async function listenZoomChanged(): Promise<void> {
    if (zoomListenRegistered) return;
    zoomListenRegistered = true;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<number>("zoom-changed", (event) => {
        zoomLevel.value = parseZoomLevel(String(event.payload));
      });
    } catch (e) {
      // 非 Tauri 环境（如纯浏览器开发）下 listen 不存在，静默忽略
      console.warn("[SettingsStore] 监听 zoom-changed 失败:", e);
    }
  }

  /**
   * 实际驱动窗口缩放并持久化
   *
   * 通过 invoke 调用 Rust 命令执行 —— 走 Rust 端 window.set_zoom 可靠路径
   * （前端 JS 的 webview.setZoom 在部分 webview 上不生效）。
   * Rust 端会完成：set_zoom + 持久化 + emit zoom-changed 事件，
   * 前端通过 listenZoomChanged 同步本地 ref。
   */
  async function invokeZoom(cmd: "zoom_in" | "zoom_out" | "zoom_reset"): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<number>(cmd);
      // Rust 端会 emit zoom-changed，listenZoomChanged 会更新 zoomLevel
      // 这里不主动改 ref，避免与事件回调竞争
    } catch (e) {
      console.warn(`[SettingsStore] ${cmd} 调用失败:`, e);
    }
  }

  /** 放大（步长 1.2x，上限 2.0x） */
  async function zoomIn(): Promise<void> {
    await invokeZoom("zoom_in");
  }

  /** 缩小（步长 1.2x，下限 0.5x） */
  async function zoomOut(): Promise<void> {
    await invokeZoom("zoom_out");
  }

  /** 恢复 100% */
  async function zoomReset(): Promise<void> {
    await invokeZoom("zoom_reset");
  }

  /**
   * 主题"toggle"语义：用于顶部按钮 / Cmd+Shift+L
   * - 当前是 system：切到 light
   * - 当前是 light：切到 dark
   * - 当前是 dark：切到 light
   * （显式切到 light/dark 会脱离 system，符合用户"手动覆盖"的直觉）
   */
  async function cycleTheme(): Promise<void> {
    const isDarkNow = theme.isDark.value;
    const next: ThemeMode = isDarkNow ? "light" : "dark";
    await setThemeMode(next);
  }

  return {
    // state
    themeMode,
    accentColor,
    newTasksDueToday,
    recurrenceCheckInterval,
    startupView,
    zoomLevel,
    templateDefaultListId,
    templateDefaultNoteId,
    dailyReminderTimes,
    // AI 配置
    aiEnabled,
    aiProvider,
    aiBaseUrl,
    aiApiKey,
    aiModel,
    aiSummaryTruncateThreshold,
    aiPromptSmart,
    aiPromptList,
    aiPromptTasks,
    aiPromptNote,
    initialized,
    loading,
    error,
    // actions
    initialize,
    setThemeMode,
    setAccentColor,
    setNewTasksDueToday,
    setRecurrenceCheckInterval,
    setStartupView,
    setTemplateDefaultListId,
    setTemplateDefaultNoteId,
    setDailyReminderTimes,
    setAiEnabled,
    setAiProvider,
    setAiBaseUrl,
    setAiApiKey,
    setAiModel,
    setAiSummaryTruncateThreshold,
    setAiPromptSmart,
    setAiPromptList,
    setAiPromptTasks,
    setAiPromptNote,
    cycleTheme,
    zoomIn,
    zoomOut,
    zoomReset,
    isSaving,
  };
});
