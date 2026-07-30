<script setup lang="ts">
// 设置页 —— 通用/外观/快捷键/数据/关于
// 主题/强调色/自动今天/检查间隔统一通过 settings store 持久化
import { ref, onMounted, computed } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore, SETTINGS_KEYS, type StartupView } from "@/stores/settings";
import SelectPopover from "@/components/SelectPopover.vue";
import {
  IconSettings,
  IconSkin,
  IconBulb,
  IconStorage,
  IconInfoCircle,
  IconCopy,
  IconCalendar,
} from "@arco-design/web-vue/es/icon";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import TemplateSection from "@/components/TemplateSection.vue";
import ListScheduleSection from "@/components/ListScheduleSection.vue";
import { isValidHHmm } from "@/utils/date";

const settingsStore = useSettingsStore();
const {
  themeMode,
  accentColor,
  newTasksDueToday,
  recurrenceCheckInterval,
  startupView,
  error,
  dailyReminderTimes,
} = storeToRefs(settingsStore);

const attachmentPath = ref("");

const sections = [
  { id: "general", icon: IconSettings, label: "通用" },
  { id: "appearance", icon: IconSkin, label: "外观" },
  { id: "shortcuts", icon: IconBulb, label: "快捷键" },
  { id: "templates", icon: IconCopy, label: "模板" },
  { id: "schedule", icon: IconCalendar, label: "清单生成计划" },
  { id: "data", icon: IconStorage, label: "数据" },
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
  { action: "切换主题", mac: "⌘⇧L", win: "Ctrl+Shift+L" },
];

/** 当前键是否正在保存（用于显示反馈） */
const isSavingTheme = computed(() => settingsStore.isSaving(SETTINGS_KEYS.themeMode));
const isSavingAccent = computed(() => settingsStore.isSaving(SETTINGS_KEYS.accentColor));
const isSavingDueToday = computed(() =>
  settingsStore.isSaving(SETTINGS_KEYS.newTasksDueToday),
);
const isSavingDailyTimes = computed(() =>
  settingsStore.isSaving(SETTINGS_KEYS.dailyReminderTimes),
);

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

/** 5 分钟步进刻度（bumpMinute 用 step=5） */ // 暂时仅作为常量备查；模板内步进按钮 hard-coded 用 5

/** ▲/▼ 按钮：小时 ±1（自动 0–23 环绕） */
function bumpHour(delta: number): void {
  const cur = pendingHour.value ?? 0;
  const next = (cur + delta + 24) % 24;
  pendingHour.value = next;
}

/** ▲/▼ 按钮：分钟 ±5 */
function bumpMinute(delta: number): void {
  const cur = pendingMinute.value ?? 0;
  let next = cur + delta;
  if (next < 0) next += 60;
  if (next >= 60) next -= 60;
  pendingMinute.value = next;
}

// 标记 MINUTE_STEP 常量保留以备扩展（顶部栅格 / 键盘 step 等）

/** 输入框直接编辑 —— 解析合法才回填 */
function onHourInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  if (raw === "") {
    pendingHour.value = null;
    return;
  }
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n < 24) pendingHour.value = n;
}

function onMinuteInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  if (raw === "") {
    pendingMinute.value = null;
    return;
  }
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n < 60) pendingMinute.value = n;
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

/** 「清空」按钮 */
function clearPendingTime(): void {
  pendingHour.value = null;
  pendingMinute.value = null;
}

/** 移除 tag */
async function removeTime(t: string): Promise<void> {
  const next = dailyReminderTimes.value.filter((x) => x !== t);
  if (next.length === dailyReminderTimes.value.length) return;
  await settingsStore.setDailyReminderTimes(next);
}

onMounted(async () => {
  try {
    attachmentPath.value = await invoke<string>("get_attachment_path");
  } catch {
    attachmentPath.value = "无法获取路径";
  }
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
              <!-- 整体两列布局：左侧 stepper（HH:MM 选时刻），右侧 添加/清空 按钮 -->
              <div class="settings-section__time-group">
                <!-- 时 -->
                <div class="settings-section__time-col">
                  <div class="settings-section__time-bumps">
                    <button
                      type="button"
                      class="settings-section__time-bump"
                      :disabled="dailyReminderTimes.length >= 8"
                      aria-label="小时加一"
                      @click="bumpHour(1)"
                    >▲</button>
                    <button
                      type="button"
                      class="settings-section__time-bump"
                      :disabled="dailyReminderTimes.length >= 8"
                      aria-label="小时减一"
                      @click="bumpHour(-1)"
                    >▼</button>
                  </div>
                  <input
                    type="number"
                    class="settings-section__time-input"
                    :value="pendingHour === null ? '' : pendingHour"
                    min="0"
                    max="23"
                    step="1"
                    placeholder="时"
                    :disabled="dailyReminderTimes.length >= 8"
                    @input="onHourInput"
                  />
                </div>

                <span class="settings-section__time-sep">:</span>

                <!-- 分 -->
                <div class="settings-section__time-col">
                  <div class="settings-section__time-bumps">
                    <button
                      type="button"
                      class="settings-section__time-bump"
                      :disabled="dailyReminderTimes.length >= 8"
                      aria-label="分钟加五"
                      @click="bumpMinute(5)"
                    >▲</button>
                    <button
                      type="button"
                      class="settings-section__time-bump"
                      :disabled="dailyReminderTimes.length >= 8"
                      aria-label="分钟减五"
                      @click="bumpMinute(-5)"
                    >▼</button>
                  </div>
                  <input
                    type="number"
                    class="settings-section__time-input"
                    :value="pendingMinute === null ? '' : pendingMinute"
                    min="0"
                    max="59"
                    step="5"
                    placeholder="分"
                    :disabled="dailyReminderTimes.length >= 8"
                    @input="onMinuteInput"
                  />
                </div>
              </div>

              <div class="settings-section__daily-actions">
                <a-button
                  type="primary"
                  size="small"
                  :disabled="!pendingTime || dailyReminderTimes.length >= 8"
                  @click="confirmAddTime"
                >添加</a-button>
                <a-button
                  size="small"
                  :disabled="pendingHour === null && pendingMinute === null"
                  @click="clearPendingTime"
                >清空</a-button>
              </div>
            </div>
          </div>
          <div v-if="dailyReminderTimes.length > 0" class="settings-section__item">
            <span>已添加时刻</span>
            <div class="settings-section__daily-times">
              <a-tag
                v-for="t in dailyReminderTimes"
                :key="t"
                closable
                :loading="isSavingDailyTimes"
                @close="removeTime(t)"
              >{{ t }}</a-tag>
            </div>
          </div>
        </div>

        <!-- 外观 -->
        <div v-if="activeSection === 'appearance'" class="settings-section">
          <h2 class="settings-section__title">外观</h2>
          <div class="settings-section__item">
            <span>主题</span>
            <div class="settings-section__segmented">
              <a-button
                v-for="m in themeModes"
                :key="m.value"
                :type="themeMode === m.value ? 'primary' : 'text'"
                size="small"
                :loading="isSavingTheme && themeMode !== m.value"
                @click="settingsStore.setThemeMode(m.value)"
              >
                {{ m.label }}
              </a-button>
            </div>
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
            <a-button type="outline" size="small" @click="changeAttachmentPath">更改路径</a-button>
          </div>

          <a-divider class="my-4" />
          <div class="settings-section__actions">
            <a-button type="outline" size="small" disabled>导出数据</a-button>
            <a-button type="outline" size="small" disabled>导入数据</a-button>
          </div>
          <a-divider class="my-4" />
          <p class="settings-section__desc settings-section__desc--danger">危险操作</p>
          <div class="settings-section__actions">
            <a-button type="outline" size="small" status="danger" disabled>清空已完成任务</a-button>
            <a-button type="outline" size="small" status="danger" disabled>重置所有数据</a-button>
          </div>
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

.settings-section__segmented {
  display: flex;
  gap: 2px;
  background: var(--jt-surface-sunken);
  border-radius: 8px;
  padding: 2px;
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

/* 每日固定时点提醒：自建 HH:mm 选择器 */
.settings-section__daily-add {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* HH : mm 容器：两列（时 + 分）+ 中间冒号 */
.settings-section__time-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 单列：箭头列（左）｜输入框列（右），两列等高 */
.settings-section__time-col {
  display: grid;
  grid-template-columns: 14px auto;
  align-items: center;
  gap: 2px;
}

/* 箭头列：▲ 在上、▼ 在下，垂直堆叠 */
.settings-section__time-bumps {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ▲/▼ 步进按钮（窄条，与输入框同高） */
.settings-section__time-bump {
  width: 14px;
  height: 13px;
  border: 1px solid var(--jt-border);
  background: var(--jt-surface);
  color: var(--jt-text-secondary);
  border-radius: 3px;
  font-size: 8px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  transition: border-color 0.12s, color 0.12s, background-color 0.12s;
}

.settings-section__time-bump:hover:not(:disabled) {
  border-color: var(--jt-primary);
  color: var(--jt-primary);
  background: var(--jt-accent-soft);
}

.settings-section__time-bump:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 输入框列（与箭头列对齐，整体略宽） */
.settings-section__time-input {
  width: 48px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  font-size: 13px;
  font-family: var(--font-mono, var(--font-body));
  color: var(--jt-text-primary);
  background: var(--jt-surface);
  outline: none;
  text-align: center;
  transition: border-color 0.12s, box-shadow 0.12s;
  box-sizing: border-box;
}

.settings-section__time-input:focus {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}

/* 隐藏原生上下箭头 */
.settings-section__time-input::-webkit-inner-spin-button,
.settings-section__time-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.settings-section__time-input {
  -moz-appearance: textfield;
  appearance: textfield;
}

.settings-section__time-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-section__time-sep {
  font-size: 16px;
  font-weight: 600;
  color: var(--jt-text-primary);
  font-family: var(--font-mono, var(--font-body));
  align-self: center;
}

/* 添加 / 清空按钮（垂直对齐到 input 行） */
.settings-section__daily-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: center;
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

.settings-section__desc--danger {
  color: var(--jt-error);
}

.settings-section__actions {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
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
