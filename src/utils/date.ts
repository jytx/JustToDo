// 日期工具 —— 统一以"本地时间字面量"（YYYY-MM-DDTHH:mm:ss，无时区标记）作为存储/比较格式
// 避免 new Date() ↔ toISOString() 来回弹造成的时区偏差

/** 本地时间字面量正则（支持无秒、含秒；容忍空格或 T 分隔） */
const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * 把"本地时间字面量"解析为本地 Date
 * 不会让 JS 引擎自己误判时区（无 Z/偏移时按本地构造）
 */
export function parseLocalIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = LOCAL_ISO_RE.exec(iso);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0"),
    0,
  );
}

/**
 * 钳制日期区间，保证 end 不早于 start。
 *
 * 倒挂数据（end < start）会导致 FullCalendar 解析时丢弃 end（core parseSingle 的
 * endMarker <= startMarker → null 分支），连锁引发日历事件无 end、拖拽失效、
 * 显示异常等问题。所有写入 dueStartAt / dueEndAt 的入口都应过一遍此函数。
 *
 * 处理规则：
 *   - start / end 任一为 null 或 undefined → 原样返回（无法比较，不干预开放区间任务）
 *   - end >= start → 原样返回
 *   - end < start → 把 end 钳制成 = start（零时长，非交换，符合用户选的"钳制"策略）
 *
 * 纯函数：不修改入参，返回新元组。
 */
export function clampDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
): [string | null, string | null] {
  if (!start || !end) return [start ?? null, end ?? null];
  const s = parseLocalIso(start);
  const e = parseLocalIso(end);
  // 解析失败（格式异常）→ 不干预，交给下游处理
  if (!s || !e) return [start ?? null, end ?? null];
  if (e.getTime() < s.getTime()) {
    // end 早于 start：钳制 end 到 = start
    return [start ?? null, start ?? null];
  }
  return [start ?? null, end ?? null];
}

/** 提取 YYYY-MM-DD 部分（用于 range-picker "YYYY-MM-DD HH:mm" 展示） */
export function localIsoToDateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = LOCAL_ISO_RE.exec(iso);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * 把 picker 字符串（"2026-07-14" / "2026-07-14 09:00" / "2026-07-14T09:00"）规范化为
 * 完整的本地时间字面量 "2026-07-14T09:00:00"。返回 null 表示输入为空或非法。
 */
export function toLocalIso(pickerStr: string | null | undefined): string | null {
  if (!pickerStr) return null;
  const m = LOCAL_ISO_RE.exec(pickerStr);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}`;
}

/**
 * 把本地 Date 转成本地时间字面量 "YYYY-MM-DDTHH:mm:ss"
 *
 * 与 toLocalIso 的区别：toLocalIso 接收字符串/字面量；dateToLocalIso 接收 JS Date。
 * 用于 FullCalendar event.start / event.end 这种 Date 对象转回本地字面量。
 * 用 getFullYear/Month/Date/Hours/Minutes/Seconds 取本地时间分量，
 * 避免 toISOString() 把本地时间转成 UTC 引起时区漂移。
 *
 * 注意：toLocalIso(dateObj) 会返回 null（Date.toString() 不匹配 LOCAL_ISO_RE），
 * 误用会导致任务 due_start_at 被清空、任务从日历上消失。
 */
export function dateToLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 把本地时间字面量转回 picker 用的 "YYYY-MM-DD HH:mm" 格式 */
export function fromLocalIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = LOCAL_ISO_RE.exec(iso);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** 返回当前本地时间的字面量（用于"今天兑底"） */
export function nowLocalIso(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/** 今天的日期范围：本地 00:00:00 ~ 23:59:59（字面量，无时区标记）。 */
export function todayRange(): [string, string] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 0);
  return [nowLocalIso(start), nowLocalIso(end)];
}

/** 判断日期是否是今天（接受 Date） */
function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

/** ISO 字符串是否带有"非零"时分秒（精度 > 天） */
function hasTimePart(iso: string): boolean {
  // 本地时间字面量 "YYYY-MM-DDTHH:mm:ss"，取 T/HH:MM 部分
  const m = iso.match(/[T ](\d{2}):(\d{2})/);
  if (!m) return false;
  return !(m[1] === "00" && m[2] === "00");
}

/** 提取 HH:mm 部分（用于"今天 14:00"格式） */
function timeOf(iso: string): string {
  const m = iso.match(/[T ](\d{2}):(\d{2})/);
  if (!m) return "00:00";
  return `${m[1]}:${m[2]}`;
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

/** 把本地时间字面量转成本地 Date（不重新拼字段以避免精度损失） */
function localIsoToDate(iso: string): Date | null {
  return parseLocalIso(iso);
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
  const start = localIsoToDate(startIso!);
  const end = localIsoToDate(endIso!);
  if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  // 同一天 → 按单日显示（带上时间）
  const sameDay =
    start.getDate() === end.getDate() &&
    start.getMonth() === end.getMonth() &&
    start.getFullYear() === end.getFullYear();

  if (sameDay) {
    return formatSingleDate(endIso!);
  }

  // 跨天 → "开始 ~ 结束"（带时间）
  const startHasTime = hasTimePart(startIso!);
  const endHasTime = hasTimePart(endIso!);
  const startText = `${formatSingle(start)}${startHasTime ? " " + timeOf(startIso!) : ""}`;
  const endText = `${formatSingle(end)}${endHasTime ? " " + timeOf(endIso!) : ""}`;

  const now = new Date();
  const overdue = end.getTime() < now.getTime() && !isToday(end);
  const isTodayRange = isToday(start) || isToday(end);

  return {
    text: `${startText} ~ ${endText}`,
    overdue,
    isToday: isTodayRange,
  };
}

/** 格式化单个日期（含逾期/今天判断 + 时间部分） */
function formatSingleDate(iso: string): DueDateInfo | null {
  const date = localIsoToDate(iso);
  if (!date || isNaN(date.getTime())) return null;

  const now = new Date();
  const overdue = date.getTime() < now.getTime() && !isToday(date);
  const withTime = hasTimePart(iso);

  if (isToday(date)) {
    return {
      text: withTime ? `今天 ${timeOf(iso)}` : "今天",
      overdue: false,
      isToday: true,
    };
  }
  if (isYesterday(date)) {
    return {
      text: withTime ? `昨天 ${timeOf(iso)}` : "昨天",
      overdue: true,
      isToday: false,
    };
  }

  const dateText = formatSingle(date);
  return {
    text: withTime ? `${dateText} ${timeOf(iso)}` : dateText,
    overdue,
    isToday: false,
  };
}

/** 格式化页面副标题的日期（如"7月10日 · 周四"） */
export function formatPageDate(date: Date = new Date()): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${month}月${day}日 · ${weekdays[date.getDay()]}`;
}
