<script setup lang="ts">
// 回收站任务/笔记只读详情弹窗
//
// 回收站条目（任务/笔记）点击后打开：完整属性 + 子任务树 + 富文本备注 + 附件列表。
// 纯只读展示 —— 无任何编辑入口（数据在回收站中，恢复后才可编辑）。
// 子树数据来自 trash_get_task_detail（后端不过滤 deleted_at，整树返回平鋪列表），
// 前端组树后展平为带 depth 的行列表，缩进渲染（全部展开，符合查看场景）。
import { computed, ref, watch } from "vue";
import type { Task } from "@/types";
import type { Tag } from "@/api/db";
import * as db from "@/api/db";
import { useListStore } from "@/stores/list";
import PriorityDot from "@/components/PriorityDot.vue";

const props = defineProps<{
  /** 是否显示（v-model:visible） */
  visible: boolean;
  /** 回收站条目 id（null = 关闭态占位） */
  taskId: string | null;
}>();

const emit = defineEmits<{ "update:visible": [value: boolean] }>();

const listStore = useListStore();

const loading = ref(false);
const task = ref<Task | null>(null);
const children = ref<Task[]>([]);
const tags = ref<Tag[]>([]);

// immediate：组件可能经 v-if 按需挂载（打开时初始即 visible=true），
// 无变化可监听，需立即执行一次；挂载于关闭态时 open=false 直接跳过
watch(
  () => [props.visible, props.taskId] as const,
  async ([open, id]) => {
    if (!open || !id) return;
    loading.value = true;
    task.value = null;
    try {
      const detail = await db.getTrashTaskDetail(id);
      task.value = detail.task;
      children.value = detail.children;
      tags.value = detail.tags;
    } catch (e) {
      console.error("[TrashDetail] 加载失败:", e);
      emit("update:visible", false);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/** 缩进行的子任务树：平铺列表 → 按 parentId 组树 → DFS 展平带 depth */
interface FlatRow {
  task: Task;
  depth: number;
}
const subtaskRows = computed<FlatRow[]>(() => {
  const byParent = new Map<string | null, Task[]>();
  for (const t of children.value) {
    const list = byParent.get(t.parentId) ?? [];
    list.push(t);
    byParent.set(t.parentId, list);
  }
  const rows: FlatRow[] = [];
  const walk = (pid: string | null, depth: number): void => {
    for (const t of byParent.get(pid) ?? []) {
      rows.push({ task: t, depth });
      walk(t.id, depth + 1);
    }
  };
  if (task.value) walk(task.value.id, 0);
  return rows;
});

/** 所属清单名（listStore 缓存里查；清单可能也在回收站 → getById 为 null 显示原位置兜底） */
const listName = computed(() =>
  task.value ? (listStore.getById(task.value.listId)?.name ?? null) : null,
);

/** 日期区间显示（"2026-08-16T14:30:00" → "2026-08-16"；有区间时 "起 ~ 止"） */
const dueText = computed(() => {
  const t = task.value;
  if (!t || (!t.dueStartAt && !t.dueEndAt)) return null;
  const s = t.dueStartAt?.slice(0, 10);
  const e = t.dueEndAt?.slice(0, 10);
  if (s && e && s !== e) return `${s} ~ ${e}`;
  return (e ?? s) as string;
});

const isNote = computed(() => task.value?.kind === "note");
</script>

<template>
  <a-modal
    :visible="visible"
    :width="560"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="trash-detail-modal"
    :modal-style="{ maxWidth: 'calc(100vw - 32px)' }"
    @cancel="emit('update:visible', false)"
  >
    <div class="trash-detail">
      <a-spin v-if="loading" class="trash-detail__loading" />
      <template v-else-if="task">
        <!-- 标题（完成态划线） -->
        <div class="trash-detail__title-row">
          <span class="trash-detail__done" :class="{ 'trash-detail__done--checked': task.done }">
            ✓
          </span>
          <span class="trash-detail__title" :class="{ 'trash-detail__title--done': task.done }">
            {{ task.title }}
          </span>
        </div>

        <!-- 属性行：类型/清单/优先级/日期/标签 -->
        <div class="trash-detail__props">
          <span class="trash-detail__prop">
            <PriorityDot :priority="task.priority" />
            {{ dueText ?? "无日期" }}
          </span>
          <span v-if="listName" class="trash-detail__prop">{{ isNote ? "笔记本" : "清单" }}：{{ listName }}</span>
          <span class="trash-detail__prop trash-detail__prop--muted">{{ isNote ? "笔记" : "任务" }} · 已删除</span>
        </div>
        <div v-if="tags.length > 0" class="trash-detail__tags">
          <span
            v-for="tag in tags"
            :key="tag.id"
            class="trash-detail__tag"
            :style="{
              backgroundColor: `color-mix(in srgb, ${tag.color} 14%, transparent)`,
            }"
          >
            {{ tag.name }}
          </span>
        </div>

        <!-- 子任务树（缩进平铺，全部展开） -->
        <div v-if="subtaskRows.length > 0" class="trash-detail__block">
          <div class="trash-detail__block-label">子任务（{{ subtaskRows.length }}）</div>
          <div
            v-for="row in subtaskRows"
            :key="row.task.id"
            class="trash-detail__sub"
            :style="{ paddingLeft: `${row.depth * 18}px` }"
          >
            <span class="trash-detail__done" :class="{ 'trash-detail__done--checked': row.task.done }">
              ✓
            </span>
            <span :class="{ 'trash-detail__title--done': row.task.done }">{{ row.task.title }}</span>
          </div>
        </div>

        <!-- 备注（富文本只读渲染；图片 src 已是 asset 协议可直接显示） -->
        <div v-if="task.note && task.note.trim() !== ''" class="trash-detail__block">
          <div class="trash-detail__block-label">{{ isNote ? "内容" : "备注" }}</div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="trash-detail__note" v-html="task.note" />
        </div>

        <!-- 附件（只读列出） -->
        <div v-if="task.attachments.length > 0" class="trash-detail__block">
          <div class="trash-detail__block-label">附件（{{ task.attachments.length }}）</div>
          <div v-for="att in task.attachments" :key="att.id" class="trash-detail__att">
            📎 {{ att.originalName }}
            <span class="trash-detail__att-size">{{ (att.size / 1024).toFixed(1) }} KB</span>
          </div>
        </div>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.trash-detail {
  min-height: 80px;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trash-detail__loading {
  align-self: center;
  margin: 24px 0;
}

.trash-detail__title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.trash-detail__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--jt-text-primary);
  word-break: break-word;
}

.trash-detail__title--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

/* 只读完成圈：空心圈 / 勾选实心（纯 CSS，无交互） */
.trash-detail__done {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.5px solid var(--jt-border);
  color: transparent;
  font-size: 11px;
  line-height: 13px;
  text-align: center;
  margin-top: 2px;
}

.trash-detail__done--checked {
  background-color: var(--jt-accent);
  border-color: var(--jt-accent);
  color: #fff;
}

.trash-detail__props {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
  color: var(--jt-text-secondary);
}

.trash-detail__prop {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.trash-detail__prop--muted {
  color: var(--jt-text-tertiary);
}

.trash-detail__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.trash-detail__tag {
  font-size: 12px;
  color: var(--jt-text-secondary);
  padding: 1px 8px;
  border-radius: 10px;
}

.trash-detail__block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.trash-detail__block-label {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.trash-detail__sub {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  padding: 2px 0;
  word-break: break-word;
}

.trash-detail__note {
  font-size: 13px;
  color: var(--jt-text-primary);
  line-height: 1.7;
  word-break: break-word;
}

/* 富文本只读排版（v-html 内容需 :deep 穿透 scoped） */
.trash-detail__note :deep(p) {
  margin: 0 0 8px;
}

.trash-detail__note :deep(h1),
.trash-detail__note :deep(h2),
.trash-detail__note :deep(h3) {
  margin: 12px 0 6px;
  font-size: 15px;
  font-weight: 600;
}

.trash-detail__note :deep(ul),
.trash-detail__note :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.trash-detail__note :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}

.trash-detail__note :deep(code) {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background-color: var(--jt-surface-sunken);
  padding: 1px 5px;
  border-radius: 4px;
}

.trash-detail__note :deep(pre) {
  background-color: var(--jt-surface-sunken);
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
}

.trash-detail__note :deep(blockquote) {
  margin: 0 0 8px;
  padding-left: 10px;
  border-left: 3px solid var(--jt-border);
  color: var(--jt-text-secondary);
}

.trash-detail__note :deep(table) {
  border-collapse: collapse;
  margin-bottom: 8px;
}

.trash-detail__note :deep(th),
.trash-detail__note :deep(td) {
  border: 1px solid var(--jt-border);
  padding: 4px 8px;
  font-size: 12px;
}

.trash-detail__att {
  font-size: 12px;
  color: var(--jt-text-secondary);
  padding: 3px 0;
}

.trash-detail__att-size {
  color: var(--jt-text-tertiary);
  margin-left: 6px;
}
</style>
