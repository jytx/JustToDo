// 习惯 store —— 管理习惯的 CRUD 和打卡
import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import type { HabitWithStats } from "@/api/db";
import * as db from "@/api/db";

export const useHabitStore = defineStore("habit", () => {
  const habits = ref<HabitWithStats[]>([]);
  const loading = ref(false);

  /** 每个 habit 的打卡日志缓存（YYYY-MM-DD 集合）—— 避免每周渲染都打 IPC */
  const logs = reactive<Record<string, Set<string>>>({});

  /** 加载单个 habit 的打卡日志（已加载过则跳过） */
  async function loadLogs(habitId: string, force = false) {
    if (!force && logs[habitId]) return;
    const rows = await db.getHabitLogs(habitId);
    const set = new Set<string>();
    for (const [date] of rows) set.add(date);
    logs[habitId] = set;
  }

  async function loadHabits() {
    loading.value = true;
    try {
      habits.value = await db.getHabits();
    } finally {
      loading.value = false;
    }
  }

  async function createHabit(params: {
    name: string;
    color?: string;
    repeatRule?: string;
    timeOfDay?: "morning" | "afternoon" | "evening";
  }) {
    const habit = await db.createHabit(params);
    await loadHabits(); // 重新加载获取统计
    return habit;
  }

  async function deleteHabit(id: string) {
    await db.deleteHabit(id);
    habits.value = habits.value.filter((h) => h.habit.id !== id);
    delete logs[id];
  }

  async function toggleCheck(habitId: string, date?: string) {
    const checked = await db.toggleHabitCheck(habitId, date);
    // 更新本地状态（仅当 toggle 的是今天时，刷新 todayDone 字段）
    const h = habits.value.find((x) => x.habit.id === habitId);
    if (h) {
      const todayStr = new Date().toISOString().slice(0, 10);
      if (!date || date === todayStr) {
        h.todayDone = checked;
      }
      if (checked) {
        h.streak += 1;
        h.totalDays += 1;
      } else {
        h.streak = Math.max(0, h.streak - 1);
        h.totalDays = Math.max(0, h.totalDays - 1);
      }
    }
    // 同步本地 logs 缓存
    if (date) {
      const set = logs[habitId] ?? new Set<string>();
      if (checked) set.add(date);
      else set.delete(date);
      logs[habitId] = set;
    }
    return checked;
  }

  /**
   * 拖拽重排习惯：按 orderedIds 重新计算 position（1000 步长）
   * 并批量写库
   */
  async function reorderHabits(orderedIds: string[]) {
    const idSet = new Set(orderedIds);
    const reordered = orderedIds
      .map((id) => habits.value.find((h) => h.habit.id === id))
      .filter((h): h is HabitWithStats => !!h);
    const others = habits.value.filter((h) => !idSet.has(h.habit.id));
    const merged = [...reordered, ...others];
    merged.forEach((h, i) => {
      h.habit.position = (i + 1) * 1000;
    });
    habits.value = merged;
    await db.reorderHabits(merged.map((h) => [h.habit.id, h.habit.position]));
  }

  return {
    habits,
    logs,
    loading,
    loadHabits,
    loadLogs,
    createHabit,
    deleteHabit,
    toggleCheck,
    reorderHabits,
  };
});
