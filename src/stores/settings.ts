// 应用设置 store —— 集中持久化主题/强调色/自动今天/检查间隔
// 复用现有 SQLite `app_settings` KV 表与 `db.getSetting/setSetting` IPC

import { defineStore } from "pinia";
import { ref } from "vue";
import * as db from "@/api/db";
import { useTheme } from "@/composables/useTheme";

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
} as const;

const DEFAULT_THEME_MODE: ThemeMode = "system";
const DEFAULT_ACCENT_COLOR = "#4F46E5";
const DEFAULT_NEW_TASKS_DUE_TODAY = true;
const DEFAULT_RECURRENCE_CHECK_INTERVAL = 60;

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

export const useSettingsStore = defineStore("settings", () => {
  // 主题：复用 composable 的 mode ref（与 useTheme 共享状态）
  const theme = useTheme();

  // 默认值：避免在加载完成前渲染异常
  const themeMode = ref<ThemeMode>(DEFAULT_THEME_MODE);
  const accentColor = ref<string>(DEFAULT_ACCENT_COLOR);
  const newTasksDueToday = ref<boolean>(DEFAULT_NEW_TASKS_DUE_TODAY);
  const recurrenceCheckInterval = ref<number>(DEFAULT_RECURRENCE_CHECK_INTERVAL);

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
      const [themeRaw, accentRaw, dueTodayRaw, intervalRaw] = await Promise.all([
        db.getSetting(SETTINGS_KEYS.themeMode).catch(() => null),
        db.getSetting(SETTINGS_KEYS.accentColor).catch(() => null),
        db.getSetting(SETTINGS_KEYS.newTasksDueToday).catch(() => null),
        db.getSetting(SETTINGS_KEYS.recurrenceCheckInterval).catch(() => null),
      ]);

      const mode = parseThemeMode(themeRaw);
      const accent = parseAccentColor(accentRaw);
      const dueToday = parseBoolean(dueTodayRaw, DEFAULT_NEW_TASKS_DUE_TODAY);
      const interval = parseIntervalMinutes(intervalRaw);

      themeMode.value = mode;
      accentColor.value = accent;
      newTasksDueToday.value = dueToday;
      recurrenceCheckInterval.value = interval;

      // 先应用强调色（不依赖模式），再应用主题
      theme.setAccentColor(accent);
      theme.setMode(mode);

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
    initialized,
    loading,
    error,
    // actions
    initialize,
    setThemeMode,
    setAccentColor,
    setNewTasksDueToday,
    setRecurrenceCheckInterval,
    cycleTheme,
    isSaving,
  };
});
