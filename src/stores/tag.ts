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

  return { tags, loading, loadTags, createTag, deleteTag, getByName };
});
