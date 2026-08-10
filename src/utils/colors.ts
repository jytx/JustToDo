// 清单 / 标签等通用预设颜色
// 抽取自 TheSidebar.vue，供清单、清单生成计划等多处复用（避免 DRY）

/** 8 种预定义颜色（红/橙/黄/绿/蓝/紫/粉/灰） */
export const LIST_COLORS: readonly string[] = [
  "#EF4444",
  "#F59E0B",
  "#EAB308",
  "#10B981",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#6B7280",
];

/** 从预设色中随机取一个（用于缺省颜色） */
export function randomListColor(): string {
  const idx = Math.floor(Math.random() * LIST_COLORS.length);
  return LIST_COLORS[idx]!;
}

/**
 * 生成标签 chip 的淡色背景 CSS 值（12% 透明叠加）。
 * 所有渲染标签 chip 的地方复用，保持淡色底风格一致。
 */
export function tagBg(color: string): string {
  return `color-mix(in srgb, ${color} 12%, transparent)`;
}

/**
 * 生成标签 chip 的边框 CSS 值（22% 透明叠加，轻微描边增加区分度）。
 */
export function tagBorder(color: string): string {
  return `color-mix(in srgb, ${color} 22%, transparent)`;
}
