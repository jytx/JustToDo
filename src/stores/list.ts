// 清单 store —— 管理清单与目录的加载、创建、树形结构
// 遵循 AGENTS.md：store 作为唯一数据源，组件只读取不缓存

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { List } from "@/types";
import * as db from "@/api/db";

/** 带子节点的树形清单 */
export interface ListTreeNode extends List {
  children: ListTreeNode[];
}

export const useListStore = defineStore("list", () => {
  const lists = ref<List[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** 按 position 排序的扁平清单 */
  const sortedLists = computed(() =>
    [...lists.value].sort((a, b) => a.position - b.position),
  );

  /** 将扁平数组构建为树形结构 */
  const listTree = computed<ListTreeNode[]>(() => {
    const build = (parentId: string | null): ListTreeNode[] => {
      return sortedLists.value
        .filter((l) => l.parentId === parentId)
        .map((l) => ({ ...l, children: build(l.id) }));
    };
    return build(null);
  });

  /** 获取某目录下的直接子项 */
  function getChildren(parentId: string | null): List[] {
    return sortedLists.value.filter((l) => l.parentId === parentId);
  }

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

  async function createList(params: {
    name: string;
    color: string;
    parentId?: string | null;
    isFolder?: boolean;
  }) {
    const list = await db.createList(params);
    lists.value.push(list);
    return list;
  }

  function getById(id: string): List | undefined {
    return lists.value.find((l) => l.id === id);
  }

  /** 根据 "A/B/C" 路径查找或创建多级目录，返回最末级目录 ID */
  async function ensureFolderPath(path: string, color: string): Promise<string | null> {
    const segments = path.split("/").map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    let parentId: string | null = null;
    for (const seg of segments) {
      // 查找同级是否已有同名目录
      const existing = lists.value.find(
        (l) => l.parentId === parentId && l.isFolder && l.name === seg,
      );
      if (existing) {
        parentId = existing.id;
      } else {
        const folder = await createList({
          name: seg,
          color,
          parentId,
          isFolder: true,
        });
        parentId = folder.id;
      }
    }
    return parentId;
  }

  /**
   * 移动节点到新父级和位置
   * @param id 被移动的节点 ID
   * @param targetParentId 目标父级 ID（null = 根级）
   * @param targetIndex 在目标父级子列表中的插入位置（0 = 最前）
   */
  async function moveNode(id: string, targetParentId: string | null, targetIndex: number) {
    // 获取目标父级的子列表（移动前）
    const siblings = sortedLists.value.filter(
      (l) => l.parentId === targetParentId && l.id !== id,
    );

    // 计算新 position：取前后兄弟的中间值
    let newPosition: number;
    if (siblings.length === 0) {
      // 目标为空，给一个大值
      newPosition = Date.now();
    } else if (targetIndex <= 0) {
      // 插到最前面：比第一个小
      newPosition = siblings[0].position - 1000;
    } else if (targetIndex >= siblings.length) {
      // 插到最后面：比最后一个大
      newPosition = siblings[siblings.length - 1].position + 1000;
    } else {
      // 插到中间：取前后平均
      newPosition = Math.floor(
        (siblings[targetIndex - 1].position + siblings[targetIndex].position) / 2,
      );
    }

    await db.moveList(id, targetParentId, newPosition);

    // 更新本地数据
    const node = lists.value.find((l) => l.id === id);
    if (node) {
      node.parentId = targetParentId;
      node.position = newPosition;
    }
  }

  return {
    lists,
    sortedLists,
    listTree,
    loading,
    error,
    loadLists,
    createList,
    getById,
    getChildren,
    ensureFolderPath,
    moveNode,
  };
});
