<script setup lang="ts">
// 回收站区块 —— 设置页「回收站」section 的内容组件
//
// 数据：只展示「删除树」的根（顶层项，避免删一个目录后出现几十条）；
// 恢复 = 整棵子树回原位；彻底删除 = 物理删除整棵子树；清空 = 全部物理删除。
// 彻底删除与清空为不可逆操作，均需 ConfirmDialog 二次确认（关键词加粗）。
import { computed, onMounted, ref } from "vue";
import { Message } from "@arco-design/web-vue";
import {
  IconCheckCircle,
  IconFile,
  IconFolder,
  IconList,
  IconBook,
  IconUndo,
  IconDelete,
} from "@arco-design/web-vue/es/icon";
import type { TrashItem } from "@/types";
import { useTrashStore } from "@/stores/trash";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import TrashTaskDetailModal from "@/components/TrashTaskDetailModal.vue";
import TrashListDetailModal from "@/components/TrashListDetailModal.vue";

const trashStore = useTrashStore();
const listStore = useListStore();
const taskStore = useTaskStore();

onMounted(() => {
  void trashStore.load();
});

// ─── 只读详情（条目点击查看：任务/笔记 → 任务弹窗；清单/目录/笔记本 → 树形弹窗） ──

const detailVisible = ref(false);
const detailTaskId = ref<string | null>(null);
const detailListId = ref<string | null>(null);
/** 当前打开的详情类别（决定渲染哪个弹窗） */
const detailKind = ref<"task" | "list">("task");

function openDetail(item: TrashItem): void {
  detailKind.value = item.kind === "task" || item.kind === "note" ? "task" : "list";
  if (detailKind.value === "task") {
    detailTaskId.value = item.id;
  } else {
    detailListId.value = item.id;
  }
  detailVisible.value = true;
}

/** 目录树弹窗内点击任务行 → 切换到任务只读详情弹窗
 *  （v-if 分支切换使任务弹窗重新挂载，watch immediate 会立即加载） */
function openTaskFromTree(taskId: string): void {
  detailTaskId.value = taskId;
  detailKind.value = "task";
}

// ─── 展示映射（类型 → 图标/文字） ─────────────────────────

const KIND_META: Record<TrashItem["kind"], { icon: typeof IconList; label: string }> = {
  task: { icon: IconCheckCircle, label: "任务" },
  note: { icon: IconFile, label: "笔记" },
  list: { icon: IconList, label: "清单" },
  notebook: { icon: IconBook, label: "笔记本" },
  folder: { icon: IconFolder, label: "目录" },
};

/** 删除时间显示（"2026-08-16T14:30:00" → "2026-08-16 14:30"） */
function formatDeletedAt(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

/** 行副文案：类型 + 原位置（如「清单 · 工作」；根级/未知位置只显示类型） */
function originText(item: TrashItem): string {
  const label = KIND_META[item.kind].label;
  return item.origin ? `${label} · ${item.origin}` : label;
}

// ─── 恢复（无确认框：非破坏性操作，可再删一次） ──────────────

const restoring = ref(false);

async function onRestore(item: TrashItem): Promise<void> {
  restoring.value = true;
  try {
    await trashStore.restore(item);
    // 联动刷新主页数据：清单树（恢复清单/目录）+ 各处计数（恢复任务/笔记）
    await listStore.loadLists();
    await taskStore.refreshCounts();
    Message.success(`已恢复「${item.name}」`);
  } catch (e) {
    Message.error(`恢复失败：${e}`);
  } finally {
    restoring.value = false;
  }
}

// ─── 彻底删除（二次确认 + 加粗警示） ─────────────────────────

const purgeTarget = ref<TrashItem | null>(null);
const purging = ref(false);

async function confirmPurge(): Promise<void> {
  if (!purgeTarget.value) return;
  purging.value = true;
  try {
    await trashStore.purge(purgeTarget.value);
    purgeTarget.value = null;
    Message.success("已彻底删除");
  } catch (e) {
    Message.error(`彻底删除失败：${e}`);
  } finally {
    purging.value = false;
  }
}

// ─── 清空回收站（二次确认 + 加粗警示） ───────────────────────

const emptyConfirmVisible = ref(false);
const emptying = ref(false);

async function confirmEmpty(): Promise<void> {
  emptying.value = true;
  try {
    await trashStore.empty();
    emptyConfirmVisible.value = false;
    Message.success("回收站已清空");
  } catch (e) {
    Message.error(`清空失败：${e}`);
  } finally {
    emptying.value = false;
  }
}

const isEmpty = computed(() => !trashStore.loading && trashStore.items.length === 0);
</script>

<template>
  <div class="trash-section">
    <!-- 头部：计数说明 + 清空按钮 -->
    <div class="trash-section__header">
      <span class="trash-section__count">
        {{ trashStore.items.length > 0 ? `共 ${trashStore.items.length} 项` : "暂无内容" }}
      </span>
      <a-button
        v-if="trashStore.items.length > 0"
        size="small"
        status="danger"
        :loading="emptying"
        @click="emptyConfirmVisible = true"
      >
        <template #icon><icon-delete :size="14" /></template>
        清空回收站
      </a-button>
    </div>

    <!-- 条目列表 -->
    <div v-if="trashStore.items.length > 0" class="trash-section__list">
      <div v-for="item in trashStore.items" :key="item.id" class="trash-section__item">
        <component :is="KIND_META[item.kind].icon" :size="16" class="trash-section__item-icon" />
        <div
          class="trash-section__item-main trash-section__item-main--clickable"
          :title="item.kind === 'task' || item.kind === 'note' ? '点击查看详情' : '点击查看子内容'"
          @click="openDetail(item)"
        >
          <div class="trash-section__item-name" :title="item.name">{{ item.name }}</div>
          <div class="trash-section__item-meta">
            <span>{{ originText(item) }}</span>
            <span class="trash-section__item-dot">·</span>
            <span>删除于 {{ formatDeletedAt(item.deletedAt) }}</span>
          </div>
        </div>
        <div class="trash-section__item-actions">
          <a-button size="mini" :loading="restoring" @click="onRestore(item)">
            <template #icon><icon-undo :size="13" /></template>
            恢复
          </a-button>
          <a-button size="mini" status="danger" @click="purgeTarget = item">
            <template #icon><icon-delete :size="13" /></template>
            彻底删除
          </a-button>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <div v-else-if="isEmpty" class="trash-section__empty">
      <icon-delete :size="28" class="trash-section__empty-icon" />
      <p class="trash-section__empty-text">回收站是空的</p>
      <p class="trash-section__empty-hint">删除的任务、清单、目录和笔记会在这里保留，可随时恢复</p>
    </div>

    <!-- 彻底删除确认（不可逆，强警示文案） -->
    <ConfirmDialog
      :visible="!!purgeTarget"
      :loading="purging"
      :mask-closable="false"
      confirm-text="彻底删除"
      @update:visible="(v: boolean) => { if (!v) purgeTarget = null; }"
      @confirm="confirmPurge"
    >
      <template #title>
        彻底删除{{ KIND_META[purgeTarget?.kind ?? 'task'].label }}「<strong>{{ purgeTarget?.name }}</strong>」？
      </template>
      <template #default>
        <strong>删除后无法恢复</strong>，将同时永久删除其包含的全部子内容。
      </template>
    </ConfirmDialog>

    <!-- 清空回收站确认（不可逆，强警示文案） -->
    <ConfirmDialog
      v-model:visible="emptyConfirmVisible"
      :loading="emptying"
      :mask-closable="false"
      confirm-text="清空"
      @confirm="confirmEmpty"
    >
      <template #title><strong>清空回收站</strong>？</template>
      <template #default>
        将<strong>永久删除回收站中的 {{ trashStore.items.length }} 项内容</strong>，<strong>此操作无法撤销</strong>。
      </template>
    </ConfirmDialog>

    <!-- 只读详情弹窗（任务/笔记 → 属性+子任务+富文本；清单/目录/笔记本 → 子内容树） -->
    <TrashTaskDetailModal
      v-if="detailKind === 'task'"
      v-model:visible="detailVisible"
      :task-id="detailTaskId"
    />
    <TrashListDetailModal
      v-else
      v-model:visible="detailVisible"
      :list-id="detailListId"
      @open-task="openTaskFromTree"
    />
  </div>
</template>

<style scoped>
.trash-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trash-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
}

.trash-section__count {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.trash-section__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 条目行：凹陷底色区分常规设置项（不可进入，仅管理） */
.trash-section__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background-color: var(--jt-surface-sunken);
  transition: background-color 0.15s ease;
}

.trash-section__item:hover {
  background-color: var(--jt-surface-hover);
}

.trash-section__item-icon {
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
}

.trash-section__item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 任务/笔记条目可点开只读详情 */
.trash-section__item-main--clickable {
  cursor: pointer;
}

.trash-section__item-main--clickable:hover .trash-section__item-name {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.trash-section__item-name {
  font-size: 13px;
  color: var(--jt-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trash-section__item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.trash-section__item-dot {
  color: var(--jt-text-tertiary);
}

/* 操作按钮：默认淡显，hover 行时加深（降低视觉噪音） */
.trash-section__item-actions {
  display: flex;
  gap: 6px;
  opacity: 0.6;
  transition: opacity 0.15s ease;
}

.trash-section__item:hover .trash-section__item-actions {
  opacity: 1;
}

.trash-section__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 0;
}

.trash-section__empty-icon {
  color: var(--jt-empty-art, var(--jt-text-tertiary));
  margin-bottom: 4px;
}

.trash-section__empty-text {
  margin: 0;
  font-size: 14px;
  color: var(--jt-text-secondary);
}

.trash-section__empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--jt-text-tertiary);
}
</style>
