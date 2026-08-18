<script setup lang="ts">
// 日期弹层 —— 自建，参考滴答清单
// 顶部 tab：日期 / 时间段
// 内容：快捷按钮 + 月历 + 时间/提醒/重复 子入口
// 底部：清除 / 确定
import { ref, computed, watch } from "vue";
import { toLocalIso, parseLocalIso, clampDateRange } from "@/utils/date";
import MonthDayGrid from "./picker/MonthDayGrid.vue";
import TimeGrid from "./picker/TimeGrid.vue";

const props = defineProps<{
  /** 起始日期（YYYY-MM-DDTHH:mm:ss 本地字面量） */
  startIso: string | null;
  /** 结束日期（YYYY-MM-DDTHH:mm:ss 本地字面量） */
  endIso: string | null;
  /** 是否提供「时间段」tab。提醒等单时刻场景传 false：隐藏 tab 条、固定单日模式 */
  enableRange: boolean;
}>();

const emit = defineEmits<{
  /** 确认时触发，传 [start, end]（任一可为 null） */
  confirm: [start: string | null, end: string | null];
  /** 清除时触发 */
  clear: [];
  /** 弹层关闭 */
  cancel: [];
}>();

type TabKey = "date" | "range";
/** 默认 tab：单时刻场景固定 date；否则根据 props 推断：
 *  start 和 end 同一天（或只有一个）→ date，否则 range */
const initialTab = (): TabKey => {
  if (!props.enableRange) return "date";
  const s = parseLocalIso(props.startIso);
  const e = parseLocalIso(props.endIso);
  if (!s || !e) return "date";
  return isSameDay(s, e) ? "date" : "range";
};
const activeTab = ref<TabKey>(initialTab());

// 临时编辑状态
const editDate = ref<string | null>(null); // YYYY-MM-DDTHH:mm:ss 或 null
const editStart = ref<string | null>(null);
const editEnd = ref<string | null>(null);

watch(
  () => [props.startIso, props.endIso],
  ([s, e]) => {
    editDate.value = e ?? s ?? null;
    editStart.value = s ?? null;
    editEnd.value = e ?? null;
    // 同步 tab 推断（单时刻场景固定 date，不参与推断）
    if (props.enableRange) {
      const sd = parseLocalIso(s as string | null);
      const ed = parseLocalIso(e as string | null);
      if (sd && ed && !isSameDay(sd, ed)) {
        activeTab.value = "range";
      } else if (!sd && !ed) {
        // 双 null 不强制切
      } else if (activeTab.value === "range" && (!sd || !ed || isSameDay(sd, ed))) {
        // 从 range 退回单点 → 切回 date tab
        activeTab.value = "date";
      }
    }
  },
  { immediate: true },
);

const monthCursor = ref(new Date());

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 单选高亮日：仅 date tab 有单选（range tab 由 getRangeClass 高亮） */
const selectedDay = computed<Date | null>(() => {
  if (activeTab.value === "date") return parseLocalIso(editDate.value);
  return null;
});

/** 时间段模式下的"范围高亮"—— 用于日历格子 */
const rangeHighlight = computed(() => {
  if (activeTab.value !== "range") return null;
  const s = parseLocalIso(editStart.value);
  const e = parseLocalIso(editEnd.value);
  if (!s) return null;
  return { start: s, end: e };
});

/** 日历格子的范围状态：'in' 范围内 | 'start' 开始 | 'end' 结束 | null
 * 判定规则（按优先级）：
 *   1) 与 start 同天 → 'start'
 *   2) 与 end 同天   → 'end'
 *   3) 严格在 start 之后、end 之前（按整天比，避免 end 10:00 误伤 end 当天格子） → 'in'
 *   4) 其他 → null
 * 端点判定优先于 in，保证 1 号 / 4 号各自呈现闭合形态。 */
function getRangeClass(d: Date): "in" | "start" | "end" | null {
  const r = rangeHighlight.value;
  if (!r) return null;
  if (isSameDay(d, r.start)) return "start";
  if (r.end && isSameDay(d, r.end)) return "end";
  if (r.end) {
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const s = new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate()).getTime();
    const e = new Date(r.end.getFullYear(), r.end.getMonth(), r.end.getDate()).getTime();
    if (dayStart > s && dayStart < e) return "in";
  }
  return null;
}

function selectDay(d: Date) {
  if (activeTab.value === "date") {
    // 单点日期：保持原来的时分秒（缺省 00:00，与 picker 默认对齐）
    const cur = parseLocalIso(editDate.value);
    const hh = cur?.getHours() ?? 0;
    const mi = cur?.getMinutes() ?? 0;
    const next = new Date(d);
    next.setHours(hh, mi, 0, 0);
    editDate.value = toLocalIso(
      `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
    );
    return;
  }

  // ─── 时间段（range）：状态机 ─────────────────
  // 状态 1：未选 → 设 start
  // 状态 2：已选 start 但还没结束（或已选 end 但被重置）→ 设 end
  // 状态 3：start + end 都有 → 重新开始，把这次点的作为新 start
  const startD = parseLocalIso(editStart.value);
  const endD = parseLocalIso(editEnd.value);
  const hasFullRange = startD && endD;

  if (!editStart.value || hasFullRange) {
    // 第一次选 / 重新开始：设 start，end 清空（默认 00:00）
    const next = new Date(d);
    next.setHours(0, 0, 0, 0);
    editStart.value = toLocalIso(
      `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} 00:00:00`,
    );
    editEnd.value = null;
    return;
  }

  // 已选 start，未选 end：这次的点作为 end
  const startParsed = startD!;
  const next = new Date(d);
  next.setHours(1, 0, 0, 0); // end 缺省 01:00（比 start 00:00 晚 1h）

  // 如果用户点的日期早于 start，交换（让 start 是早的）
  let finalStart = startParsed;
  let finalEnd = next;
  if (next < startParsed) {
    // 这次点的更早：把这次的当 start，之前的 start 当 end
    const newStart = new Date(d);
    newStart.setHours(0, 0, 0, 0);
    finalStart = newStart;
    finalEnd = startParsed;
  }

  // 缺省 1h 间隔
  if (finalEnd.getTime() - finalStart.getTime() < 60 * 60 * 1000) {
    const adjusted = new Date(finalStart);
    adjusted.setHours(adjusted.getHours() + 1);
    finalEnd = adjusted;
  }

  editStart.value = toLocalIso(
    `${finalStart.getFullYear()}-${String(finalStart.getMonth() + 1).padStart(2, "0")}-${String(finalStart.getDate()).padStart(2, "0")} ${String(finalStart.getHours()).padStart(2, "0")}:${String(finalStart.getMinutes()).padStart(2, "0")}:00`,
  );
  editEnd.value = toLocalIso(
    `${finalEnd.getFullYear()}-${String(finalEnd.getMonth() + 1).padStart(2, "0")}-${String(finalEnd.getDate()).padStart(2, "0")} ${String(finalEnd.getHours()).padStart(2, "0")}:${String(finalEnd.getMinutes()).padStart(2, "0")}:00`,
  );
}

// ─── 快捷按钮 ─────────────────────────────────────
function quickDay(daysFromNow: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(0, 0, 0, 0);
  const iso = toLocalIso(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`,
  );
  if (activeTab.value === "date") {
    editDate.value = iso;
    return;
  }
  // 时间段：start = 今天 N 天，end = start + 1 天（明天 N+1 天 10:00）
  editStart.value = iso;
  const end = new Date(d);
  end.setDate(end.getDate() + 1);
  end.setHours(1, 0, 0, 0);
  editEnd.value = toLocalIso(
    `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}:00`,
  );
}

// ─── 时间选择（hh / mi 简易） ─────────────────────
// 默认展开 picker，用户进 DatePopover 第一眼就能看到时分选项，
// 无需先点"时间行"展开
// - date tab：只展开开始 picker
// - range tab：开始 + 结束两个 picker 都展开
// 用 activeTab 切换 showEndTimePicker 状态（保持开始 picker 总是展开）
const showTimePicker = ref(true);
const showEndTimePicker = ref(false);
// tab 切换时同步 end picker：range tab 才展开
watch(activeTab, (newTab) => {
  showEndTimePicker.value = newTab === "range";
});

function getCurrentTargetIso(): string | null {
  if (activeTab.value === "date") return editDate.value;
  // 时间段时优先取 start，缺省时回退到 end
  return editStart.value ?? editEnd.value;
}

/** 应用小时到当前目标（不关 picker，让用户继续点分钟）
 *  - date tab：写到 editDate
 *  - range tab：写到 editStart；若 end 为空则默认 start+1h */
function setHour(hh: number) {
  const mi = getCurrentMinutes();
  const cur = parseLocalIso(getCurrentTargetIso());
  const base = cur ?? new Date();
  base.setHours(hh, mi, 0, 0);
  const iso = toLocalIso(
    `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
  );
  if (activeTab.value === "date") {
    editDate.value = iso;
  } else {
    editStart.value = iso;
    if (!editEnd.value) {
      const end = new Date(base);
      end.setHours(end.getHours() + 1);
      editEnd.value = toLocalIso(
        `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}:00`,
      );
    }
  }
  // 不关 picker，让用户继续点分钟
}

/** 应用分钟到当前目标（点完分钟才关 picker，体验更顺） */
function setMinute(mi: number) {
  const hh = getCurrentHours();
  const cur = parseLocalIso(getCurrentTargetIso());
  const base = cur ?? new Date();
  base.setHours(hh, mi, 0, 0);
  const iso = toLocalIso(
    `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
  );
  if (activeTab.value === "date") {
    editDate.value = iso;
  } else {
    editStart.value = iso;
    if (!editEnd.value) {
      const end = new Date(base);
      end.setHours(end.getHours() + 1);
      editEnd.value = toLocalIso(
        `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}:00`,
      );
    }
  }
  // 不关 picker：让"确定"按钮统一关，用户可继续调整
}

/** 结束时间的 hour / minute —— 同上拆开 */
function setEndHour(hh: number) {
  const mi = parseLocalIso(editEnd.value)?.getMinutes() ?? 0;
  const cur = parseLocalIso(editEnd.value) ?? parseLocalIso(editStart.value) ?? new Date();
  const base = new Date(cur);
  base.setHours(hh, mi, 0, 0);
  editEnd.value = toLocalIso(
    `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
  );
  // 不关 picker
}

function setEndMinute(mi: number) {
  const hh = parseLocalIso(editEnd.value)?.getHours() ?? 0;
  const cur = parseLocalIso(editEnd.value) ?? parseLocalIso(editStart.value) ?? new Date();
  const base = new Date(cur);
  base.setHours(hh, mi, 0, 0);
  editEnd.value = toLocalIso(
    `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`,
  );
  // 不关 picker：让"确定"按钮统一关
}

const currentTimeLabel = computed(() => {
  const iso = activeTab.value === "date" ? editDate.value : editStart.value;
  if (!iso) return "00:00";
  const d = parseLocalIso(iso);
  if (!d) return "00:00";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

const endTimeLabel = computed(() => {
  if (!editEnd.value) return "00:00";
  const d = parseLocalIso(editEnd.value);
  if (!d) return "00:00";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

// 拿当前 target 的小时/分钟（用于 setTime 时保留另一边）
function getCurrentHours(): number {
  return parseLocalIso(getCurrentTargetIso())?.getHours() ?? 0;
}
function getCurrentMinutes(): number {
  return parseLocalIso(getCurrentTargetIso())?.getMinutes() ?? 0;
}

// ─── 确认 / 清除 ─────────────────────────────────
function onConfirm() {
  // 用户点"确定"时统一关 picker（setHour/setMinute 不再各自关）
  showTimePicker.value = false;
  showEndTimePicker.value = false;
  if (activeTab.value === "date") {
    emit("confirm", editDate.value, null);
  } else {
    // 钳制：range 模式下保证 end 不早于 start
    // （setEndHour/setEndMinute 允许预览时自由调整，确认时统一纠正）
    const [s, e] = clampDateRange(editStart.value, editEnd.value);
    emit("confirm", s, e);
  }
}

function onClear() {
  editDate.value = null;
  editStart.value = null;
  editEnd.value = null;
  emit("clear");
}
</script>

<template>
  <div class="date-popover">
    <!-- Tab（单时刻场景隐藏，固定单日模式） -->
    <div v-if="enableRange" class="date-popover__tabs">
      <button
        type="button"
        class="date-popover__tab"
        :class="{ 'date-popover__tab--active': activeTab === 'date' }"
        @click="activeTab = 'date'"
      >
        日期
      </button>
      <button
        type="button"
        class="date-popover__tab"
        :class="{ 'date-popover__tab--active': activeTab === 'range' }"
        @click="activeTab = 'range'"
      >
        时间段
      </button>
    </div>

    <!-- 快捷按钮 -->
    <div class="date-popover__quick">
      <button type="button" class="date-popover__quick-btn" :title="activeTab === 'range' ? '今天到明天' : '今天'" @click="quickDay(0)">
        <icon-sun :size="16" />
      </button>
      <button type="button" class="date-popover__quick-btn" :title="activeTab === 'range' ? '明天全天' : '明天'" @click="quickDay(1)">
        <icon-sunrise :size="16" />
      </button>
      <button type="button" class="date-popover__quick-btn" :title="activeTab === 'range' ? '本周' : '下周'" @click="quickDay(7)">
        <icon-calendar :size="16" />
      </button>
      <button type="button" class="date-popover__quick-btn" title="无日期" @click="onClear">
        <icon-close :size="16" />
      </button>
    </div>

    <!-- 月历（共用组件：单选高亮 + 时间段范围高亮） -->
    <MonthDayGrid
      v-model:month="monthCursor"
      :selected="selectedDay"
      :range-class="getRangeClass"
      @select="selectDay"
    />

    <!-- 时间子入口 -->
    <button
      type="button"
      class="date-popover__row"
      @click="showTimePicker = !showTimePicker; showEndTimePicker = false"
    >
      <icon-clock-circle :size="14" />
      <span>{{ activeTab === "range" ? "开始" : "时间" }} · {{ currentTimeLabel }}</span>
      <span class="date-popover__row-arrow"><icon-right :size="12" /></span>
    </button>

    <!-- 时间段 tab 的结束时间行 -->
    <button
      v-if="activeTab === 'range'"
      type="button"
      class="date-popover__row"
      @click="showEndTimePicker = !showEndTimePicker; showTimePicker = false"
    >
      <icon-clock-circle :size="14" />
      <span>结束 · {{ endTimeLabel }}</span>
      <span class="date-popover__row-arrow"><icon-right :size="12" /></span>
    </button>

    <!-- 时间选择（共用组件） -->
    <TimeGrid
      v-if="showTimePicker"
      :hour="getCurrentHours()"
      :minute="getCurrentMinutes()"
      @select-hour="setHour"
      @select-minute="setMinute"
    />

    <!-- 结束时间选择（共用组件） -->
    <TimeGrid
      v-if="showEndTimePicker"
      :hour="parseLocalIso(editEnd)?.getHours() ?? 0"
      :minute="parseLocalIso(editEnd)?.getMinutes() ?? 0"
      @select-hour="setEndHour"
      @select-minute="setEndMinute"
    />

    <!-- 底部按钮 -->
    <div class="date-popover__footer">
      <button type="button" class="date-popover__btn date-popover__btn--ghost" @click="onClear">
        清除
      </button>
      <button type="button" class="date-popover__btn date-popover__btn--primary" @click="onConfirm">
        确定
      </button>
    </div>
  </div>
</template>

<style scoped>
.date-popover {
  width: 248px;
  background: var(--jt-surface);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 面板高度上限：时间段 tab 内容更多，超出视口时内部滚动，
   * 保证底部「清除/确定」按钮始终可达（不会被挤出可视区） */
  max-height: calc(100vh - 24px);
  overflow-y: auto;
}

.date-popover__tabs {
  display: flex;
  background: var(--jt-surface-sunken);
  border-radius: 6px;
  padding: 2px;
  gap: 0;
}

.date-popover__tab {
  flex: 1;
  border: none;
  background: transparent;
  padding: 4px 0;
  font-size: 11px;
  color: var(--jt-text-secondary);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.12s;
}

.date-popover__tab--active {
  background: var(--jt-surface);
  color: var(--jt-text-primary);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.date-popover__quick {
  display: flex;
  gap: 2px;
  justify-content: space-around;
  padding: 2px 0;
}

.date-popover__quick-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 5px;
  color: var(--jt-text-secondary);
  cursor: pointer;
  transition: all 0.12s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.date-popover__quick-btn:hover {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.date-popover__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: none;
  background: transparent;
  border-radius: 5px;
  font-size: 11px;
  color: var(--jt-text-primary);
  cursor: pointer;
  text-align: left;
  width: 100%;
}

.date-popover__row:hover {
  background: var(--jt-surface-sunken);
}

.date-popover__row-arrow {
  margin-left: auto;
  color: var(--jt-text-tertiary);
}

.date-popover__footer {
  display: flex;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--jt-border);
}

.date-popover__btn {
  flex: 1;
  height: 26px;
  border-radius: 5px;
  border: none;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s;
  font-family: var(--font-body);
}

.date-popover__btn--ghost {
  background: transparent;
  color: var(--jt-text-secondary);
  border: 1px solid var(--jt-border);
}

.date-popover__btn--ghost:hover {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.date-popover__btn--primary {
  background: var(--jt-primary);
  color: #fff;
}

.date-popover__btn--primary:hover {
  filter: brightness(0.92);
}
</style>
