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

/**
 * 纯函数：更新映射中指定标签的属性（名称/颜色等），返回新映射（含该标签的任务
 * 产生新数组引用以触发响应式）。用于编辑标签后同步 taskTagMap，
 * 使任务列表项 / 详情面板的 chip 立即更新。
 */
function patchTagInMap(
  map: Record<string, Tag[]>,
  tagId: string,
  patch: Partial<Pick<Tag, "name" | "color">>,
): Record<string, Tag[]> {
  let changed = false;
  const next: Record<string, Tag[]> = {};
  for (const [taskId, tags] of Object.entries(map)) {
    const idx = tags.findIndex((t) => t.id === tagId);
    if (idx === -1) {
      next[taskId] = tags;
    } else {
      // 替换该标签对象 + 产生新数组引用，触发响应式更新
      next[taskId] = tags.map((t) =>
        t.id === tagId
          ? { ...t, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.color !== undefined ? { color: patch.color } : {}) }
          : t,
      );
      changed = true;
    }
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

  async function createTag(name: string, color: string) {
    const tag = await db.createTag(name, color);
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

  /** 重命名标签 / 改颜色（不改 position / createdAt）。
   *  color 为 undefined 时只改 name（向后兼容）；传字符串时同时更新颜色。 */
  async function renameTag(id: string, name: string, color?: string) {
    await db.renameTag(id, name, color);
    const tag = tags.value.find((t) => t.id === id);
    if (tag) {
      tag.name = name;
      if (color !== undefined) tag.color = color;
    }
    // 改了标签属性后，任务列表项 / 详情面板的 chip 缓存也需刷新（颜色/名称变了）
    if (color !== undefined) {
      const taskStore = useTaskStore();
      taskStore.taskTagMap = patchTagInMap(taskStore.taskTagMap, id, { name, color });
    }
  }

  function getByName(name: string): Tag | undefined {
    return tags.value.find((t) => t.name === name);
  }

  function getById(id: string): Tag | undefined {
    return tags.value.find((t) => t.id === id);
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

  return { tags, loading, loadTags, createTag, deleteTag, renameTag, getByName, getById, reorderTags };
});
