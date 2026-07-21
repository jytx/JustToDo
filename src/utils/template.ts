// 模板占位符替换 —— 纯函数，不修改入参
//
// 应用模板时把 title / note 里的占位符替换为实际值。
// 当前支持的占位符：
//   {{date_cn}}  → 今天日期中文格式（如 "2026年7月21日"）
//
// 未识别的占位符（如 {{foo}}）保持原样，避免误伤模板里的字面文字。
// 设计原则：只做 MVP 必要的替换，更多占位符可独立迭代。

/** 占位符 → 替换值 的映射（每次调用时根据「今天」实时计算） */
function buildPlaceholderValues(now: Date = new Date()): Record<string, string> {
  return {
    // 中文日期格式：YYYY年M月D日（月/日不补零，更符合中文习惯）
    date_cn: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
  };
}

/**
 * 替换字符串里的占位符
 *
 * @param text 模板原文（title 或 note）
 * @param now 当前时间（默认 new Date()，仅用于测试可注入）
 * @returns 替换后的字符串；入参不被修改
 *
 * @example
 *   replacePlaceholders("{{date_cn}} 会议纪要")  // "2026年7月21日 会议纪要"
 *   replacePlaceholders("{{foo}}")               // "{{foo}}"（未识别保持原样）
 */
export function replacePlaceholders(text: string, now: Date = new Date()): string {
  if (!text) return text;
  const values = buildPlaceholderValues(now);
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in values ? values[key] : match;
  });
}
