<script setup lang="ts">
// 三栏布局骨架：侧边栏 + 任务列表区 + 任务详情面板
// 集成全局搜索、快速添加、快捷键
import { ref, computed } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "@/composables/useTheme";
import { useTaskStore } from "@/stores/task";
import TheSidebar from "@/components/TheSidebar.vue";
import TaskDetailPanel from "@/components/TaskDetailPanel.vue";
import SearchPalette from "@/components/SearchPalette.vue";
import QuickAddDialog from "@/components/QuickAddDialog.vue";
import { useSearchStore } from "@/stores/search";
import { useListStore } from "@/stores/list";
import { useShortcuts } from "@/composables/useShortcuts";

const { isDark, toggleTheme } = useTheme();
const searchStore = useSearchStore();
const listStore = useListStore();
const taskStore = useTaskStore();

const quickAddOpen = ref(false);
const sidebarCollapsed = ref(false);
const panelWidth = ref(360);

/** 窗口控制 */
const appWindow = getCurrentWindow();

async function minimizeWindow() {
  await appWindow.minimize();
}

async function toggleMaximize() {
  await appWindow.toggleMaximize();
}

async function closeWindow() {
  await appWindow.close();
}

/** 详情面板打开时，主区域右侧留出面板宽度的空间 */
const mainStyle = computed(() => {
  if (!taskStore.detailOpen) return { paddingRight: "0px" };
  return { paddingRight: panelWidth.value + "px" };
});

// 全局快捷键
useShortcuts({
  onSearch: () => {
    listStore.loadLists(); // 确保清单数据已加载（搜索结果要显示清单名）
    searchStore.show();
  },
  onQuickAdd: () => {
    listStore.loadLists();
    quickAddOpen.value = true;
  },
  onToggleTheme: toggleTheme,
});
</script>

<template>
  <div class="app-layout">
    <!-- 自定义窗口控制条（可拖动区域 + 窗口控制按钮） -->
    <div class="title-bar">
      <div class="title-bar__drag-region" />
      <div class="title-bar__controls">
        <a-button class="title-bar__btn" type="text" size="mini" @click="minimizeWindow">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="2" y1="5" x2="8" y2="5" stroke="currentColor" stroke-width="1"/></svg>
        </a-button>
        <a-button class="title-bar__btn" type="text" size="mini" @click="toggleMaximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/></svg>
        </a-button>
        <a-button class="title-bar__btn title-bar__btn--close" type="text" size="mini" @click="closeWindow">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1"/><line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1"/></svg>
        </a-button>
      </div>
    </div>

    <div class="app-layout__body">
    <!-- 侧边栏（左） -->
    <TheSidebar v-model:collapsed="sidebarCollapsed" />

    <!-- 主区域（中） -->
    <main class="app-layout__main" :style="mainStyle">
      <div class="app-layout__topbar">
        <a-button
          type="text"
          size="small"
          @click="sidebarCollapsed = !sidebarCollapsed"
          :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
        >
          <template #icon>
            <icon-menu-fold v-if="!sidebarCollapsed" :size="18" />
            <icon-menu-unfold v-else :size="18" />
          </template>
        </a-button>
        <a-button
          type="text"
          size="small"
          @click="searchStore.show()"
        >
          <template #icon><icon-search :size="18" /></template>
        </a-button>
        <a-button
          type="text"
          size="small"
          @click="quickAddOpen = true"
        >
          <template #icon><icon-plus :size="20" /></template>
        </a-button>
        <div style="flex: 1"></div>
        <a-button
          type="text"
          size="small"
          @click="toggleTheme"
        >
          <template #icon>
            <icon-sun-fill v-if="isDark" :size="18" />
            <icon-moon-fill v-else :size="18" />
          </template>
        </a-button>
      </div>

      <router-view />
    </main>

    <!-- 任务详情面板（右） -->
    <TaskDetailPanel v-model:panel-width="panelWidth" />

    <!-- 全局搜索面板 -->
    <SearchPalette />

    <!-- 快速添加对话框 -->
    <QuickAddDialog v-model="quickAddOpen" />
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.app-layout__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 自定义标题栏（因 decorstions: false） */
.title-bar {
  display: flex;
  height: 28px;
  flex-shrink: 0;
  background-color: var(--jt-surface-sunken);
  border-bottom: 1px solid var(--jt-border);
}

.title-bar__drag-region {
  flex: 1;
  -webkit-app-region: drag;
}

.title-bar__controls {
  display: flex;
  align-items: center;
  gap: 0;
  -webkit-app-region: no-drag;
}

.title-bar__btn {
  width: 36px;
  height: 28px;
  border-radius: 0 !important;
  padding: 0 !important;
  color: var(--jt-text-secondary);
}

.title-bar__btn:hover {
  background-color: var(--jt-surface-hover) !important;
  color: var(--jt-text-primary) !important;
}

.title-bar__btn--close:hover {
  background-color: #e81123 !important;
  color: #fff !important;
}

.app-layout__main {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  transition: padding-right 0.2s ease;
}

.app-layout__topbar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
