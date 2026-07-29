// 标签 store —— 管理标签的 CRUD
import { defineStore } from "pinia";
import { ref } from "vue";
import type { Tag } from "@/api/db";
import * as db from "@/api/db";
import { useTaskStore } from "@/stores/task";

/**
 * 纯函数：从「任务 → 标签数组」映射中剔除指定标签。
 * 返回新映射（仅当确实出现剔除时才产生新引用，否则原样返回，避免无谓的响应式触发）。
 * 用于删除标签后同步清理 taskStore.taskTagMap，使任务列表项 / 详情面板立即不再显示该标签。
 */
function stripTagFromMap(
  map: Record<string, Tag[]>,
  tagId: string,
): Record<string, Tag[]> {
  let changed = false;
  const next: Record<string, Tag[]> = {};
  for (const [taskId, tags] of Object.entries(map)) {
    const filtered = tags.filter((t) => t.id !== tagId);
    next[taskId] = filtered;
    if (filtered.length !== tags.length) changed = true;
  }
  return changed ? next : map;
}

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
    // 同步清理任务标签缓存：后端已级联删除 task_tags，前端缓存需一并剔除，
    // 否则任务列表项（读 taskTagMap）和详情面板会继续显示已删除的标签。
    const taskStore = useTaskStore();
    taskStore.taskTagMap = stripTagFromMap(taskStore.taskTagMap, id);
  }

  /** 重命名标签（不改 position / createdAt） */
  async function renameTag(id: string, name: string) {
    await db.renameTag(id, name);
    const tag = tags.value.find((t) => t.id === id);
    if (tag) {
      tag.name = name;
    }
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

  return { tags, loading, loadTags, createTag, deleteTag, renameTag, getByName, reorderTags };
});
