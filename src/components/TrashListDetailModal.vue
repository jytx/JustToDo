<script setup lang="ts">
// 回收站清单/目录/笔记本只读详情弹窗
//
// 树形展示删除树的全部子内容：子目录、子清单/笔记本、清单下的任务（含子任务层级）。
// 纯只读 —— 回收站列表只显示顶层项，子内容在这里补全可见性；
// 恢复 = 整棵树回原位（在回收站列表上操作，不在弹窗内）。
import { computed, ref, watch } from "vue";
import {
  IconCheckCircle,
  IconFile,
  IconFolder,
  IconList,
  IconBook,
} from "@arco-design/web-vue/es/icon";
import type { List, Task } from "@/types";
import * as db from "@/api/db";

const props = defineProps<{
  /** 是否显示（v-model:visible） */
  visible: boolean;
  /** 回收站条目 id（null = 关闭态占位） */
  listId: string | null;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  /** 点击树中任务行，请求打开该任务的只读详情弹窗（由 TrashSection 切换弹窗） */
  "open-task": [taskId: string];
}>();

const loading = ref(false);
const root = ref<List | null>(null);
const childLists = ref<List[]>([]);
const childTasks = ref<Task[]>([]);

// immediate：本组件经 v-else 按需挂载，打开时初始即为 visible=true + listId，
// 无 false→true 变化可监听，必须立即执行一次加载
watch(
  () => [props.visible, props.listId] as const,
  async ([open, id]) => {
    if (!open || !id) return;
    loading.value = true;
    root.value = null;
    try {
      const detail = await db.getTrashListDetail(id);
      root.value = detail.list;
      childLists.value = detail.lists;
      childTasks.value = detail.tasks;
    } catch (e) {
      console.error("[TrashListDetail] 加载失败:", e);
      emit("update:visible", false);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/** 树形行（DFS 展平，depth 驱动缩进） */
interface TreeRow {
  /** 行 id（清单或任务的 id；任务行点击转发详情查看） */
  id: string;
  icon: typeof IconList;
  name: string;
  depth: number;
  /** 任务行才有：完成态（清单/目录恒 undefined，也作为任务行判定依据） */
  done?: boolean;
}

/** 组树展平：清单按 parentId 嵌套；每个清单下先列直属一级任务
 *  （parentId 为 null、listId 匹配），任务再按 parentId 递归子级。
 *  目录 id 上直接挂载的任务（历史数据形态）也展示在该目录行下。 */
const rows = computed<TreeRow[]>(() => {
  const byParent = new Map<string | null, List[]>();
  for (const l of childLists.value) {
    const list = byParent.get(l.parentId) ?? [];
    list.push(l);
    byParent.set(l.parentId, list);
  }
  const tasksByParent = new Map<string | null, Task[]>();
  for (const t of childTasks.value) {
    const list = tasksByParent.get(t.parentId) ?? [];
    list.push(t);
    tasksByParent.set(t.parentId, list);
  }
  const out: TreeRow[] = [];
  // 任务子级递归（parent_id 指向某任务）
  const walkTaskChildren = (parentId: string, depth: number): void => {
    for (const t of tasksByParent.get(parentId) ?? []) {
      out.push({
        id: t.id,
        icon: t.kind === "note" ? IconFile : IconCheckCircle,
        name: t.title,
        depth,
        done: t.done,
      });
      walkTaskChildren(t.id, depth + 1);
    }
  };
  // 某清单直属的一级任务（parentId 为 null，按 listId 归属）
  const walkListTasks = (listId: string, depth: number): void => {
    for (const t of tasksByParent.get(null) ?? []) {
      if (t.listId !== listId) continue;
      out.push({
        id: t.id,
        icon: t.kind === "note" ? IconFile : IconCheckCircle,
        name: t.title,
        depth,
        done: t.done,
      });
      walkTaskChildren(t.id, depth + 1);
    }
  };
  const walkLists = (parentId: string | null, depth: number): void => {
    for (const l of byParent.get(parentId) ?? []) {
      out.push({
        id: l.id,
        icon: l.isFolder ? IconFolder : l.kind === "note" ? IconBook : IconList,
        name: l.name,
        depth,
      });
      walkLists(l.id, depth + 1);
      walkListTasks(l.id, depth + 1);
    }
  };
  if (root.value) {
    walkLists(root.value.id, 0);
    walkListTasks(root.value.id, 0);
  }
  return out;
});

/** 摘要：N 个清单/目录 · M 条内容 */
const summary = computed(() => {
  const nLists = childLists.value.length;
  const nTasks = childTasks.value.length;
  const parts: string[] = [];
  if (nLists > 0) parts.push(`${nLists} 个清单/目录`);
  if (nTasks > 0) parts.push(`${nTasks} 条内容`);
  return parts.length > 0 ? parts.join(" · ") : "暂无子内容";
});

const rootIcon = computed(() => {
  const r = root.value;
  if (!r) return IconList;
  if (r.isFolder) return IconFolder;
  return r.kind === "note" ? IconBook : IconList;
});

const rootTypeLabel = computed(() => {
  const r = root.value;
  if (!r) return "";
  if (r.isFolder) return r.kind === "note" ? "笔记本目录" : "目录";
  return r.kind === "note" ? "笔记本" : "清单";
});
</script>

<template>
  <a-modal
    :visible="visible"
    draggable
    :width="520"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="trash-detail-modal"
    :modal-style="{ maxWidth: 'calc(100vw - 32px)' }"
    @cancel="emit('update:visible', false)"
  >
    <div class="trash-list-detail">
      <a-spin v-if="loading" class="trash-list-detail__loading" />
      <template v-else-if="root">
        <!-- 根条目标题 -->
        <div class="trash-list-detail__title-row">
          <component :is="rootIcon" :size="16" class="trash-list-detail__root-icon" />
          <span class="trash-list-detail__title">{{ root.name }}</span>
        </div>
        <div class="trash-list-detail__meta">
          {{ rootTypeLabel }} · 已删除 · {{ summary }}
        </div>

        <!-- 子内容树（DFS 展平缩进；任务行可点击打开只读详情弹窗） -->
        <div v-if="rows.length > 0" class="trash-list-detail__tree">
          <div
            v-for="(row, i) in rows"
            :key="i"
            class="trash-list-detail__row"
            :class="{ 'trash-list-detail__row--task': row.done !== undefined }"
            :style="{ paddingLeft: `${row.depth * 18}px` }"
            :title="row.done !== undefined ? '点击查看详情' : undefined"
            @click="row.done !== undefined && emit('open-task', row.id)"
          >
            <span class="trash-list-detail__done" :class="{ 'trash-list-detail__done--checked': row.done }">
              ✓
            </span>
            <component :is="row.icon" :size="14" class="trash-list-detail__row-icon" />
            <span :class="{ 'trash-list-detail__row--done': row.done }">{{ row.name }}</span>
          </div>
        </div>
        <div v-else class="trash-list-detail__empty">该{{ rootTypeLabel }}内没有子内容</div>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.trash-list-detail {
  min-height: 80px;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trash-list-detail__loading {
  align-self: center;
  margin: 24px 0;
}

.trash-list-detail__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.trash-list-detail__root-icon {
  color: var(--jt-text-tertiary);
}

.trash-list-detail__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--jt-text-primary);
  word-break: break-word;
}

.trash-list-detail__meta {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.trash-list-detail__tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background-color: var(--jt-surface-sunken);
  border-radius: 8px;
  padding: 10px 12px;
}

.trash-list-detail__row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--jt-text-primary);
  padding: 3px 6px;
  margin: 0 -6px;
  border-radius: 6px;
  word-break: break-word;
}

/* 任务行可点击查看详情 */
.trash-list-detail__row--task {
  cursor: pointer;
}

.trash-list-detail__row--task:hover {
  background-color: var(--jt-surface-hover);
}

.trash-list-detail__row-icon {
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
}

.trash-list-detail__row--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

/* 只读完成圈（仅任务行使用；清单行恒空心隐藏勾） */
.trash-list-detail__done {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid var(--jt-border);
  color: transparent;
  font-size: 10px;
  line-height: 11px;
  text-align: center;
}

.trash-list-detail__done--checked {
  background-color: var(--jt-accent);
  border-color: var(--jt-accent);
  color: #fff;
}

.trash-list-detail__empty {
  font-size: 13px;
  color: var(--jt-text-tertiary);
  padding: 24px 0;
  text-align: center;
}
</style>
