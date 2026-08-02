// 任务分组 store —— 管理清单的分组（Group）
// 每个清单有自己的分组，支持增删改查 + 排序。
import { ref, computed } from "vue";
import { defineStore } from "pinia";
import type { Group } from "@/types";
import * as db from "@/api/db";

export const useGroupStore = defineStore("group", () => {
  /** 所有分组（扁平，按 listId 分组使用时前端过滤） */
  const groups = ref<Group[]>([]);
  /** 当前选中清单的 ID */
  const currentListId = ref<string>("");

  /** 当前清单的分组（按 sortOrder 排序） */
  const currentGroups = computed(() =>
    groups.value
      .filter((g) => g.listId === currentListId.value)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  );

  /** 加载某清单的分组 */
  async function loadGroups(listId: string): Promise<void> {
    currentListId.value = listId;
    const listGroups = await db.getGroups(listId);
    // 替换该清单的分组（移除旧的 + 加入新的）
    groups.value = [
      ...groups.value.filter((g) => g.listId !== listId),
      ...listGroups,
    ];
  }

  /** 创建分组
   * @param sortOrder 指定排序位置；不传则后端追加到末尾 */
  async function createGroup(listId: string, name: string, sortOrder?: number): Promise<Group | null> {
    try {
      const group = await db.createGroup(listId, name, sortOrder);
      groups.value = [...groups.value, group];
      return group;
    } catch (e) {
      console.error("创建分组失败:", e);
      return null;
    }
  }

  /** 重命名分组 */
  async function renameGroup(id: string, name: string): Promise<void> {
    const group = groups.value.find((g) => g.id === id);
    if (!group) return;
    const prevName = group.name;
    group.name = name;
    try {
      await db.updateGroup(id, { name });
    } catch {
      group.name = prevName;
    }
  }

  /** 删除分组（组内任务回填默认分组） */
  async function deleteGroup(id: string): Promise<void> {
    await db.deleteGroup(id);
    groups.value = groups.value.filter((g) => g.id !== id);
  }

  /** 重排分组顺序 */
  async function reorderGroups(orderedIds: string[]): Promise<void> {
    // 本地立即更新 sortOrder
    orderedIds.forEach((id, i) => {
      const g = groups.value.find((g) => g.id === id);
      if (g) g.sortOrder = i * 1000;
    });
    await db.reorderGroups(orderedIds);
    // 触发响应式
    groups.value = [...groups.value];
  }

  /** 根据 ID 获取分组 */
  function getById(id: string): Group | undefined {
    return groups.value.find((g) => g.id === id);
  }

  /** 清空（切换清单时） */
  function clear(): void {
    groups.value = [];
    currentListId.value = "";
  }

  return {
    groups,
    currentListId,
    currentGroups,
    loadGroups,
    createGroup,
    renameGroup,
    deleteGroup,
    reorderGroups,
    getById,
    clear,
  };
});
