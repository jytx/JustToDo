// 后台任务 —— Pinia store
// 统一管理「重复任务模板」的运行态（清单生成计划复用 listScheduleStore，不在此重复维护）
// 提供：加载模板列表 / 暂停-恢复 / 查询生成历史

import { defineStore } from "pinia";
import { ref } from "vue";

import {
  getRecurrenceHistory,
  listRecurrenceTemplates,
  pauseRecurrence,
  runRecurrenceOne,
} from "@/api/db";
import { runListScheduleOne } from "@/api/listSchedule";
import type { RecurrenceHistoryEntry, Task } from "@/types";

export const useBackgroundTaskStore = defineStore("backgroundTask", () => {
  /** 全部重复任务模板（含已暂停、已完成），按创建时间倒序 */
  const recurringTemplates = ref<Task[]>([]);

  /** 加载所有重复模板（含已暂停 / 已完成） */
  async function loadTemplates(): Promise<void> {
    recurringTemplates.value = await listRecurrenceTemplates();
  }

  /** 暂停 / 恢复某个模板（局部更新本地缓存，避免全量重拉） */
  async function setPaused(id: string, paused: boolean): Promise<void> {
    await pauseRecurrence(id, paused);
    const idx = recurringTemplates.value.findIndex((t) => t.id === id);
    if (idx >= 0) {
      // 创建新对象引用以触发响应式
      recurringTemplates.value[idx] = {
        ...recurringTemplates.value[idx],
        recurrencePaused: paused,
      };
    }
  }

  /** 查询某模板的生成历史（最近 20 条） */
  async function fetchHistory(templateId: string): Promise<RecurrenceHistoryEntry[]> {
    return await getRecurrenceHistory(templateId);
  }

  /** 手动运行单个重复模板（跳过 paused/done 过滤），返回是否生成了新实例 */
  async function runTemplateOne(id: string): Promise<number> {
    return await runRecurrenceOne(id);
  }

  /** 手动运行单个清单生成计划（跳过 enabled 过滤），返回是否生成了新清单/目录 */
  async function runScheduleOne(id: string): Promise<number> {
    return await runListScheduleOne(id);
  }

  return {
    recurringTemplates,
    loadTemplates,
    setPaused,
    fetchHistory,
    runTemplateOne,
    runScheduleOne,
  };
});
