// 清单 store —— 管理清单列表的加载与创建
// 遵循 AGENTS.md：store 作为唯一数据源，组件只读取不缓存

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { List } from "@/types";
import * as db from "@/api/db";

export const useListStore = defineStore("list", () => {
  const lists = ref<List[]>([]);
  const loading = ref(false);
  /** 加载错误（若有），用于页面显示 */
  const error = ref<string | null>(null);

  /** 按 position 排序的清单 */
  const sortedLists = computed(() =>
    [...lists.value].sort((a, b) => a.position - b.position),
  );

  /** 清单数量映射（id → 未完成任务数），由 taskStore 填充 */
  const counts = ref<Record<string, number>>({});

  async function loadLists() {
    loading.value = true;
    error.value = null;
    try {
      lists.value = await db.getLists();
    } catch (e) {
      error.value = String(e);
      console.error("[listStore] loadLists 失败:", e);
    } finally {
      loading.value = false;
    }
  }

  async function createList(name: string, color: string) {
    const list = await db.createList(name, color);
    lists.value.push(list);
    return list;
  }

  function getById(id: string): List | undefined {
    return lists.value.find((l) => l.id === id);
  }

  return { lists, sortedLists, counts, loading, error, loadLists, createList, getById };
});
