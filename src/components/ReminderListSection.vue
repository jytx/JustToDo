<script setup lang="ts">
// 定时提醒 —— 后台任务面板的第三个区块
// 展示所有设置了提醒的未完成任务及其触发时刻（只读列表）：
//   - 触发时刻 = 指定时刻 remindAt，或相对偏移 dueEndAt - offset（后端已计算好）
//   - 状态徽标：已通知过 → 灰化「已提醒」；已过触发时刻未通知 → 「待补发」（下次扫描补发）
//   - 点击卡片 → taskStore.selectTask 打开任务详情面板（可查看/修改提醒）
// 数据来自 Rust 命令 reminder_upcoming_list，组件挂载时加载一次（进入设置页即刷新）。
import { onMounted, ref } from "vue";
import { listUpcomingReminders } from "@/api/db";
import { useTaskStore } from "@/stores/task";
import { formatReminder, formatSingleDate, nowLocalIso } from "@/utils/date";
import type { UpcomingReminder } from "@/types";

const taskStore = useTaskStore();
const reminders = ref<UpcomingReminder[]>([]);

// 挂载时取一次当前本地时间字面量（与 triggerAt 同格式，可直接字典序比较）
const nowIso = nowLocalIso();

async function load(): Promise<void> {
  try {
    reminders.value = await listUpcomingReminders();
  } catch (e) {
    console.error("加载定时提醒列表失败", e);
  }
}

onMounted(load);

/** 该条是否已通知过（灰化展示） */
function isNotified(r: UpcomingReminder): boolean {
  return r.notifiedAt != null;
}

/** 该条是否已过触发时刻但还没通知（待补发徽标） */
function isPendingFire(r: UpcomingReminder): boolean {
  return !isNotified(r) && r.triggerAt != null && r.triggerAt <= nowIso;
}

/** 触发时刻展示文本（复用 formatSingleDate 的今天/明天/周X/M月D日 + HH:mm） */
function triggerText(r: UpcomingReminder): string {
  if (!r.triggerAt) return "—";
  return formatSingleDate(r.triggerAt)?.text ?? r.triggerAt;
}

/** 点击卡片：打开该任务详情面板 */
function onOpen(r: UpcomingReminder): void {
  void taskStore.selectTask(r.taskId);
}
</script>

<template>
  <div class="bt-block">
    <div class="bt-block__title">定时提醒 · {{ reminders.length }}</div>
    <p class="rl-desc">到点后由系统通知提醒（应用需保持运行）；已通知过的条目灰化显示。</p>
    <div v-if="reminders.length === 0" class="bt-block__empty">暂无定时提醒</div>
    <div v-else class="bt-block__list">
      <div
        v-for="r in reminders"
        :key="r.taskId"
        class="bt-card rl-card"
        :class="{ 'rl-card--notified': isNotified(r) }"
        title="点击查看任务详情"
        @click="onOpen(r)"
      >
        <div class="bt-card__header">
          <span
            class="rl-card__time"
            :class="{ 'rl-card__time--overdue': isPendingFire(r) }"
          >{{ triggerText(r) }}</span>
          <span class="bt-card__name">{{ r.title }}</span>
          <span v-if="r.listName" class="rl-card__list">
            <span v-if="r.listColor" class="bt-card__dot" :style="{ background: r.listColor }" />
            {{ r.listName }}
          </span>
          <span class="bt-card__spacer" />
          <span v-if="isNotified(r)" class="bt-card__badge bt-card__badge--done">已提醒</span>
          <span v-else-if="isPendingFire(r)" class="bt-card__badge">待补发</span>
        </div>
        <!-- 提醒方式 + 截止时间 -->
        <div class="bt-card__meta">
          <span>{{ formatReminder(r.offsetMinutes, r.remindAt) }}</span>
          <span v-if="r.dueEndAt">截止：{{ r.dueEndAt.slice(0, 16).replace("T", " ") }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与 BackgroundTaskSection.vue 的 bt-card 视觉风格保持一致（scoped 不共享，此处复制） */
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
.bt-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bt-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 11px;
  color: var(--jt-text-tertiary);
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

/* 区块说明 */
.rl-desc {
  margin: 0;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  line-height: 1.6;
}

/* 提醒卡片：可点击 */
.rl-card {
  cursor: pointer;
}
/* 已通知过：整体变淡 */
.rl-card--notified {
  opacity: 0.55;
}
/* 触发时刻徽标：靛蓝淡底突出时间；已过触发时刻未通知 → 橙色 */
.rl-card__time {
  font-size: 12px;
  font-weight: 600;
  color: var(--jt-primary);
  background: color-mix(in srgb, var(--jt-primary) 10%, transparent);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
  white-space: nowrap;
}
.rl-card__time--overdue {
  color: var(--jt-warning);
  background: color-mix(in srgb, var(--jt-warning) 12%, transparent);
}
/* 清单名 chip（含颜色点） */
.rl-card__list {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--jt-text-secondary);
  background: var(--jt-surface-hover);
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  max-width: 30%;
}
.rl-card__list .bt-card__dot {
  width: 8px;
  height: 8px;
}
</style>
