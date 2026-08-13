<script setup lang="ts">
// 设置页 —— 通用/外观/快捷键/数据/关于
// 主题/强调色/自动今天/检查间隔统一通过 settings store 持久化
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore, SETTINGS_KEYS, type StartupView, type AiProvider, type ThemeMode, DEFAULT_PROMPT_SMART, DEFAULT_PROMPT_LIST, DEFAULT_PROMPT_TASKS, DEFAULT_PROMPT_NOTE, DEFAULT_PROMPT_PARSE_TASK, DEFAULT_PROMPT_BREAKDOWN_TASK, DEFAULT_PROMPT_EXTRACT_TASKS, DEFAULT_PROMPT_POLISH } from "@/stores/settings";
import SelectPopover from "@/components/SelectPopover.vue";
import Popover from "@/components/Popover.vue";
import PromptEditor from "@/components/PromptEditor.vue";
import {
  IconSettings,
  IconSkin,
  IconBulb,
  IconStorage,
  IconInfoCircle,
  IconCopy,
  IconCalendar,
  IconRobot,
  IconSync,
  IconExport,
  IconImport,
  IconDelete,
  IconRefresh,
  IconFolder,
  IconPlus,
  IconThunderbolt,
  IconClose,
} from "@arco-design/web-vue/es/icon";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import TemplateSection from "@/components/TemplateSection.vue";
import ListScheduleSection from "@/components/ListScheduleSection.vue";
import BackgroundTaskSection from "@/components/BackgroundTaskSection.vue";
import { isValidHHmm } from "@/utils/date";
import { SOUND_OPTIONS, findSoundOption } from "@/utils/sounds";
import { playSound } from "@/composables/useSound";

const settingsStore = useSettingsStore();
const {
  themeMode,
  accentColor,
  newTasksDueToday,
  recurrenceCheckInterval,
  startupView,
  error,
  dailyReminderTimes,
  completionSound,
  dueReminderSound,
  dailyReminderSound,
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
} = storeToRefs(settingsStore);

const attachmentPath = ref("");

const sections = [
  { id: "general", icon: IconSettings, label: "通用" },
  { id: "appearance", icon: IconSkin, label: "外观" },
  { id: "shortcuts", icon: IconBulb, label: "快捷键" },
  { id: "templates", icon: IconCopy, label: "模板" },
  { id: "schedule", icon: IconCalendar, label: "清单生成计划" },
  { id: "backgroundTasks", icon: IconSync, label: "后台任务" },
  { id: "data", icon: IconStorage, label: "数据" },
  { id: "ai", icon: IconRobot, label: "AI" },
  { id: "about", icon: IconInfoCircle, label: "关于" },
];

const activeSection = ref("general");

const accentColors = [
  { name: "靛蓝", value: "#4F46E5" },
  { name: "墨绿", value: "#047857" },
  { name: "珊瑚", value: "#FF6B47" },
  { name: "紫罗兰", value: "#8B5CF6" },
];

const themeModes = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

/** 主题下拉选项（SelectPopover 结构：value 用 string） */
const themeModeOptions: Array<{ value: string; label: string }> = themeModes.map((m) => ({
  value: m.value,
  label: m.label,
}));

function onThemeModeChange(v: string): void {
  void settingsStore.setThemeMode(v as ThemeMode);
}

/** 启动时打开的视图选项 —— label 用于 UI，value 写入 settings.startupView */
const startupViewOptions: Array<{ value: StartupView; label: string }> = [
  { value: "today", label: "今天" },
  { value: "all", label: "全部" },
  { value: "inbox", label: "收件箱" },
];

/** SelectPopover 要求 value 是 string，这里把 StartupView 转 string 喂给组件 */
const startupSelectOptions = computed(() =>
  startupViewOptions.map((o) => ({ value: String(o.value), label: o.label })),
);

function onStartupViewChange(v: string) {
  settingsStore.setStartupView(v as StartupView);
}

const shortcuts = [
  { action: "快速添加任务", mac: "⌘⇧A", win: "Ctrl+Shift+A" },
  { action: "搜索", mac: "⌘K", win: "Ctrl+K" },
  { action: "新建任务", mac: "⌘N", win: "Ctrl+N" },
  { action: "AI 每日小结", mac: "⌘⇧D", win: "Ctrl+Shift+D" },
  { action: "切换主题", mac: "⌘⇧L", win: "Ctrl+Shift+L" },
  { action: "放大界面", mac: "⌘+", win: "Ctrl+Plus" },
  { action: "缩小界面", mac: "⌘-", win: "Ctrl+Minus" },
  { action: "恢复 100%", mac: "⌘0", win: "Ctrl+0" },
  // 侧边栏键盘操作：Ctrl/Cmd+↑/↓ 在选中清单/笔记本（当前视图为 /list 或 /notebook）
  // 时切换清单；↑/↓ 单独使用始终是任务/笔记焦点导航（互不干扰）
  { action: "切换任务/笔记焦点", mac: "↑ / ↓", win: "↑ / ↓" },
  { action: "切换清单/笔记本", mac: "⌘↑ / ⌘↓", win: "Ctrl+↑ / Ctrl+↓" },
  { action: "删除当前清单/笔记本（列表为空时）", mac: "⌫ / Delete", win: "Backspace / Delete" },
];

/** 当前键是否正在保存（用于显示反馈） */
const isSavingAccent = computed(() => settingsStore.isSaving(SETTINGS_KEYS.accentColor));
const isSavingDueToday = computed(() =>
  settingsStore.isSaving(SETTINGS_KEYS.newTasksDueToday),
);
const isSavingDailyTimes = computed(() =>
  settingsStore.isSaving(SETTINGS_KEYS.dailyReminderTimes),
);

/* ─── AI 配置 ────────────────────────────────────── */
// 详见 discuss/2026-07-31-ai-config-design.md
// 输入框走 @change 自动保存（失焦触发），无需单独 loading 反馈；
// 仅总开关这种"点击即生效"的控件保留 saving 反馈
const isSavingAiEnabled = computed(() => settingsStore.isSaving(SETTINGS_KEYS.aiEnabled));

/** API 地址 placeholder：随协议变化，给用户参考标准地址 */
const baseUrlPlaceholder = computed(() =>
  aiProvider.value === "anthropic"
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1",
);

/** 模型名 placeholder：随协议变化 */
const modelPlaceholder = computed(() =>
  aiProvider.value === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o",
);

/** 测试连接状态：testing 进行中、testResult 结果反馈 */
const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

/** 提示词编辑器展开状态（默认收起，点击标题展开） */
const promptExpanded = ref<Record<string, boolean>>({});

/** 切换协议：清空模型名（不同协议模型名不通用），地址保留 */
async function onProviderChange(v: AiProvider): Promise<void> {
  await settingsStore.setAiProvider(v);
  // 协议切换后清空模型名，避免残留不兼容的模型名
  await settingsStore.setAiModel("");
  // 清空上次的测试结果（配置已变，旧结果失效）
  testResult.value = null;
}

/** 测试连接：调 Rust 端 ai_test_connection，发最小请求验证配置可用 */
async function onTestConnection(): Promise<void> {
  testing.value = true;
  testResult.value = null;
  try {
    const res = await invoke<{ ok: boolean; message: string }>("ai_test_connection");
    testResult.value = res;
  } catch (e) {
    testResult.value = { ok: false, message: String(e) };
  } finally {
    testing.value = false;
  }
}

/* ─── 每日固定时点提醒 ────────────────────────────────────── */

/**
 * 自建 hour/minute 选择器（HH:mm），绕开 Arco a-time-picker 在 Tauri WKWebView
 * 下弹层渲染失败的兼容性问题（已实测：visible=true 但 portal DOM 不挂载）。
 * 体验上比纯手输 input 更"选"一些：自带 ▲▼ 微调 + 5 分钟步进 + 顶部快选预设。
 */

/** 当前选中的小时（0–23，未选 = null） */
const pendingHour = ref<number | null>(null);
/** 当前选中的分钟（0–55，按 5 分钟步进；未选 = null） */
const pendingMinute = ref<number | null>(null);

/** 拼装 "HH:mm"，缺任一字段返回 null */
const pendingTime = computed<string | null>(() => {
  if (pendingHour.value === null || pendingMinute.value === null) return null;
  const h = pendingHour.value;
  const m = pendingMinute.value;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
});

// ─── 添加时刻：iOS 风格滚动选择器（两列滚动 + 中间高亮条 + 确认）───
/** 小时列选项 0–23 */
const HOUR_OPTIONS: number[] = Array.from({ length: 24 }, (_, i) => i);
/** 分钟列选项 0–55（5 分钟步进） */
const MINUTE_OPTIONS: number[] = Array.from({ length: 12 }, (_, i) => i * 5);
/** 单项高度（px）；容器高 = 5 项，边缘占位 2 项保证首尾可滚到中心 */
const PICKER_ITEM_H = 32;

const timePickerOpen = ref(false);
const hourColRef = ref<HTMLElement | null>(null);
const minuteColRef = ref<HTMLElement | null>(null);

/** 滚动吸附定时器（每列独立，松手后对齐最近整行） */
const snapTimers: Record<string, number> = { hour: 0, minute: 0 };
/** 吸附动画帧（每列独立，rAF 缓动替代 scrollTo smooth——WebKit 下更顺滑） */
const snapRaf: Record<string, number> = { hour: 0, minute: 0 };

/** 列滚动到指定选项（居中显示） */
function scrollColTo(col: HTMLElement | null, value: number | null, options: number[]): void {
  if (!col || value === null) return;
  const idx = options.indexOf(value);
  if (idx >= 0) col.scrollTop = idx * PICKER_ITEM_H;
}

/** 打开选择器：默认当前时间（分钟对齐 5 分钟刻度） */
function openTimePicker(): void {
  if (dailyReminderTimes.value.length >= 8) return;
  const now = new Date();
  pendingHour.value = now.getHours();
  pendingMinute.value = (Math.round(now.getMinutes() / 5) * 5) % 60;
  timePickerOpen.value = true;
  nextTick(() => {
    scrollColTo(hourColRef.value, pendingHour.value, HOUR_OPTIONS);
    scrollColTo(minuteColRef.value, pendingMinute.value, MINUTE_OPTIONS);
  });
}

/** rAF 缓动吸附：从当前 scrollTop 平滑滚到目标整行（easeOutCubic） */
function snapColTo(col: HTMLElement, target: number, key: string): void {
  const start = col.scrollTop;
  const delta = target - start;
  if (Math.abs(delta) < 0.5) return;
  const duration = 220;
  const t0 = performance.now();
  cancelAnimationFrame(snapRaf[key]);
  const step = (t: number): void => {
    const p = Math.min(1, (t - t0) / duration);
    const ease = 1 - Math.pow(1 - p, 3);
    col.scrollTop = start + delta * ease;
    if (p < 1) snapRaf[key] = requestAnimationFrame(step);
  };
  snapRaf[key] = requestAnimationFrame(step);
}

/** 滚动事件：最近选项（居中行）即选中；松手后缓动吸附（防停在两数之间） */
function onColScroll(col: HTMLElement, options: number[], set: (v: number) => void, key: string): void {
  const idx = Math.min(options.length - 1, Math.max(0, Math.round(col.scrollTop / PICKER_ITEM_H)));
  set(options[idx]);
  window.clearTimeout(snapTimers[key]);
  snapTimers[key] = window.setTimeout(() => {
    snapColTo(col, idx * PICKER_ITEM_H, key);
  }, 150);
}

function onHourScroll(): void {
  if (hourColRef.value) onColScroll(hourColRef.value, HOUR_OPTIONS, (v) => { pendingHour.value = v; }, "hour");
}

function onMinuteScroll(): void {
  if (minuteColRef.value) onColScroll(minuteColRef.value, MINUTE_OPTIONS, (v) => { pendingMinute.value = v; }, "minute");
}

/** 点击选项：直接选中并滚动定位 */
function pickHour(h: number): void {
  pendingHour.value = h;
  scrollColTo(hourColRef.value, h, HOUR_OPTIONS);
}

function pickMinute(m: number): void {
  pendingMinute.value = m;
  scrollColTo(minuteColRef.value, m, MINUTE_OPTIONS);
}

/** 「确认」：持久化 + 关闭选择器 */
async function onTimePickerConfirm(): Promise<void> {
  await confirmAddTime();
  timePickerOpen.value = false;
}

/** 「添加」按钮 —— 校验 + 持久化 + 清空 */
async function confirmAddTime(): Promise<void> {
  const t = pendingTime.value;
  if (!t || !isValidHHmm(t)) return;
  if (!dailyReminderTimes.value.includes(t)) {
    const next = [...dailyReminderTimes.value, t];
    await settingsStore.setDailyReminderTimes(next);
  }
  pendingHour.value = null;
  pendingMinute.value = null;
}

/** 移除 tag */
async function removeTime(t: string): Promise<void> {
  const next = dailyReminderTimes.value.filter((x) => x !== t);
  if (next.length === dailyReminderTimes.value.length) return;
  await settingsStore.setDailyReminderTimes(next);
}

// ─── 提示音 ─────────────────────────────────────────

/** 音效下拉选项：可试听项带播放图标（「无」不可试听） */
const soundSelectOptions = computed(() =>
  SOUND_OPTIONS.map((o) => ({
    value: o.value,
    label: o.label,
    previewable: o.url !== null,
  })),
);

/** 试听指定音效：按 value 查 url 并播放（「无」不响） */
function previewSound(value: string): void {
  const option = findSoundOption(value);
  if (option?.url) {
    playSound(option.url);
  }
}

// ─── 输入框宽度随内容自适应（同下拉的 fit-content 语言）───
// WebKit 下 input 的 CSS fit-content 不跟随内容（实测固定 ~203px），
// 需 JS 用 canvas 测字宽动态设宽；上限由 CSS max-width 与下方 clamp 双重兜底。
const fitCanvas = document.createElement("canvas");

/** 单个输入框：宽度 = 文本(值或占位符) + 左右内边距 + 附加控件(step/眼睛)，80~320 之间 */
function fitInputWidth(wrapper: HTMLElement): void {
  const input = wrapper.querySelector("input");
  if (!input) return;
  const ctx = fitCanvas.getContext("2d");
  if (!ctx) return;
  ctx.font = getComputedStyle(input).font;
  const textW = ctx.measureText(input.value || input.placeholder || "").width;
  const stepW = wrapper.querySelector(".arco-input-number-step")?.clientWidth ?? 0;
  const suffixW = wrapper.querySelector(".arco-input-suffix")?.clientWidth ?? 0;
  const w = Math.min(Math.max(Math.ceil(textW + 24 + stepW + suffixW + 6), 80), 320);
  wrapper.style.width = `${w}px`;
}

/** 设置页内全部输入框适配一次（初始化 / tab 切换后重扫） */
function fitAllInputs(): void {
  document.querySelectorAll<HTMLElement>(".settings-view .arco-input-wrapper").forEach(fitInputWidth);
}

/** 全局捕获：输入 / 变更时动态适配宽度 */
function onDocFitInput(e: Event): void {
  const wrapper = (e.target as HTMLElement).closest<HTMLElement>(".settings-view .arco-input-wrapper");
  if (wrapper) fitInputWidth(wrapper);
}

// 观察设置页子树：tab 切换等动态出现的输入框自动适配（幂等，开销极小）
const settingsFitObserver = new MutationObserver(() => requestAnimationFrame(fitAllInputs));

onMounted(async () => {
  document.addEventListener("input", onDocFitInput, true);
  document.addEventListener("change", onDocFitInput, true);
  settingsFitObserver.observe(document.querySelector(".settings-view") ?? document.body, {
    childList: true,
    subtree: true,
  });
  fitAllInputs();
  try {
    attachmentPath.value = await invoke<string>("get_attachment_path");
  } catch {
    attachmentPath.value = "无法获取路径";
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("input", onDocFitInput, true);
  document.removeEventListener("change", onDocFitInput, true);
  settingsFitObserver.disconnect();
});

async function changeAttachmentPath() {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      await invoke("set_attachment_dir", { path: selected });
      attachmentPath.value = selected;
    }
  } catch (e) {
    console.error("更改附件路径失败:", e);
  }
}
</script>

<template>
  <div class="settings-view">
    <header class="settings-view__header">
      <h1 class="settings-view__title">设置</h1>
    </header>

    <a-divider class="mb-4" />

    <div class="settings-view__body">
      <!-- 左侧导航 -->
      <nav class="settings-view__nav">
        <button
          v-for="s in sections"
          :key="s.id"
          class="settings-view__nav-item"
          :class="{ 'settings-view__nav-item--active': activeSection === s.id }"
          @click="activeSection = s.id"
        >
          <component :is="s.icon" :size="18" />
          <span>{{ s.label }}</span>
        </button>
      </nav>

      <!-- 右侧内容 -->
      <div class="settings-view__content">
        <!-- 通用 -->
        <div v-if="activeSection === 'general'" class="settings-section">
          <h2 class="settings-section__title">通用</h2>
          <div class="settings-section__item">
            <span>语言</span>
            <SelectPopover
              :model-value="'简体中文'"
              :options="[{ value: '简体中文', label: '简体中文' }]"
              :width="120"
              disabled
            />
          </div>
          <div class="settings-section__item">
            <span>启动时打开</span>
            <SelectPopover
              :model-value="String(startupView ?? '')"
              :options="startupSelectOptions"
              :width="120"
              @update:model-value="onStartupViewChange"
            />
          </div>
          <div class="settings-section__item">
            <span>新任务自动设为今天</span>
            <a-switch
              :model-value="newTasksDueToday"
              :loading="isSavingDueToday"
              @change="(v: any) => settingsStore.setNewTasksDueToday(Boolean(v))"
            />
          </div>
          <div class="settings-section__item">
            <div>
              <span>重复任务检查间隔</span>
              <p class="settings-section__path-hint">
                后台定期检查并生成重复任务实例（应用需保持运行）
              </p>
            </div>
            <div class="settings-section__interval">
              <a-input-number
                :model-value="recurrenceCheckInterval"
                size="small"
                :min="1"
                :max="1440"
                :step="1"
                style="width: 100px"
                @change="(v: number | undefined) => settingsStore.setRecurrenceCheckInterval(v ?? 60)"
              />
              <span class="settings-section__interval-unit">分钟</span>
            </div>
          </div>
          <div class="settings-section__item">
            <div>
              <span>每日固定时点提醒</span>
              <p class="settings-section__path-hint">
                到点扫描未完成的根任务并发汇总通知，每日每时刻只发一次（应用需保持运行）
              </p>
            </div>
            <div class="settings-section__daily-add">
              <!-- 添加按钮 → 弹出 iOS 风格滚动选择器（左时右分，中间高亮条） -->
              <Popover v-model:visible="timePickerOpen" placement="bottom-left" :offset="4">
                <template #trigger>
                  <a-button
                    type="text"
                    size="small"
                    :disabled="dailyReminderTimes.length >= 8"
                    @click="openTimePicker"
                  >
                    <template #icon><icon-plus :size="14" /></template>
                    添加
                  </a-button>
                </template>

                <div class="daily-picker">
                  <div class="daily-picker__cols">
                    <!-- 时列 0–23 -->
                    <div ref="hourColRef" class="daily-picker__col" @scroll.passive="onHourScroll">
                      <div class="daily-picker__edge" />
                      <button
                        v-for="h in HOUR_OPTIONS"
                        :key="h"
                        type="button"
                        class="daily-picker__item"
                        :class="{ 'daily-picker__item--active': pendingHour === h }"
                        @click="pickHour(h)"
                      >{{ String(h).padStart(2, "0") }}</button>
                      <div class="daily-picker__edge" />
                    </div>
                    <span class="daily-picker__sep">:</span>
                    <!-- 分列 0–55（5 分钟步进） -->
                    <div ref="minuteColRef" class="daily-picker__col" @scroll.passive="onMinuteScroll">
                      <div class="daily-picker__edge" />
                      <button
                        v-for="m in MINUTE_OPTIONS"
                        :key="m"
                        type="button"
                        class="daily-picker__item"
                        :class="{ 'daily-picker__item--active': pendingMinute === m }"
                        @click="pickMinute(m)"
                      >{{ String(m).padStart(2, "0") }}</button>
                      <div class="daily-picker__edge" />
                    </div>
                  </div>
                  <!-- 中间高亮条（指示选中行） -->
                  <div class="daily-picker__indicator" />
                  <div class="daily-picker__footer">
                    <a-button type="text" size="mini" @click="timePickerOpen = false">取消</a-button>
                    <a-button
                      type="text"
                      size="mini"
                      :disabled="!pendingTime"
                      @click="onTimePickerConfirm"
                    >确认</a-button>
                  </div>
                </div>
              </Popover>
            </div>
          </div>
          <div v-if="dailyReminderTimes.length > 0" class="settings-section__item">
            <span>已添加时刻</span>
            <div class="settings-section__daily-times">
              <!-- 已添加时刻：文字按钮风格（默认无底色，hover 显底色；× 单独触发删除） -->
              <button
                v-for="t in dailyReminderTimes"
                :key="t"
                type="button"
                class="daily-time-tag"
                :disabled="isSavingDailyTimes"
              >
                {{ t }}
                <span
                  class="daily-time-tag__close"
                  role="button"
                  aria-label="移除"
                  @click.stop="removeTime(t)"
                ><icon-close :size="12" /></span>
              </button>
            </div>
          </div>
          <!-- 提示音：三类场景各自可选音效，选中后可直接试听 -->
          <div class="settings-section__item">
            <div>
              <span>完成任务提示音</span>
              <p class="settings-section__path-hint">
                勾选完成任务时播放（批量完成只响一次）
              </p>
            </div>
            <SelectPopover
              :model-value="completionSound"
              :options="soundSelectOptions"
              :width="140"
              @update:model-value="(v: string) => settingsStore.setCompletionSound(v)"
              @preview="previewSound"
            />
          </div>
          <div class="settings-section__item">
            <div>
              <span>到期提醒提示音</span>
              <p class="settings-section__path-hint">
                任务设置的提醒时刻到点时播放（与系统通知同时）
              </p>
            </div>
            <SelectPopover
              :model-value="dueReminderSound"
              :options="soundSelectOptions"
              :width="140"
              @update:model-value="(v: string) => settingsStore.setDueReminderSound(v)"
              @preview="previewSound"
            />
          </div>
          <div class="settings-section__item">
            <div>
              <span>每日提醒提示音</span>
              <p class="settings-section__path-hint">
                每日固定时点汇总提醒到点时播放（与系统通知同时）
              </p>
            </div>
            <SelectPopover
              :model-value="dailyReminderSound"
              :options="soundSelectOptions"
              :width="140"
              @update:model-value="(v: string) => settingsStore.setDailyReminderSound(v)"
              @preview="previewSound"
            />
          </div>
        </div>

        <!-- 外观 -->
        <div v-if="activeSection === 'appearance'" class="settings-section">
          <h2 class="settings-section__title">外观</h2>
          <div class="settings-section__item">
            <span>主题</span>
            <SelectPopover
              :model-value="themeMode"
              :options="themeModeOptions"
              :width="120"
              @update:model-value="onThemeModeChange"
            />
          </div>
          <div class="settings-section__item">
            <span>强调色</span>
            <div class="settings-section__colors">
              <button
                v-for="c in accentColors"
                :key="c.value"
                class="settings-section__color-dot"
                :class="{ 'settings-section__color-dot--active': accentColor === c.value }"
                :style="{ backgroundColor: c.value }"
                :title="c.name"
                @click="settingsStore.setAccentColor(c.value)"
              />
            </div>
          </div>
          <p v-if="isSavingAccent" class="settings-section__hint">正在保存强调色...</p>
          <div class="settings-section__item">
            <div>
              <span>任务详情面板最大宽度</span>
              <p class="settings-section__path-hint">
                拖拽详情面板右侧边缘可调宽度，此为拖拽上限
              </p>
            </div>
            <div class="settings-section__interval">
              <a-input-number
                :model-value="settingsStore.detailPanelMaxWidth"
                size="small"
                :min="480"
                :max="1200"
                :step="20"
                style="width: 100px"
                @change="(v: number | undefined) => settingsStore.setDetailPanelMaxWidth(v ?? 720)"
              />
              <span class="settings-section__interval-unit">px</span>
            </div>
          </div>
        </div>

        <!-- 快捷键 -->
        <div v-if="activeSection === 'shortcuts'" class="settings-section">
          <h2 class="settings-section__title">快捷键</h2>
          <div
            v-for="s in shortcuts"
            :key="s.action"
            class="settings-section__shortcut"
          >
            <span>{{ s.action }}</span>
            <kbd class="font-mono settings-section__kbd">{{ s.mac }}</kbd>
          </div>
        </div>

        <!-- 模板 -->
        <div v-if="activeSection === 'templates'" class="settings-section">
          <h2 class="settings-section__title">模板</h2>
          <TemplateSection />
        </div>

        <!-- 清单生成计划 -->
        <div v-if="activeSection === 'schedule'" class="settings-section">
          <h2 class="settings-section__title">清单生成计划</h2>
          <ListScheduleSection />
        </div>

        <!-- 后台任务（统一管理：重复任务 + 清单生成计划的运行态） -->
        <div v-if="activeSection === 'backgroundTasks'" class="settings-section">
          <h2 class="settings-section__title">后台任务</h2>
          <BackgroundTaskSection />
        </div>

        <!-- 数据 -->
        <div v-if="activeSection === 'data'" class="settings-section">
          <h2 class="settings-section__title">数据</h2>
          <p class="settings-section__desc">数据存储在本地 SQLite 数据库中。</p>

          <!-- 附件存储路径 -->
          <div class="settings-section__item">
            <div>
              <span>附件存储路径</span>
              <p class="settings-section__path-hint">{{ attachmentPath || '加载中...' }}</p>
            </div>
            <a-button type="text" size="small" @click="changeAttachmentPath">
              <template #icon><icon-folder :size="14" /></template>
              更改路径
            </a-button>
          </div>

          <!-- 导出 / 导入 -->
          <div class="settings-section__item">
            <div>
              <span class="settings-section__item-title">导出 / 导入</span>
              <p class="settings-section__path-hint">备份或恢复任务数据（JSON 文件）</p>
            </div>
            <div class="settings-section__item-actions">
              <a-button type="text" size="small" disabled>
                <template #icon><icon-export :size="14" /></template>
                导出数据
              </a-button>
              <a-button type="text" size="small" disabled>
                <template #icon><icon-import :size="14" /></template>
                导入数据
              </a-button>
            </div>
          </div>

          <!-- 危险操作 -->
          <div class="settings-section__item">
            <div>
              <span class="settings-section__item-title settings-section__item-title--danger">危险操作</span>
              <p class="settings-section__path-hint">清空已完成任务，或重置所有数据（不可恢复）</p>
            </div>
            <div class="settings-section__item-actions">
              <a-button type="text" size="small" status="danger" disabled>
                <template #icon><icon-delete :size="14" /></template>
                清空已完成任务
              </a-button>
              <a-button type="text" size="small" status="danger" disabled>
                <template #icon><icon-refresh :size="14" /></template>
                重置所有数据
              </a-button>
            </div>
          </div>
        </div>

        <!-- AI 配置 -->
        <div v-if="activeSection === 'ai'" class="settings-section">
          <h2 class="settings-section__title">AI</h2>
          <p class="settings-section__desc">配置 AI 服务，用于后续的自然语言建任务等功能。</p>

          <!-- 总开关 -->
          <div class="settings-section__item">
            <div>
              <span>启用 AI</span>
              <p class="settings-section__path-hint">关闭后所有 AI 功能入口将隐藏</p>
            </div>
            <a-switch
              :model-value="aiEnabled"
              :loading="isSavingAiEnabled"
              @change="(v: any) => settingsStore.setAiEnabled(Boolean(v))"
            />
          </div>

          <!-- 配置区（总开关打开后才显示）：折叠面板分组 -->
          <a-collapse
            v-if="aiEnabled"
            :bordered="false"
            :default-active-key="['connection']"
            class="settings-section__collapse"
          >
            <!-- 连接配置：协议/地址/Key/模型/测试/裁剪阈值 -->
            <a-collapse-item key="connection" header="连接配置">
              <div class="settings-section__item">
                <span>服务协议</span>
                <a-radio-group
                  :model-value="aiProvider"
                  @change="(v: any) => onProviderChange(v as AiProvider)"
                >
                  <a-radio value="openai">OpenAI 兼容</a-radio>
                  <a-radio value="anthropic">Anthropic</a-radio>
                </a-radio-group>
              </div>

              <div class="settings-section__item">
                <span>API 地址</span>
                <a-input
                  v-model="aiBaseUrl"
                  :placeholder="baseUrlPlaceholder"
                  style="width: 280px"
                  @change="() => settingsStore.setAiBaseUrl(aiBaseUrl)"
                />
              </div>

              <div class="settings-section__item">
                <span>API Key</span>
                <a-input-password
                  v-model="aiApiKey"
                  placeholder="sk-..."
                  style="width: 280px"
                  @change="() => settingsStore.setAiApiKey(aiApiKey)"
                />
              </div>

              <div class="settings-section__item">
                <span>模型名</span>
                <a-input
                  v-model="aiModel"
                  :placeholder="modelPlaceholder"
                  style="width: 280px"
                  @change="() => settingsStore.setAiModel(aiModel)"
                />
              </div>

              <div class="settings-section__actions settings-section__actions--right">
                <span
                  v-if="testResult"
                  class="settings-section__test-result"
                  :class="{ 'settings-section__test-result--ok': testResult.ok, 'settings-section__test-result--fail': !testResult.ok }"
                >{{ testResult.ok ? "✓ " : "✗ " }}{{ testResult.message }}</span>
                <a-button
                  type="text"
                  size="small"
                  :loading="testing"
                  @click="onTestConnection"
                >
                  <template #icon><icon-thunderbolt :size="14" /></template>
                  测试连接
                </a-button>
              </div>

              <a-divider class="my-4" />

              <div class="settings-section__item">
                <div>
                  <span>总结裁剪阈值</span>
                  <p class="settings-section__path-hint">任务数超过此值时，总结前会询问是否智能裁剪</p>
                </div>
                <div class="settings-section__interval">
                  <a-input-number
                    :model-value="aiSummaryTruncateThreshold"
                    size="small"
                    :min="1"
                    :max="500"
                    :step="1"
                    style="width: 100px"
                    @change="(v: number | undefined) => settingsStore.setAiSummaryTruncateThreshold(v ?? 50)"
                  />
                  <span class="settings-section__interval-unit">项</span>
                </div>
              </div>
            </a-collapse-item>

            <!-- 提示词模板：4 个场景，各自可编辑 + 恢复默认 -->
            <a-collapse-item key="prompts" header="提示词模板">
              <p class="settings-section__desc">自定义提示词。清空则使用默认。每日/周报支持 {mode} 占位符（自动替换为「今日」/「本周」）。</p>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.smart = !promptExpanded.smart">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.smart" :size="12" />
                    <icon-down v-else :size="12" />
                    每日 / 周报
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptSmart(DEFAULT_PROMPT_SMART)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">顶栏 AI 按钮 / Cmd+Shift+D —— 按时间汇总今日或本周的任务</p>
                <PromptEditor
                  v-if="promptExpanded.smart"
                  v-model="aiPromptSmart"
                  @change="(v: string) => settingsStore.setAiPromptSmart(v)"
                />
              </div>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.list = !promptExpanded.list">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.list" :size="12" />
                    <icon-down v-else :size="12" />
                    清单 / 目录总结
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptList(DEFAULT_PROMPT_LIST)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">右键侧边栏的清单或目录 —— 总结整个清单/目录下的全部任务</p>
                <PromptEditor
                  v-if="promptExpanded.list"
                  v-model="aiPromptList"
                  @change="(v: string) => settingsStore.setAiPromptList(v)"
                />
              </div>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.tasks = !promptExpanded.tasks">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.tasks" :size="12" />
                    <icon-down v-else :size="12" />
                    多选任务总结
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptTasks(DEFAULT_PROMPT_TASKS)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">多选任务后批量菜单 —— 仅总结你手动选中的那几个任务</p>
                <PromptEditor
                  v-if="promptExpanded.tasks"
                  v-model="aiPromptTasks"
                  @change="(v: string) => settingsStore.setAiPromptTasks(v)"
                />
              </div>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.note = !promptExpanded.note">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.note" :size="12" />
                    <icon-down v-else :size="12" />
                    笔记摘要
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptNote(DEFAULT_PROMPT_NOTE)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">右键侧边栏的笔记本/笔记本目录 —— 提炼笔记内容要点</p>
                <PromptEditor
                  v-if="promptExpanded.note"
                  v-model="aiPromptNote"
                  @change="(v: string) => settingsStore.setAiPromptNote(v)"
                />
              </div>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.parseTask = !promptExpanded.parseTask">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.parseTask" :size="12" />
                    <icon-down v-else :size="12" />
                    自然语言建任务
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptParseTask(DEFAULT_PROMPT_PARSE_TASK)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">底部添加栏 AI 按钮 —— 解析自然语言提取标题/优先级/日期/标签</p>
                <PromptEditor
                  v-if="promptExpanded.parseTask"
                  v-model="aiPromptParseTask"
                  @change="(v: string) => settingsStore.setAiPromptParseTask(v)"
                />
              </div>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.breakdown = !promptExpanded.breakdown">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.breakdown" :size="12" />
                    <icon-down v-else :size="12" />
                    任务拆解
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptBreakdownTask(DEFAULT_PROMPT_BREAKDOWN_TASK)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">任务详情面板 AI 拆解按钮 —— 把大任务拆成多个子任务</p>
                <PromptEditor
                  v-if="promptExpanded.breakdown"
                  v-model="aiPromptBreakdownTask"
                  @change="(v: string) => settingsStore.setAiPromptBreakdownTask(v)"
                />
              </div>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.extract = !promptExpanded.extract">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.extract" :size="12" />
                    <icon-down v-else :size="12" />
                    文本提取任务
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptExtractTasks(DEFAULT_PROMPT_EXTRACT_TASKS)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">AI 助手弹窗「提取任务」—— 从会议纪要/邮件提取行动项</p>
                <PromptEditor
                  v-if="promptExpanded.extract"
                  v-model="aiPromptExtractTasks"
                  @change="(v: string) => settingsStore.setAiPromptExtractTasks(v)"
                />
              </div>

              <div class="settings-section__prompt">
                <div class="settings-section__prompt-head" @click="promptExpanded.polish = !promptExpanded.polish">
                  <span class="settings-section__prompt-label">
                    <icon-right v-if="!promptExpanded.polish" :size="12" />
                    <icon-down v-else :size="12" />
                    文本润色
                  </span>
                  <a-button type="text" size="mini" @click.stop="settingsStore.setAiPromptPolish(DEFAULT_PROMPT_POLISH)">恢复默认</a-button>
                </div>
                <p class="settings-section__prompt-hint">详情面板 AI 润色按钮 —— 优化笔记/任务描述的文笔</p>
                <PromptEditor
                  v-if="promptExpanded.polish"
                  v-model="aiPromptPolish"
                  @change="(v: string) => settingsStore.setAiPromptPolish(v)"
                />
              </div>
            </a-collapse-item>
          </a-collapse>
        </div>

        <!-- 关于 -->
        <div v-if="activeSection === 'about'" class="settings-section">
          <h2 class="settings-section__title">关于</h2>
          <div class="settings-section__about">
            <span class="settings-section__about-name">JustToDo</span>
            <span class="settings-section__about-version">版本 0.1.0</span>
            <span class="settings-section__about-desc">一个本地优先的待办应用</span>
            <span class="settings-section__about-tech">Tauri · Vue 3 · Arco Design</span>
          </div>
        </div>

        <!-- 顶部错误提示（所有 section 共用） -->
        <a-alert
          v-if="error"
          class="settings-view__alert"
          type="error"
          :show-icon="true"
        >
          {{ error }}
        </a-alert>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.settings-view__header {
  padding: 24px 24px 12px;
}

.settings-view__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--jt-text-primary);
  margin: 0;
  line-height: 1.3;
}

.settings-view__body {
  display: flex;
  gap: 24px;
  padding: 0 24px 24px;
  flex: 1;
  overflow: hidden;
}

.settings-view__alert {
  margin-top: 12px;
}

.settings-view__nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 160px;
  flex-shrink: 0;
}

.settings-view__nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-secondary);
  cursor: pointer;
  background: transparent;
  border: none;
  text-align: left;
  transition: all 0.15s;
}

.settings-view__nav-item:hover {
  background-color: var(--jt-surface-hover);
}

.settings-view__nav-item--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
  font-weight: 500;
}

.settings-view__content {
  flex: 1;
  overflow-y: auto;
}

.settings-section__title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0 0 20px;
  color: var(--jt-text-primary);
}

.settings-section__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  font-size: 14px;
}

/* item 右侧按钮组（并排，间距紧凑） */
.settings-section__item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 数据区标题：与后台任务区块标题一致（13px 600） */
.settings-section__item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
}

/* 危险操作标题：主红警示色（继承加粗） */
.settings-section__item-title--danger {
  color: var(--jt-error);
}

.settings-section__colors {
  display: flex;
  gap: 8px;
}

.settings-section__color-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s;
}

.settings-section__color-dot--active {
  border-color: color-mix(in srgb, var(--jt-text-primary) 50%, transparent);
}

.settings-section__hint {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  margin: 4px 0 0;
}

.settings-section__shortcut {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  font-size: 14px;
}

.settings-section__kbd {
  background: var(--jt-surface-sunken);
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
}

.settings-section__desc {
  font-size: 13px;
  color: var(--jt-text-secondary);
  margin-bottom: 12px;
}

.settings-section__path-hint {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--jt-text-tertiary);
  margin: 4px 0 0;
  word-break: break-all;
}

.settings-section__interval {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-section__interval-unit {
  font-size: 13px;
  color: var(--jt-text-secondary);
}

/* 每日固定时点提醒：添加按钮行 */
.settings-section__daily-add {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* ─── iOS 风格滚动选择器（两列滚动 + 中间高亮条）─── */
.daily-picker {
  position: relative;
  width: 144px;
  /* 面板容器：同 MenuPopover（白底 12px 圆角 阴影） */
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 8px;
}

/* 两列：时（0–23）｜分（0–55），各 72px 宽 */
.daily-picker__cols {
  position: relative;
  display: flex;
  align-items: center;
  z-index: 1;
}
.daily-picker__col {
  flex: 1;
  height: 160px; /* 5 项可见 */
  overflow-y: auto;
  scrollbar-width: none;
}
.daily-picker__col::-webkit-scrollbar {
  display: none;
}

/* 边缘占位：上下各 2 项，首尾选项也能滚到中间高亮行 */
.daily-picker__edge {
  height: 64px;
}

/* 选项行：点击选中 + 滚动定位；active 加粗提亮 */
.daily-picker__item {
  display: block;
  width: 100%;
  height: 32px;
  border: none;
  background: transparent;
  font-size: 13px;
  font-family: var(--font-mono, var(--font-body));
  font-variant-numeric: tabular-nums;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  transition: color 0.12s;
}
.daily-picker__item:hover {
  color: var(--jt-text-primary);
}
.daily-picker__item--active {
  color: var(--jt-text-primary);
  font-weight: 600;
}

/* 时/分之间的冒号分隔（紧凑贴列） */
.daily-picker__sep {
  color: var(--jt-text-tertiary);
  font-size: 13px;
  font-family: var(--font-mono, var(--font-body));
  padding: 0 2px;
  flex-shrink: 0;
}

/* 中间高亮条：指示当前选中行（位于 5 项可见区的正中间）
 * top = 边缘占位 64px + 面板 padding 8px（indicator 相对 .daily-picker 定位） */
.daily-picker__indicator {
  position: absolute;
  left: 0;
  right: 0;
  top: 72px;
  height: 32px;
  background: var(--jt-surface-hover);
  border-radius: 8px;
  pointer-events: none;
}

/* 底部操作：取消 / 确认 */
.daily-picker__footer {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--jt-border);
}

/* 每日固定时点提醒：tag 列表（行式，与 settings-section__item 同行） */
.settings-section__daily-times {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 320px;
  justify-content: flex-end;
}

/* 已添加时刻 tag：文字按钮风格 —— 默认无底色，hover 显底色；× 淡入淡出 */
.daily-time-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--jt-text-secondary);
  font-size: 13px;
  font-family: var(--font-mono, var(--font-body));
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}
.daily-time-tag:hover:not(:disabled) {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
.daily-time-tag:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* × 删除钮：默认隐藏，hover tag 时显现；hover × 变红 */
.daily-time-tag__close {
  display: inline-flex;
  opacity: 0;
  color: var(--jt-text-tertiary);
  transition: opacity 0.12s, color 0.12s;
}
.daily-time-tag:hover .daily-time-tag__close {
  opacity: 1;
}
.daily-time-tag__close:hover {
  color: var(--jt-error);
}

.settings-section__desc--danger {
  color: var(--jt-error);
}

.settings-section__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

/* 右对齐变体（AI 区测试连接等） */
.settings-section__actions--right {
  justify-content: flex-end;
}

/* 测试连接结果反馈：成功绿、失败红 */
.settings-section__test-result {
  font-size: 13px;
  line-height: 1.4;
}

.settings-section__test-result--ok {
  color: var(--jt-success, #00b42a);
}

.settings-section__test-result--fail {
  color: var(--jt-error);
}

/* 提示词编辑区：标题行 + textarea */
.settings-section__prompt {
  margin-bottom: 12px;
}

.settings-section__prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 4px 0;
  border-radius: 6px;
}

.settings-section__prompt-head:hover {
  background-color: var(--jt-surface-hover);
}

.settings-section__prompt-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-primary);
}

/* 提示词使用场景说明（标题下灰色小字） */
.settings-section__prompt-hint {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  margin: 2px 0 0;
  line-height: 1.4;
}

/* AI 设置折叠面板：去掉 Arco 默认左缩进，标题字号统一 */
.settings-section__collapse :deep(.arco-collapse-item-content) {
  padding-left: 0;
}

.settings-section__collapse :deep(.arco-collapse-item-header-title) {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
}

.settings-section__about {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.settings-section__about-name {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--jt-text-primary);
}

.settings-section__about-version {
  font-size: 13px;
  color: var(--jt-text-secondary);
}

.settings-section__about-desc {
  font-size: 14px;
  margin-top: 8px;
}

.settings-section__about-tech {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  font-family: var(--font-mono);
}
</style>
