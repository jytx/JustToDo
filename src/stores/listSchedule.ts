// 清单生成计划 —— Pinia store
// 维护计划列表，封装 CRUD；唯一数据源

import { defineStore } from "pinia";
import { ref } from "vue";

import {
  type CreateScheduleInput,
  type SchedulePreview,
  type UpdateScheduleInput,
  createListSchedule,
  deleteListSchedule,
  getListSchedules,
  previewListSchedule,
  runListScheduleNow,
  updateListSchedule,
} from "@/api/listSchedule";
import type { ListSchedule } from "@/types/listSchedule";

export const useListScheduleStore = defineStore("listSchedule", () => {
  /** 全部计划（含已停用），按 position 排序 */
  const schedules = ref<ListSchedule[]>([]);

  /** 启动时加载全部计划 */
  async function loadSchedules(): Promise<void> {
    schedules.value = await getListSchedules();
  }

  /** 新建计划 */
  async function createSchedule(input: CreateScheduleInput): Promise<void> {
    const created = await createListSchedule(input);
    schedules.value.push(created);
  }

  /** 更新计划（部分字段） */
  async function updateSchedule(
    id: string,
    input: UpdateScheduleInput,
  ): Promise<void> {
    await updateListSchedule(id, input);
    const idx = schedules.value.findIndex((s) => s.id === id);
    if (idx >= 0) {
      // 创建新对象引用以触发响应式
      schedules.value[idx] = { ...schedules.value[idx], ...input };
    }
  }

  /** 删除计划 */
  async function removeSchedule(id: string): Promise<void> {
    await deleteListSchedule(id);
    schedules.value = schedules.value.filter((s) => s.id !== id);
  }

  /** 立即触发一次生成（手动测试 / 补生成用） */
  async function runNow(): Promise<number> {
    return await runListScheduleNow();
  }

  /** 预览：模拟某天运行会生成哪些路径（不实际创建） */
  async function preview(date: string): Promise<SchedulePreview[]> {
    return await previewListSchedule(date);
  }

  return {
    schedules,
    loadSchedules,
    createSchedule,
    updateSchedule,
    removeSchedule,
    runNow,
    preview,
  };
});
