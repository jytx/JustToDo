// 搜索 store —— 管理搜索状态和结果
import { defineStore } from "pinia";
import { ref } from "vue";
import type { Task } from "@/types";
import { searchTasks } from "@/api/db";

export const useSearchStore = defineStore("search", () => {
  const query = ref("");
  const results = ref<Task[]>([]);
  const loading = ref(false);
  const open = ref(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function show() {
    open.value = true;
    query.value = "";
    results.value = [];
  }

  function hide() {
    open.value = false;
  }

  async function search(q: string) {
    query.value = q;
    if (debounceTimer) clearTimeout(debounceTimer);

    if (!q.trim()) {
      results.value = [];
      return;
    }

    debounceTimer = setTimeout(async () => {
      loading.value = true;
      try {
        results.value = await searchTasks(q.trim());
      } catch (e) {
        console.error("[search] 搜索失败:", e);
        results.value = [];
      } finally {
        loading.value = false;
      }
    }, 150);
  }

  return { query, results, loading, open, show, hide, search };
});
