// 习惯 store —— 管理习惯的 CRUD 和打卡
import { defineStore } from "pinia";
import { ref } from "vue";
import type { HabitWithStats } from "@/api/db";
import * as db from "@/api/db";

export const useHabitStore = defineStore("habit", () => {
  const habits = ref<HabitWithStats[]>([]);
  const loading = ref(false);

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
  }) {
    const habit = await db.createHabit(params);
    await loadHabits(); // 重新加载获取统计
    return habit;
  }

  async function deleteHabit(id: string) {
    await db.deleteHabit(id);
    habits.value = habits.value.filter((h) => h.habit.id !== id);
  }

  async function toggleCheck(habitId: string) {
    const checked = await db.toggleHabitCheck(habitId);
    // 更新本地状态
    const h = habits.value.find((x) => x.habit.id === habitId);
    if (h) {
      h.todayDone = checked;
      if (checked) {
        h.streak += 1;
        h.totalDays += 1;
      } else {
        h.streak = Math.max(0, h.streak - 1);
        h.totalDays = Math.max(0, h.totalDays - 1);
      }
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

  return { habits, loading, loadHabits, createHabit, deleteHabit, toggleCheck, reorderHabits };
});
