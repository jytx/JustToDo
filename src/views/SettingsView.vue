<script setup lang="ts">
// 设置页 —— 通用/外观/快捷键/数据/关于
// 主题/强调色/自动今天/检查间隔统一通过 settings store 持久化
import { ref, onMounted, computed } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore, SETTINGS_KEYS, type StartupView } from "@/stores/settings";
import {
  IconSettings,
  IconSkin,
  IconBulb,
  IconStorage,
  IconInfoCircle,
} from "@arco-design/web-vue/es/icon";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const settingsStore = useSettingsStore();
const {
  themeMode,
  accentColor,
  newTasksDueToday,
  recurrenceCheckInterval,
  startupView,
  error,
} = storeToRefs(settingsStore);

const attachmentPath = ref("");

const sections = [
  { id: "general", icon: IconSettings, label: "通用" },
  { id: "appearance", icon: IconSkin, label: "外观" },
  { id: "shortcuts", icon: IconBulb, label: "快捷键" },
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
            <a-select
              :model-value="'简体中文'"
              :style="{ width: '200px' }"
            >
              <a-option value="简体中文">简体中文</a-option>
            </a-select>
          </div>
          <div class="settings-section__item">
            <span>启动时打开</span>
            <a-select
              :model-value="startupView"
              :style="{ width: '200px' }"
              @change="(v: any) => settingsStore.setStartupView(v as StartupView)"
            >
              <a-option
                v-for="opt in startupViewOptions"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </a-option>
            </a-select>
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
  font-size: 24px;
  font-weight: 600;
  color: var(--jt-text-primary);
  margin: 0;
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
  font-size: 18px;
  font-weight: 500;
  margin: 0 0 20px;
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
