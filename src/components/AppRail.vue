<script setup lang="ts">
// 最左侧应用切换栏（仿滴答清单）
// 三个顶层入口：任务 / 习惯 / 设置
// 任务图标右上角显示未完成任务总数徽标
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  IconCheckCircle,
  IconTrophy,
  IconSettings,
} from "@arco-design/web-vue/es/icon";
import { useTaskStore } from "@/stores/task";

const route = useRoute();
const router = useRouter();
const taskStore = useTaskStore();

/** 全局未完成任务总数 = 各清单未完成根任务之和 */
const globalOpenCount = computed(() =>
  Object.values(taskStore.listCounts).reduce((sum, n) => sum + n, 0),
);

/** 徽标文本（> 99 显示 "99+"） */
const badgeText = computed(() =>
  globalOpenCount.value > 99 ? "99+" : String(globalOpenCount.value),
);

/** 任务族路由（智能视图 / 清单 / 标签）共享同一个 active 态 */
const isTasksActive = computed(() => {
  const name = route.name as string;
  return name === "today" || name === "upcoming" || name === "all" || name === "list" || name === "tag";
});

const isHabitsActive = computed(() => route.name === "habits");
const isSettingsActive = computed(() => route.name === "settings");

/** 通用跳转：保持 hash 路由一致 */
function go(path: string): void {
  router.push(path);
}
</script>

<template>
  <nav class="app-rail">
    <!-- 顶部 32px 留给原生窗口按钮（红黄绿），同时作为可拖动区域 -->
    <div class="app-rail__drag-spacer" />

    <!-- 任务：默认跳到 /today -->
    <button
      class="app-rail__btn"
      :class="{ 'app-rail__btn--active': isTasksActive }"
      title="任务"
      @click="go('/today')"
    >
      <icon-check-circle :size="20" />
      <span v-if="globalOpenCount > 0" class="app-rail__badge">{{ badgeText }}</span>
    </button>

    <!-- 习惯 -->
    <button
      class="app-rail__btn"
      :class="{ 'app-rail__btn--active': isHabitsActive }"
      title="习惯"
      @click="go('/habits')"
    >
      <icon-trophy :size="20" />
    </button>

    <!-- 中间弹性占位：把"设置"压到底部 -->
    <div class="app-rail__spacer" />

    <!-- 设置 -->
    <button
      class="app-rail__btn"
      :class="{ 'app-rail__btn--active': isSettingsActive }"
      title="设置"
      @click="go('/settings')"
    >
      <icon-settings :size="20" />
    </button>
  </nav>
</template>

<style scoped>
.app-rail {
  width: 48px;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  background-color: var(--jt-surface-sunken);
  border-right: 1px solid var(--jt-border);
}

.app-rail__drag-spacer {
  height: 32px;
  width: 100%;
  -webkit-app-region: drag;
  flex-shrink: 0;
}

.app-rail__btn {
  position: relative;
  width: 40px;
  height: 40px;
  border: none;
  background: transparent;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--jt-text-tertiary);
  -webkit-app-region: no-drag;
  transition: background-color 0.15s, color 0.15s;
}

.app-rail__btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.app-rail__btn--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

.app-rail__badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background-color: var(--jt-error);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  box-sizing: border-box;
  pointer-events: none;
}

.app-rail__spacer {
  flex: 1;
}
</style>