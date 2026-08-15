// 应用设置 store —— 集中持久化主题/强调色/自动今天/检查间隔
// 复用现有 SQLite `app_settings` KV 表与 `db.getSetting/setSetting` IPC

import { defineStore } from "pinia";
import { ref } from "vue";
import * as db from "@/api/db";
import { useTheme } from "@/composables/useTheme";
import { isValidHHmm } from "@/utils/date";
import { findSoundOption } from "@/utils/sounds";

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
  /** 任务详情面板宽度（拖拽调整后缓存，下次打开保持） */
  detailPanelWidth: "detail_panel_width",
  /** 任务详情面板最大宽度（px，拖拽上限；外观设置可调） */
  detailPanelMaxWidth: "detail_panel_max_width",
  /** 任务详情面板是否全屏（点击全屏图标后缓存，下次打开保持） */
  detailPanelFullscreen: "detail_panel_fullscreen",
  templateDefaultListId: "template_default_list_id",
  templateDefaultNoteId: "template_default_note_id",
  dailyReminderTimes: "daily_reminder_times",
  /** 任务完成提示音（音效 value，见 utils/sounds.ts；"none" 为静音） */
  completionSound: "completion_sound",
  /** 任务到期提醒提示音 */
  dueReminderSound: "due_reminder_sound",
  /** 每日固定提醒提示音 */
  dailyReminderSound: "daily_reminder_sound",
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
  /** 自然语言建任务提示词 */
  aiPromptParseTask: "ai_prompt_parse_task",
  /** 任务拆解提示词 */
  aiPromptBreakdownTask: "ai_prompt_breakdown_task",
  /** 文本提取任务提示词 */
  aiPromptExtractTasks: "ai_prompt_extract_tasks",
  /** 文本润色提示词 */
  aiPromptPolish: "ai_prompt_polish",
  /** 智能体（Agent）系统提示词 */
  aiPromptAgent: "ai_prompt_agent",
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

// ── 提示音默认值（值来自 utils/sounds.ts 的 SOUND_OPTIONS；"none" 为静音）──
/** 任务完成提示音：叮当 */
const DEFAULT_COMPLETION_SOUND = "jingle";
/** 任务到期提醒提示音：经典叮 */
const DEFAULT_DUE_REMINDER_SOUND = "default";
/** 每日固定提醒提示音：竖琴 */
const DEFAULT_DAILY_REMINDER_SOUND = "harp";

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

export const DEFAULT_PROMPT_PARSE_TASK = `你是一个任务解析助手。根据用户的自然语言输入，提取任务的结构化信息并调用 parse_task 工具。

规则：
1. 标题：提取去掉时间/优先级/标签等修饰词后的核心内容
2. 优先级：识别「高优/紧急/重要」→3，「中/一般」→2，「低」→1，无明确表示→0
3. 截止时间：解析「明天/后天/下周一/3点/下午」等表达，换算成具体时间。若只提到日期无具体时间，结束时间用当天 23:59:59
4. 标签：识别 # 后面的词作为标签名（不含#）
5. 无法确定的字段不要编造，省略即可（除了 title 必填）
6. 时间格式：YYYY-MM-DDTHH:mm:ss（本地时间）
7. 详情正文(note)：总结并扩充用户输入的内容，生成一段简洁的任务描述（HTML 的 <p> 标签即可）。
   要基于用户实际输入来总结，不要套模板或编造无关内容。例如：
   - 「周五早上开周会」→ 「<p>周五早上召开周例会，回顾本周工作进展，同步下周计划，讨论遇到的问题。</p>」
   - 「准备季度汇报」→ 「<p>准备季度工作汇报，整理本季度主要成果、数据分析及下季度计划。</p>」
   简单的任务（如「买菜」）可省略 note`;

export const DEFAULT_PROMPT_BREAKDOWN_TASK = `你是一个任务拆解助手。用户会给你一个大任务，你需要把它拆解成 3-8 个具体、可执行的子任务，并调用 breakdown_task 工具返回。

拆解规则：
1. 子任务数量：3-8 个，过少不够细致，过多难以管理。大任务本身不要作为一个子任务。
2. 标题：简洁明确的动作短语，如「收集本月销售数据」「撰写汇报大纲」「制作 PPT」。
3. 优先级：识别子任务的重要性和紧急程度。「关键路径/必须先完成」→3，「一般」→2，「辅助/可选」→1，无法判断→0。
4. 截止时间：如果父任务有截止时间，子任务应合理分布在父任务截止之前（前面的子任务更早）；
   若无明确截止时间，可省略。时间格式 YYYY-MM-DDTHH:mm:ss（本地时间），只到日期的用当天 23:59:59。
5. 备注(note)：为每个子任务生成一段简短的执行说明（HTML 的 <p> 标签），说明具体要做什么、注意什么。
   要基于实际任务内容来写，不要套模板或编造无关内容。
6. 子任务之间应有合理的先后顺序，按顺序排列。

示例：
- 大任务「准备季度汇报」→ 子任务：收集本季度数据 / 撰写汇报大纲 / 制作PPT / 内部评审彩排
- 大任务「组织团建活动」→ 子任务：确定活动预算 / 调查参与人数和意向 / 预订场地 / 发布活动通知 / 准备活动物资`;

export const DEFAULT_PROMPT_EXTRACT_TASKS = `你是一个任务提取助手。用户会给你一段文本（如会议纪要、邮件、聊天记录），你需要从中提取出所有隐含的、需要执行的待办任务，并调用 extract_tasks 工具返回。

提取规则：
1. 只提取"需要有人去做"的行动项，跳过纯信息陈述、已完成的、讨论性内容。
2. 标题：把口语化/隐含的行动项改写成简洁明确的任务标题（动作短语），如「整理本月销售数据」「回复客户合同邮件」。
3. 优先级：识别紧迫程度。明确提到「紧急/尽快/马上」→3，正常 →2，低优先级 →1，无法判断 →0。
4. 截止时间：从文本中识别明确的截止日期（如「周五前」「下周一」「7月15号前」），换算成具体时间。
   时间格式 YYYY-MM-DDTHH:mm:ss（本地时间），只到日期的用当天 23:59:59。无明确截止则省略。
5. 备注(note)：如果行动项有关键背景信息（如负责人、具体要求），用 HTML 的 <p> 标签简短记录。无则省略。
6. 如果文本中确实没有可提取的行动项，返回空数组。

示例：
- 「明天开会讨论Q3规划，小王负责准备数据，周五前发给大家」→
  ①「准备Q3规划会议数据」(负责人小王) ②「发送Q3规划数据给团队」(周五前)`;

export const DEFAULT_PROMPT_AGENT = `你是 JustToDo 待办应用内的 AI 助手，可以通过调用工具查询和操作用户的任务与笔记。

工作准则：
1. 回答问题前先用工具查询真实数据，不要凭空猜测或编造任务内容
2. 涉及具体任务时，引用真实的标题、清单名、截止时间
3. 用户提到「这个清单」等上下文指代时，参考系统提示末尾注入的当前上下文
4. 时间一律用当前时间锚点换算成绝对日期再表达
5. 回答用简体中文，简洁友好，适合直接阅读；列表用 Markdown
6. 查不到数据就如实说明，不要虚构
7. 用户说「它/他/这个任务/刚才那个」等指代时，优先结合会话上下文推断所指
   （通常是最近创建或讨论的任务，其 id 在之前的工具结果里，直接使用无需再问）；
   上下文确实无法推断时，先用工具查最近创建/最相关的任务再向用户确认，不要直接说不知道`;

export const DEFAULT_PROMPT_POLISH = `你是一个专业的中文文本润色助手。用户会给你一段文本（可能含 HTML 标签），你需要润色后返回。

润色规则：
1. 修正语病、错别字、标点错误
2. 理顺句子逻辑，优化表达，使文字更流畅、更专业
3. 保持原文的核心意思和风格不变，不要增删实质内容
4. **必须保留原有的 HTML 标签结构**（如 <p>、<strong>、<ul>、<li>、<h2> 等），只润色标签内的文字
5. 如果原文是纯文本（无 HTML 标签），返回纯文本
6. 直接输出润色后的完整文本，不要加任何解释说明`;

/** 窗口缩放级别上下限（与 Rust 端 menu.rs 保持一致） */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const DEFAULT_ZOOM_LEVEL = 1.0;

/** 任务详情面板最大宽度（px）：默认 720，外观设置可调（480~1200） */
const DEFAULT_DETAIL_PANEL_MAX_WIDTH = 720;
/** 详情面板最大宽度的可调范围 */
const DETAIL_PANEL_MAX_WIDTH_MIN = 480;
const DETAIL_PANEL_MAX_WIDTH_MAX = 1200;

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

/** 详情面板最大宽度解析：非法值回落默认（480~1200 范围校验） */
function parsePanelMaxWidth(v: string | null): number {
  if (!v) return DEFAULT_DETAIL_PANEL_MAX_WIDTH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DETAIL_PANEL_MAX_WIDTH;
  return Math.max(
    DETAIL_PANEL_MAX_WIDTH_MIN,
    Math.min(DETAIL_PANEL_MAX_WIDTH_MAX, Math.floor(n)),
  );
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
  /** 任务详情面板最大宽度（px，拖拽上限；外观设置可调） */
  const detailPanelMaxWidth = ref<number>(DEFAULT_DETAIL_PANEL_MAX_WIDTH);
  const templateDefaultListId = ref<string>(DEFAULT_TEMPLATE_LIST_ID);
  /** 笔记模板默认笔记本：笔记模板应用时（非笔记本视图）的兜底目标 */
  const templateDefaultNoteId = ref<string>(DEFAULT_TEMPLATE_NOTE_ID);
  /** 每日固定时点提醒时刻列表（HH:mm，24h 制，字典序升序） */
  const dailyReminderTimes = ref<string[]>([]);
  // ── 提示音（默认值见 DEFAULT_SOUND_* 常量；"none" 为静音）──
  const completionSound = ref<string>(DEFAULT_COMPLETION_SOUND);
  const dueReminderSound = ref<string>(DEFAULT_DUE_REMINDER_SOUND);
  const dailyReminderSound = ref<string>(DEFAULT_DAILY_REMINDER_SOUND);

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
  const aiPromptParseTask = ref<string>(DEFAULT_PROMPT_PARSE_TASK);
  const aiPromptBreakdownTask = ref<string>(DEFAULT_PROMPT_BREAKDOWN_TASK);
  const aiPromptExtractTasks = ref<string>(DEFAULT_PROMPT_EXTRACT_TASKS);
  const aiPromptPolish = ref<string>(DEFAULT_PROMPT_POLISH);
  const aiPromptAgent = ref<string>(DEFAULT_PROMPT_AGENT);

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
      const [themeRaw, accentRaw, dueTodayRaw, intervalRaw, startupRaw, zoomRaw, tplListRaw, tplNoteRaw, dailyTimesRaw, completionSoundRaw, dueReminderSoundRaw, dailyReminderSoundRaw, panelMaxWidthRaw, aiEnabledRaw, aiProviderRaw, aiBaseUrlRaw, aiApiKeyRaw, aiModelRaw, aiTruncateRaw, aiPromptSmartRaw, aiPromptListRaw, aiPromptTasksRaw, aiPromptNoteRaw, aiPromptParseTaskRaw, aiPromptBreakdownTaskRaw, aiPromptExtractTasksRaw, aiPromptPolishRaw, aiPromptAgentRaw] = await Promise.all([
        db.getSetting(SETTINGS_KEYS.themeMode).catch(() => null),
        db.getSetting(SETTINGS_KEYS.accentColor).catch(() => null),
        db.getSetting(SETTINGS_KEYS.newTasksDueToday).catch(() => null),
        db.getSetting(SETTINGS_KEYS.recurrenceCheckInterval).catch(() => null),
        db.getSetting(SETTINGS_KEYS.startupView).catch(() => null),
        db.getSetting(SETTINGS_KEYS.zoomLevel).catch(() => null),
        db.getSetting(SETTINGS_KEYS.templateDefaultListId).catch(() => null),
        db.getSetting(SETTINGS_KEYS.templateDefaultNoteId).catch(() => null),
        db.getSetting(SETTINGS_KEYS.dailyReminderTimes).catch(() => null),
        db.getSetting(SETTINGS_KEYS.completionSound).catch(() => null),
        db.getSetting(SETTINGS_KEYS.dueReminderSound).catch(() => null),
        db.getSetting(SETTINGS_KEYS.dailyReminderSound).catch(() => null),
        db.getSetting(SETTINGS_KEYS.detailPanelMaxWidth).catch(() => null),
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
        db.getSetting(SETTINGS_KEYS.aiPromptParseTask).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptBreakdownTask).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptExtractTasks).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptPolish).catch(() => null),
        db.getSetting(SETTINGS_KEYS.aiPromptAgent).catch(() => null),
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
      const panelMaxWidth = parsePanelMaxWidth(panelMaxWidthRaw);

      themeMode.value = mode;
      accentColor.value = accent;
      newTasksDueToday.value = dueToday;
      recurrenceCheckInterval.value = interval;
      startupView.value = startup;
      zoomLevel.value = zoom;
      templateDefaultListId.value = tplList;
      detailPanelMaxWidth.value = panelMaxWidth;
      templateDefaultNoteId.value = tplNote ?? DEFAULT_TEMPLATE_NOTE_ID;
      dailyReminderTimes.value = dailyTimes;
      // 提示音：非法值回落默认（parseSoundValue 校验）
      completionSound.value = parseSoundValue(completionSoundRaw, DEFAULT_COMPLETION_SOUND);
      dueReminderSound.value = parseSoundValue(dueReminderSoundRaw, DEFAULT_DUE_REMINDER_SOUND);
      dailyReminderSound.value = parseSoundValue(dailyReminderSoundRaw, DEFAULT_DAILY_REMINDER_SOUND);

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
      aiPromptParseTask.value = aiPromptParseTaskRaw?.trim() ? aiPromptParseTaskRaw : DEFAULT_PROMPT_PARSE_TASK;
      aiPromptBreakdownTask.value = aiPromptBreakdownTaskRaw?.trim() ? aiPromptBreakdownTaskRaw : DEFAULT_PROMPT_BREAKDOWN_TASK;
      aiPromptExtractTasks.value = aiPromptExtractTasksRaw?.trim() ? aiPromptExtractTasksRaw : DEFAULT_PROMPT_EXTRACT_TASKS;
      aiPromptPolish.value = aiPromptPolishRaw?.trim() ? aiPromptPolishRaw : DEFAULT_PROMPT_POLISH;
      aiPromptAgent.value = aiPromptAgentRaw?.trim() ? aiPromptAgentRaw : DEFAULT_PROMPT_AGENT;

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

  /** 修改详情面板最大宽度并持久化（范围 480~1200） */
  async function setDetailPanelMaxWidth(px: number): Promise<void> {
    const n = Math.max(
      DETAIL_PANEL_MAX_WIDTH_MIN,
      Math.min(DETAIL_PANEL_MAX_WIDTH_MAX, Math.floor(Number(px) || DEFAULT_DETAIL_PANEL_MAX_WIDTH)),
    );
    const prev = detailPanelMaxWidth.value;
    detailPanelMaxWidth.value = n;
    const ok = await persist(
      SETTINGS_KEYS.detailPanelMaxWidth,
      String(n),
      String(prev),
    );
    if (!ok) {
      detailPanelMaxWidth.value = prev;
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
 * 解析提示音设置值：空/非法（不在 SOUND_OPTIONS 中）回落默认值。
 * 纯函数，供 initialize 使用。
 */
function parseSoundValue(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  return findSoundOption(raw) ? raw : fallback;
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

// ── 提示音 setter（照搬三步式：乐观更新 + persist 失败回滚）──

/** 修改任务完成提示音并持久化 */
async function setCompletionSound(v: string): Promise<void> {
  const prev = completionSound.value;
  completionSound.value = v;
  const ok = await persist(SETTINGS_KEYS.completionSound, v, prev);
  if (!ok) completionSound.value = prev;
}

/** 修改任务到期提醒提示音并持久化 */
async function setDueReminderSound(v: string): Promise<void> {
  const prev = dueReminderSound.value;
  dueReminderSound.value = v;
  const ok = await persist(SETTINGS_KEYS.dueReminderSound, v, prev);
  if (!ok) dueReminderSound.value = prev;
}

/** 修改每日固定提醒提示音并持久化 */
async function setDailyReminderSound(v: string): Promise<void> {
  const prev = dailyReminderSound.value;
  dailyReminderSound.value = v;
  const ok = await persist(SETTINGS_KEYS.dailyReminderSound, v, prev);
  if (!ok) dailyReminderSound.value = prev;
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
async function setAiPromptParseTask(v: string): Promise<void> {
  const prev = aiPromptParseTask.value;
  aiPromptParseTask.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptParseTask, v, prev);
  if (!ok) aiPromptParseTask.value = prev;
}
async function setAiPromptBreakdownTask(v: string): Promise<void> {
  const prev = aiPromptBreakdownTask.value;
  aiPromptBreakdownTask.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptBreakdownTask, v, prev);
  if (!ok) aiPromptBreakdownTask.value = prev;
}
async function setAiPromptExtractTasks(v: string): Promise<void> {
  const prev = aiPromptExtractTasks.value;
  aiPromptExtractTasks.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptExtractTasks, v, prev);
  if (!ok) aiPromptExtractTasks.value = prev;
}
async function setAiPromptPolish(v: string): Promise<void> {
  const prev = aiPromptPolish.value;
  aiPromptPolish.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptPolish, v, prev);
  if (!ok) aiPromptPolish.value = prev;
}
async function setAiPromptAgent(v: string): Promise<void> {
  const prev = aiPromptAgent.value;
  aiPromptAgent.value = v;
  const ok = await persist(SETTINGS_KEYS.aiPromptAgent, v, prev);
  if (!ok) aiPromptAgent.value = prev;
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
    detailPanelMaxWidth,
    templateDefaultListId,
    templateDefaultNoteId,
    dailyReminderTimes,
    // 提示音
    completionSound,
    dueReminderSound,
    dailyReminderSound,
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
    aiPromptParseTask,
    aiPromptBreakdownTask,
    aiPromptExtractTasks,
    aiPromptPolish,
    aiPromptAgent,
    initialized,
    loading,
    error,
    // actions
    initialize,
    setThemeMode,
    setAccentColor,
    setNewTasksDueToday,
    setRecurrenceCheckInterval,
    setDetailPanelMaxWidth,
    setStartupView,
    setTemplateDefaultListId,
    setTemplateDefaultNoteId,
    setDailyReminderTimes,
    setCompletionSound,
    setDueReminderSound,
    setDailyReminderSound,
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
    setAiPromptParseTask,
    setAiPromptBreakdownTask,
    setAiPromptExtractTasks,
    setAiPromptPolish,
    setAiPromptAgent,
    cycleTheme,
    zoomIn,
    zoomOut,
    zoomReset,
    isSaving,
  };
});
