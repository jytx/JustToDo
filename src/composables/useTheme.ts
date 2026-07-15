// 主题 + 强调色 composable
// - mode 反映用户选择（light / dark / system）
// - isDark 反映当前 DOM 实际生效的深浅（受 system 影响）
// - 强调色通过 CSS 变量统一应用到 Arco 与自定义 token
// - 持久化由 settings store 负责，本模块只负责"应用"

import { ref, computed } from "vue";

export type ThemeMode = "light" | "dark" | "system";

const initialMode: ThemeMode =
  (document.body.getAttribute("arco-theme") as "dark" | "" | null) === "dark"
    ? "dark"
    : "light";

const mode = ref<ThemeMode>(initialMode);
const isDark = ref<boolean>(document.body.getAttribute("arco-theme") === "dark");

const mql: MediaQueryList | null =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function effectiveIsDark(m: ThemeMode): boolean {
  if (m === "dark") return true;
  if (m === "light") return false;
  // system
  return mql?.matches ?? false;
}

function applyToDom(dark: boolean): void {
  isDark.value = dark;
  document.body.setAttribute("arco-theme", dark ? "dark" : "");
}

/** 浅色 hex 调整成深色 hex —— 简单提亮：mix with white */
function lightenForDark(hex: string): string {
  // 简单实现：与白色按 30% 混合
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.3);
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

let mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;

function setMode(m: ThemeMode): void {
  mode.value = m;
  applyToDom(effectiveIsDark(m));

  // 卸载旧的 system 监听
  if (mqlHandler && mql) {
    mql.removeEventListener("change", mqlHandler);
    mqlHandler = null;
  }
  // 仅在 system 模式下挂监听
  if (m === "system" && mql) {
    mqlHandler = () => applyToDom(effectiveIsDark("system"));
    mql.addEventListener("change", mqlHandler);
  }
}

/**
 * 应用强调色到 CSS 变量。
 * 通过 document.documentElement 的 inline style 覆盖主题文件中的默认值，
 * 不需要修改 theme.css。
 */
function setAccentColor(hex: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const root = document.documentElement;
  const darkHex = lightenForDark(hex);

  // 浅色模式：直接使用用户选择的 hex
  // 深色模式：使用提亮版本
  // 这里把两个变量都写到 inline style，由 body[arco-theme="dark"] 重新覆盖深色值
  root.style.setProperty("--jt-accent", hex);
  root.style.setProperty("--jt-primary", hex);
  root.style.setProperty("--jt-accent-soft", `color-mix(in srgb, ${hex} 12%, transparent)`);

  // 深色模式下的强调色（与浅色独立）
  // 通过把深色版写入 --jt-accent-dark 占位变量，body[arco-theme="dark"] 选择器通过
  // 我们直接修改对应选择器太麻烦，这里采用一个变通：把深色变量也写到 root，由
  // CSS 中既有规则读取。如果未来需要更精细控制可改为在 theme.css 添加专用选择器。
  root.style.setProperty("--jt-accent-dark", darkHex);
  root.style.setProperty("--jt-primary-dark", darkHex);

  // Arco 主色 —— 注意：Arco --primary-* 要 "R, G, B" 三元组字符串，
  // 它内部用 rgb(var(--primary-6)) 拼装。如果给 hex 会被忽略并 fallback。
  const rgb = hexToRgbTriple(hex);
  const darkRgb = hexToRgbTriple(darkHex);
  root.style.setProperty("--primary-6", rgb);
  root.style.setProperty("--primary-5", darkRgb);
  root.style.setProperty("--primary-7", darkRgb);

  // Arco 在 body 上把 --primary-6 重新指向 var(--arcoblue-6)。
  // 仅覆盖 --primary-* 会被 body 规则按 cascade 顺序吃掉，必须连 arcoblue 一起覆盖。
  // 同时提供 --jt-*-rgb 占位供 theme.css 的 body 末尾覆盖读取。
  root.style.setProperty("--arcoblue-6", rgb);
  root.style.setProperty("--arcoblue-5", darkRgb);
  root.style.setProperty("--arcoblue-7", darkRgb);

  root.style.setProperty("--jt-primary-rgb", rgb);
  root.style.setProperty("--jt-primary-rgb-hover", darkRgb);
  root.style.setProperty("--jt-primary-rgb-active", darkRgb);
  root.style.setProperty("--jt-accent-dark-rgb", darkRgb);
}

/** "#RRGGBB" → "R, G, B"（Arco 主题变量期望的格式） */
function hexToRgbTriple(hex: string): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function toggleTheme(): void {
  // 仅在 isDark 之间切换；外部 store 负责把"system"显式化为 light/dark
  const next = !isDark.value;
  mode.value = next ? "dark" : "light";
  applyToDom(next);
}

function setDark(dark: boolean): void {
  mode.value = dark ? "dark" : "light";
  applyToDom(dark);
}

export function useTheme() {
  return {
    /** 用户当前选择的主题模式 */
    mode: computed(() => mode.value),
    /** 当前 DOM 实际生效的深浅（受 system 模式影响） */
    isDark: computed(() => isDark.value),
    /** 切到具体 light/dark —— 不影响 system 监听 */
    setMode,
    setDark,
    setAccentColor,
    /** 二态切换（用于旧 API 兼容/旧入口） */
    toggleTheme,
  };
}
