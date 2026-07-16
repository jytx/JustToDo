<script setup lang="ts">
// 习惯打卡视图 —— 展示所有习惯 + 今日打卡 + 统计
import { onMounted, ref } from "vue";
import { useHabitStore } from "@/stores/habit";
import { formatPageDate } from "@/utils/date";

const habitStore = useHabitStore();
const showCreateDialog = ref(false);
const newName = ref("");
const newColor = ref("#059669");

const colors = [
  "#EF4444", "#F59E0B", "#EAB308", "#059669",
  "#3B82F6", "#8B5CF6", "#EC4899", "#6B7280",
];

onMounted(async () => {
  await habitStore.loadHabits();
});

async function createHabit() {
  const name = newName.value.trim();
  if (!name) return;
  await habitStore.createHabit({ name, color: newColor.value });
  newName.value = "";
  newColor.value = "#059669";
  showCreateDialog.value = false;
}

async function toggle(habitId: string) {
  await habitStore.toggleCheck(habitId);
}
</script>

<template>
  <div class="habit-view">
    <header class="habit-view__header">
      <div>
        <h1 class="habit-view__title">习惯</h1>
        <p class="habit-view__subtitle">{{ formatPageDate() }}</p>
      </div>
      <a-button
        type="primary"
        size="small"
        @click="showCreateDialog = true"
      >
        <template #icon><icon-plus /></template>
        新建习惯
      </a-button>
    </header>

    <a-divider class="mb-4" />

    <!-- 习惯列表 -->
    <div class="habit-view__list">
      <div
        v-for="h in habitStore.habits"
        :key="h.habit.id"
        class="habit-card"
        :class="{ 'habit-card--done': h.todayDone }"
      >
        <div class="habit-card__left">
          <button
            class="habit-card__check"
            :class="{ 'habit-card__check--done': h.todayDone }"
            :style="{ backgroundColor: h.todayDone ? h.habit.color : 'transparent', borderColor: h.habit.color }"
            @click="toggle(h.habit.id)"
          >
            <icon-check v-if="h.todayDone" :size="16" style="color: white" />
          </button>
          <div class="habit-card__info">
            <span class="habit-card__name" :class="{ 'habit-card__name--done': h.todayDone }">
              {{ h.habit.name }}
            </span>
            <div class="habit-card__stats">
              <span class="habit-card__streak">
                <icon-fire
                  :size="14"
                  :style="{ color: h.streak > 0 ? 'var(--jt-error)' : 'currentColor' }"
                />
                {{ h.streak }} 天
              </span>
              <span>累计 {{ h.totalDays }} 天</span>
            </div>
          </div>
        </div>
        <a-button
          type="text"
          size="mini"
          @click="habitStore.deleteHabit(h.habit.id)"
        >
          <icon-delete :size="16" />
        </a-button>
      </div>

      <!-- 空状态 -->
      <div v-if="!habitStore.loading && habitStore.habits.length === 0" class="habit-view__empty">
        <span class="habit-view__empty-icon">🌱</span>
        <p class="habit-view__empty-title">还没有习惯</p>
        <p class="habit-view__empty-hint">创建一个习惯开始打卡吧</p>
      </div>
    </div>

    <!-- 新建习惯对话框 -->
    <a-modal
      v-model:visible="showCreateDialog"
      :width="400"
      title="新建习惯"
    >
      <div class="habit-dialog__field">
        <label class="habit-dialog__label">习惯名称</label>
        <a-input
          v-model="newName"
          placeholder="习惯名称"
          @keydown.enter="createHabit"
        />
      </div>
      <div class="habit-dialog__colors">
        <span class="habit-dialog__label">颜色</span>
        <div class="habit-dialog__color-row">
          <button
            v-for="c in colors"
            :key="c"
            class="habit-dialog__color"
            :class="{ 'habit-dialog__color--active': newColor === c }"
            :style="{ backgroundColor: c }"
            @click="newColor = c"
          />
        </div>
      </div>
      <template #footer>
        <a-button type="text" @click="showCreateDialog = false">取消</a-button>
        <a-button type="primary" @click="createHabit">创建</a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.habit-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.habit-view__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 24px 24px 12px;
}

.habit-view__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0;
  line-height: 1.3;
}

.habit-view__subtitle {
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin: 4px 0 0;
  font-weight: 400;
  letter-spacing: 0;
}

.habit-view__list {
  flex: 1;
  overflow-y: auto;
  padding: 0 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.habit-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-radius: 12px;
  background-color: var(--jt-surface);
  border: 1px solid var(--jt-border);
  transition: all 0.2s;
}

.habit-card--done {
  background-color: color-mix(in srgb, var(--jt-accent-soft) 40%, transparent);
}

.habit-card__left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.habit-card__check {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  background: transparent;
}

.habit-card__check--done {
  animation: pop 0.2s ease;
}

@keyframes pop {
  0% { transform: scale(1); }
  50% { transform: scale(1.15); }
  100% { transform: scale(1); }
}

.habit-card__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.habit-card__name {
  font-size: 15px;
  font-weight: 500;
}

.habit-card__name--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

.habit-card__stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--jt-text-secondary);
}

.habit-card__streak {
  display: flex;
  align-items: center;
  gap: 2px;
}

.habit-view__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}

.habit-view__empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.habit-view__empty-title {
  font-family: var(--font-display);
  font-size: 16px;
  margin: 0 0 4px;
}

.habit-view__empty-hint {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  margin: 0;
}

.habit-dialog__field {
  margin-bottom: 4px;
}

.habit-dialog__colors {
  margin-top: 12px;
}

.habit-dialog__label {
  display: block;
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin-bottom: 8px;
}

.habit-dialog__color-row {
  display: flex;
  gap: 8px;
}

.habit-dialog__color {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s;
}

.habit-dialog__color--active {
  border-color: color-mix(in srgb, var(--jt-text-primary) 60%, transparent);
}
</style>
