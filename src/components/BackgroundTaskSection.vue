<script setup lang="ts">
// 后台任务 —— 设置页 section 容器
// 统一管理三类后台任务的运行态：
//   1. 重复任务模板（暂停/恢复 + 查看频率）
//   2. 清单生成计划（启用/停用，复用 listScheduleStore）
//   3. 定时提醒（只读列表，见 ReminderListSection.vue）
// 顶部提供「立即运行一次」按钮（并发触发重复任务生成 + 清单生成计划 tick）
import { computed, onMounted, ref } from "vue";
import { Message } from "@arco-design/web-vue";
import { IconRefresh } from "@arco-design/web-vue/es/icon";
import ReminderListSection from "./ReminderListSection.vue";
import { useBackgroundTaskStore } from "@/stores/backgroundTask";
import { useListScheduleStore } from "@/stores/listSchedule";
import { useListStore } from "@/stores/list";
import { formatRecurrence } from "@/types";
import type { Task } from "@/types";
import type { ListSchedule } from "@/types/listSchedule";
import { invoke } from "@tauri-apps/api/core";

const bgStore = useBackgroundTaskStore();
const scheduleStore = useListScheduleStore();
const listStore = useListStore();

onMounted(() => {
  bgStore.loadTemplates();
  scheduleStore.loadSchedules();
});

// ─── 重复任务：暂停 / 恢复 ───
async function onTogglePause(task: Task, paused: boolean): Promise<void> {
  try {
    await bgStore.setPaused(task.id, paused);
    Message.success(paused ? "已暂停该重复任务" : "已恢复该重复任务");
  } catch (e) {
    Message.error("切换失败：" + String(e));
  }
}

// ─── 清单生成计划：启用 / 停用（转发给 listScheduleStore） ───
async function onToggleSchedule(s: ListSchedule, enabled: boolean): Promise<void> {
  try {
    await scheduleStore.updateSchedule(s.id, { enabled });
  } catch (e) {
    Message.error("切换失败：" + String(e));
  }
}

// ─── 立即运行一次（并发触发两类后台任务） ───
const running = ref(false);
const runResult = ref<{ recurring: number; schedule: number } | null>(null);
async function onRunNow(): Promise<void> {
  running.value = true;
  runResult.value = null;
  try {
    // 并发触发：重复任务生成 + 清单生成计划 tick
    const [recurring, schedule] = await Promise.all([
      invoke<number>("task_generate_recurring"),
      invoke<number>("list_schedule_run_now"),
    ]);
    runResult.value = { recurring, schedule };
    // 清单生成后刷新侧边栏
    await listStore.loadLists();
    const total = recurring + schedule;
    Message.success(
      total > 0
        ? `已生成 ${recurring} 个重复任务 + ${schedule} 个清单/目录`
        : "当前无需生成（均已存在或未命中）",
    );
  } catch (e) {
    Message.error("运行失败：" + String(e));
  } finally {
    running.value = false;
  }
}

// 暂停中的重复任务数量（用于标题展示）
const pausedCount = computed(
  () => bgStore.recurringTemplates.filter((t) => t.recurrencePaused).length,
);

// ─── 单条运行（卡片上的运行按钮） ───
const runningIds = ref<Set<string>>(new Set());

/** 运行单个重复模板 */
async function onRunTemplate(task: Task): Promise<void> {
  runningIds.value.add(task.id);
  try {
    const n = await bgStore.runTemplateOne(task.id);
    Message.success(n > 0 ? `已生成 1 个新实例` : "当前无需生成（当期已存在或未命中）");
  } catch (e) {
    Message.error("运行失败：" + String(e));
  } finally {
    runningIds.value.delete(task.id);
  }
}

/** 运行单个清单生成计划（运行后刷新侧边栏） */
async function onRunSchedule(s: ListSchedule): Promise<void> {
  runningIds.value.add(s.id);
  try {
    const n = await bgStore.runScheduleOne(s.id);
    await listStore.loadLists();
    Message.success(n > 0 ? `已生成 ${n} 个清单/目录` : "当前无需生成（目标项均已存在或未命中）");
  } catch (e) {
    Message.error("运行失败：" + String(e));
  } finally {
    runningIds.value.delete(s.id);
  }
}
</script>

<template>
  <div class="bt-section">
    <!-- 顶部说明 + 立即运行 -->
    <div class="bt-section__header">
      <p class="bt-section__desc">
        后台任务会按设置间隔自动扫描并生成。重复任务的实例被删除后不会重生；暂停后不再生成新实例。
      </p>
      <a-button
        type="text"
        size="small"
        :loading="running"
        @click="onRunNow"
      >
        立即运行一次
      </a-button>
    </div>

    <!-- 区块 1：重复任务 -->
    <div class="bt-block">
      <div class="bt-block__title">
        重复任务 · {{ bgStore.recurringTemplates.length }}
        <span v-if="pausedCount > 0" class="bt-block__hint">
          （{{ pausedCount }} 个已暂停）
        </span>
      </div>
      <div
        v-if="bgStore.recurringTemplates.length === 0"
        class="bt-block__empty"
      >
        暂无重复任务模板
      </div>
      <div v-else class="bt-block__list">
        <div
          v-for="t in bgStore.recurringTemplates"
          :key="t.id"
          class="bt-card"
          :class="{ 'bt-card--paused': t.recurrencePaused }"
        >
          <div class="bt-card__header">
            <span class="bt-card__name">{{ t.title }}</span>
            <span class="bt-card__freq">
              {{ formatRecurrence(t.recurrenceFreq, t.recurrenceInterval) }}
            </span>
            <span
              v-if="t.recurrencePaused"
              class="bt-card__badge"
            >已暂停</span>
            <span
              v-else-if="t.done"
              class="bt-card__badge bt-card__badge--done"
            >已完成</span>
            <span class="bt-card__spacer" />
            <a-switch
              :model-value="!t.recurrencePaused"
              size="small"
              @update:model-value="(v) => onTogglePause(t, !(v as boolean))"
            />
            <a-button
              type="text"
              size="mini"
              class="bt-card__run"
              :loading="runningIds.has(t.id)"
              title="立即生成下一期"
              @click.stop="onRunTemplate(t)"
            >
              <template #icon><icon-refresh :size="13" /></template>
            </a-button>
          </div>
          <!-- 周期详情：起止日期 + 剩余次数 -->
          <div class="bt-card__meta">
            <span v-if="t.dueEndAt">到期：{{ t.dueEndAt.slice(0, 10) }}</span>
            <span v-if="t.recurrenceEndAt">结束：{{ t.recurrenceEndAt.slice(0, 10) }}</span>
            <span v-if="t.recurrenceCount != null">剩余 {{ t.recurrenceCount }} 次</span>
            <span v-if="!t.dueEndAt && !t.recurrenceEndAt && t.recurrenceCount == null" class="bt-card__meta-hint">无结束限制</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 区块 2：清单生成计划 -->
    <div class="bt-block">
      <div class="bt-block__title">
        清单生成计划 · {{ scheduleStore.schedules.length }}
      </div>
      <div
        v-if="scheduleStore.schedules.length === 0"
        class="bt-block__empty"
      >
        暂无清单生成计划
      </div>
      <div v-else class="bt-block__list">
        <div
          v-for="s in scheduleStore.schedules"
          :key="s.id"
          class="bt-card"
          :class="{ 'bt-card--paused': !s.enabled }"
        >
          <div class="bt-card__header">
            <span
              class="bt-card__dot"
              :style="{ background: s.color }"
            />
            <span class="bt-card__name">{{ s.name }}</span>
            <span class="bt-card__freq">{{ s.freq }}</span>
            <span
              v-if="!s.enabled"
              class="bt-card__badge"
            >已停用</span>
            <span class="bt-card__spacer" />
            <a-switch
              :model-value="s.enabled"
              size="small"
              @update:model-value="(v) => onToggleSchedule(s, v as boolean)"
            />
            <a-button
              type="text"
              size="mini"
              class="bt-card__run"
              :loading="runningIds.has(s.id)"
              title="立即运行该计划"
              @click.stop="onRunSchedule(s)"
            >
              <template #icon><icon-refresh :size="13" /></template>
            </a-button>
          </div>
        </div>
      </div>
    </div>
    <!-- 区块 3：定时提醒（只读列表，点击卡片打开任务详情） -->
    <ReminderListSection />
  </div>
</template>

<style scoped>
.bt-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 顶部说明 + 立即运行按钮 */
.bt-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bt-section__desc {
  margin: 0;
  font-size: 12px;
  color: var(--jt-text-secondary);
  line-height: 1.6;
  flex: 1;
}

/* 区块 */
.bt-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bt-block__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
}
.bt-block__hint {
  font-weight: 400;
  color: var(--jt-text-tertiary);
}
.bt-block__empty {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  padding: 16px 0;
}
.bt-block__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 卡片（沿用 ls-card 风格） */
.bt-card {
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  padding: 10px 14px;
  transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
}
.bt-card:hover {
  border-color: var(--jt-text-tertiary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}
/* 暂停/停用态：整体变淡 */
.bt-card--paused {
  opacity: 0.6;
}
.bt-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 周期详情副信息行 */
.bt-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 11px;
  color: var(--jt-text-tertiary);
  padding-left: 0;
}
.bt-card__meta-hint {
  color: var(--jt-text-tertiary);
  opacity: 0.7;
}
.bt-card__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.bt-card__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bt-card__freq {
  font-size: 11px;
  color: var(--jt-text-secondary);
  background: var(--jt-surface-hover);
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.bt-card__badge {
  font-size: 11px;
  color: var(--jt-warning);
  background: color-mix(in srgb, var(--jt-warning) 12%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.bt-card__badge--done {
  color: var(--jt-text-tertiary);
  background: var(--jt-surface-hover);
}
.bt-card__spacer {
  flex: 1;
}
/* 单条运行按钮：紧凑无 padding，与开关并排 */
.bt-card__run {
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
}
.bt-card__run:hover {
  color: var(--jt-primary);
}
</style>
