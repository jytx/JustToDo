// 回收站 store —— 管理回收站条目列表、恢复、彻底删除、清空
//
// 数据流：删除操作走 task/list store 的 deleteTask/deleteList（软删除入站），
// 本 store 负责回收站页面数据与角标计数。
// 依赖方向保持单向：task store → 本 store（删除后刷新计数）；
// 恢复/清空后的主页数据联动由 TrashView 调用 task/list store 完成，
// 避免循环依赖。

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { TrashItem } from "@/types";
import * as db from "@/api/db";

/** TrashItem.kind（5 种细分类型）→ 后端恢复命令的大类（task | list） */
export function restoreKindOf(kind: TrashItem["kind"]): "task" | "list" {
  return kind === "task" || kind === "note" ? "task" : "list";
}

export const useTrashStore = defineStore("trash", () => {
  const items = ref<TrashItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** 回收站条目数（顶层项计数，侧边栏角标用） */
  const count = computed(() => items.value.length);

  /** 加载回收站列表（进入回收站页面 / 删除操作后刷新角标共用） */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      items.value = await db.getTrashItems();
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  /** 恢复单条（整棵子树回原位）。本地移除；主页数据联动由调用方（TrashView）负责 */
  async function restore(item: TrashItem): Promise<void> {
    await db.restoreTrashItem(item.id, restoreKindOf(item.kind));
    items.value = items.value.filter((t) => t.id !== item.id);
  }

  /** 彻底删除单条（物理删除整棵子树，不可恢复） */
  async function purge(item: TrashItem): Promise<void> {
    await db.purgeTrashItem(item.id, restoreKindOf(item.kind));
    items.value = items.value.filter((t) => t.id !== item.id);
  }

  /** 清空回收站（全部物理删除，不可恢复） */
  async function empty(): Promise<void> {
    await db.emptyTrash();
    items.value = [];
  }

  return { items, loading, error, count, load, restore, purge, empty };
});
