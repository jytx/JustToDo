<script setup lang="ts">
// 三栏布局骨架：侧边栏 + 任务列表区 + 任务详情面板
// 集成全局搜索、快速添加、快捷键
import { ref, computed } from "vue";
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
    <!-- 侧边栏（左） -->
    <TheSidebar v-model:collapsed="sidebarCollapsed" />

    <!-- 主区域（中） -->
    <main class="app-layout__main" :style="mainStyle">
      <div class="app-layout__topbar">
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
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
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
  /* 和侧边栏的"智能视图/清单/标签/习惯"subheader 同一行，靠右 */
  top: 40px;
  right: 24px;
  height: 24px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
}

.app-layout__topbar > * {
  -webkit-app-region: no-drag;
}
</style>
