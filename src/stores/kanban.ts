// 看板视图 store —— 持有看板的分列维度（优先级 / 分组），供 KanbanView 与 AppLayout 顶栏切换器共享。
// 状态仅 UI 层（无需持久化到 DB），默认按优先级分列。
import { ref } from "vue";
import { defineStore } from "pinia";

/** 看板分列维度 */
export type KanbanMode = "priority" | "group";

export const useKanbanStore = defineStore("kanban", () => {
  /** 当前列维度（默认优先级） */
  const mode = ref<KanbanMode>("priority");

  /** 切换列维度 */
  function setMode(next: KanbanMode): void {
    mode.value = next;
  }

  return { mode, setMode };
});
