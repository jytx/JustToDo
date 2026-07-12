// 日期工具 —— 将 ISO 时间格式化为 UI 友好的相对/绝对文本
// 遵循 UI 设计：逾期用红字，今天到期加粗

/** 判断日期是否是今天 */
function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

/** 判断日期是否是昨天 */
function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  );
}

/** 判断日期是否是明天 */
function isTomorrow(date: Date): boolean {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return (
    date.getDate() === tomorrow.getDate() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getFullYear() === tomorrow.getFullYear()
  );
}

/** 判断日期是否在本周内（今天到 6 天后） */
function isThisWeek(date: Date): boolean {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  const days = diff / (1000 * 60 * 60 * 24);
  return days >= 0 && days < 7;
}

export type DueDateInfo = {
  text: string;
  /** 是否逾期 */
  overdue: boolean;
  /** 是否今天到期（UI 加粗） */
  isToday: boolean;
};

/** 格式化单个日期为简短文本（内部辅助） */
function formatSingle(date: Date): string {
  if (isToday(date)) return "今天";
  if (isTomorrow(date)) return "明天";
  if (isThisWeek(date)) {
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return weekdays[date.getDay()];
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 格式化截止日期为 UI 文本（支持开始~结束范围） */
export function formatDueDate(
  startIso: string | null,
  endIso: string | null,
): DueDateInfo | null {
  // 两个字段都为空 → 无截止日期
  if (!startIso && !endIso) return null;

  // 只有结束日期（兼容旧数据）
  if (!startIso && endIso) {
    return formatSingleDate(endIso);
  }

  // 只有开始日期
  if (startIso && !endIso) {
    return formatSingleDate(startIso);
  }

  // 有范围：开始和结束都存在
  const start = new Date(startIso!);
  const end = new Date(endIso!);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  // 同一天 → 按单日显示
  const sameDay =
    start.getDate() === end.getDate() &&
    start.getMonth() === end.getMonth() &&
    start.getFullYear() === end.getFullYear();

  if (sameDay) {
    return formatSingleDate(endIso!);
  }

  // 跨天 → "开始 ~ 结束"
  const now = new Date();
  const overdue = end.getTime() < now.getTime() && !isToday(end);
  const isTodayRange = isToday(start) || isToday(end);

  return {
    text: `${formatSingle(start)} ~ ${formatSingle(end)}`,
    overdue,
    isToday: isTodayRange,
  };
}

/** 格式化单个日期（含逾期/今天判断） */
function formatSingleDate(iso: string): DueDateInfo | null {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  const now = new Date();
  const overdue = date.getTime() < now.getTime() && !isToday(date);

  if (isToday(date)) {
    return { text: "今天", overdue: false, isToday: true };
  }
  if (isYesterday(date)) {
    return { text: "昨天", overdue: true, isToday: false };
  }

  return { text: formatSingle(date), overdue, isToday: false };
}

/** 格式化页面副标题的日期（如"7月10日 · 周四"） */
export function formatPageDate(date: Date = new Date()): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${month}月${day}日 · ${weekdays[date.getDay()]}`;
}
