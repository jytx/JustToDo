// 标签 store —— 管理标签的 CRUD
import { defineStore } from "pinia";
import { ref } from "vue";
import type { Tag } from "@/api/db";
import * as db from "@/api/db";

export const useTagStore = defineStore("tag", () => {
  const tags = ref<Tag[]>([]);
  const loading = ref(false);

  async function loadTags() {
    loading.value = true;
    try {
      tags.value = await db.getTags();
    } finally {
      loading.value = false;
    }
  }

  async function createTag(name: string) {
    const tag = await db.createTag(name);
    tags.value.push(tag);
    return tag;
  }

  async function deleteTag(id: string) {
    await db.deleteTag(id);
    tags.value = tags.value.filter((t) => t.id !== id);
  }

  function getByName(name: string): Tag | undefined {
    return tags.value.find((t) => t.name === name);
  }

  /**
   * 拖拽重排标签（按 tags.value 的当前顺序持久化为整数 position）
   * - 立即更新本地 position（按 1000 步长重排）
   * - 调 db.reorderTags 批量写库
   */
  async function reorderTags(orderedIds: string[]) {
    const idSet = new Set(orderedIds);
    const reordered: Tag[] = orderedIds
      .map((id) => tags.value.find((t) => t.id === id))
      .filter((t): t is Tag => !!t);
    // 任何未出现在 orderedIds 中的旧标签，保持相对位置接在末尾
    const others = tags.value.filter((t) => !idSet.has(t.id));
    const merged = [...reordered, ...others];
    merged.forEach((t, i) => {
      t.position = (i + 1) * 1000;
    });
    tags.value = merged;
    await db.reorderTags(merged.map((t) => [t.id, t.position]));
  }

  return { tags, loading, loadTags, createTag, deleteTag, getByName, reorderTags };
});
