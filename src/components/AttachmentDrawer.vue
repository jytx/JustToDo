<script setup lang="ts">
// 详情面板的附件抽屉 —— 从详情面板左边缘滑入的全高抽屉
//
// 职责：只展示当前任务的附件列表 + 删除能力。
// 与 AttachmentSection 的区别：
//   - 无上传入口（上传仍在详情面板 footer 更多菜单里）
//   - 无 ⋯ 行操作菜单（预览/复制路径/在管理器打开等）
//   - 只保留"删除"一个动作
//
// 为什么新建而不是加 mode 参数到 AttachmentSection：
//   - 避免组件内部出现"显示预览弹窗 vs 不显示"等多分支（flag-args 反模式）
//   - 后续如果用户提出"抽屉要支持上传"，直接在此组件内加按钮即可

import { ref } from "vue";
import { Message } from "@arco-design/web-vue";
import {
  categorizeAttachment,
  type Attachment,
  type AttachmentCategory,
} from "@/types";
import { useTaskStore } from "@/stores/task";
import ConfirmDialog from "@/components/ConfirmDialog.vue";

const props = defineProps<{
  /** v-model:visible */
  visible: boolean;
  taskId: string;
  attachments: Attachment[];
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const taskStore = useTaskStore();

// ─── 文件类型展示 ────────────────────────────────────────
/** 文件类型 → emoji 图标（与 AttachmentSection 保持一致） */
function categoryOf(att: Attachment): AttachmentCategory {
  return categorizeAttachment(att.originalName);
}

const CATEGORY_ICON: Record<AttachmentCategory, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  markdown: "📝",
  text: "📄",
  pdf: "📕",
  other: "📎",
};

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 添加时间（短格式：MM-DD HH:mm） */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── 删除附件（二次确认） ────────────────────────────────
const pendingDelete = ref<Attachment | null>(null);
const deleting = ref(false);

function askDelete(att: Attachment) {
  pendingDelete.value = att;
}

function cancelDelete() {
  pendingDelete.value = null;
  deleting.value = false;
}

async function confirmDelete() {
  const att = pendingDelete.value;
  if (!att) return;
  deleting.value = true;
  try {
    await taskStore.removeAttachment(props.taskId, att.id);
    pendingDelete.value = null;
  } catch (e) {
    Message.error("删除附件失败：" + String(e));
  } finally {
    deleting.value = false;
  }
}

function onClose() {
  emit("update:visible", false);
}
</script>

<template>
  <!-- placement="right" 让抽屉贴详情面板右边缘、从右向左滑入详情面板内部。
       :mask="false" 不挡任务列表可点; :header="false" :closable="false" 都去掉 Arco 默认 chrome
       (header 用我们自己画的,关闭按钮也自绘以复用详情面板的极简风) -->
  <a-drawer
    :visible="visible"
    :width="360"
    placement="right"
    :footer="false"
    :header="false"
    :mask="false"
    :closable="false"
    :drawer-style="{
      background: 'var(--jt-surface)',
      borderLeft: '1px solid var(--jt-border)',
      boxShadow: '-4px 0 16px rgba(0,0,0,0.06)',
      maxWidth: 'calc(100vw - 32px)',
    }"
    @cancel="onClose"
  >
    <div class="att-drawer">
      <header class="att-drawer__header">
        <span class="att-drawer__title">
          附件 <span class="att-drawer__count">({{ attachments.length }})</span>
        </span>
        <button
          class="att-drawer__close"
          title="关闭"
          @click="onClose"
        >
          <icon-close :size="16" />
        </button>
      </header>

      <div class="att-drawer__body">
        <div v-if="!attachments.length" class="att-drawer__empty">
          暂无附件
        </div>

        <ul v-else class="att-drawer__list">
          <li
            v-for="att in attachments"
            :key="att.id"
            class="att-drawer__item"
          >
            <span class="att-drawer__icon">{{ CATEGORY_ICON[categoryOf(att)] }}</span>
            <div class="att-drawer__info">
              <div class="att-drawer__name" :title="att.originalName">
                {{ att.originalName }}
              </div>
              <div class="att-drawer__meta">
                {{ formatSize(att.size) }} · {{ formatDate(att.createdAt) }}
              </div>
            </div>
            <button
              class="att-drawer__delete"
              title="删除"
              @click="askDelete(att)"
            >
              <icon-delete :size="14" />
            </button>
          </li>
        </ul>
      </div>
    </div>

    <!-- 删除二次确认（项目统一风格） -->
    <ConfirmDialog
      :visible="!!pendingDelete"
      :loading="deleting"
      @update:visible="(v) => { if (!v) cancelDelete(); }"
      @confirm="confirmDelete"
    >
      <template #title>
        删除附件「<strong>{{ pendingDelete?.originalName }}</strong>」？
      </template>
      将同时清理磁盘上的文件，此操作无法撤销。
    </ConfirmDialog>
  </a-drawer>
</template>

<style scoped>
.att-drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: var(--font-body);
}

.att-drawer__header {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--jt-border);
  flex-shrink: 0;
}

.att-drawer__title {
  flex: 1;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--jt-text-primary);
  letter-spacing: -0.01em;
}

.att-drawer__count {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--jt-text-tertiary);
  margin-left: 2px;
}

.att-drawer__close {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
}

.att-drawer__close:hover {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.att-drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  scrollbar-width: none;
}

.att-drawer__body::-webkit-scrollbar {
  display: none;
}

.att-drawer__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: var(--jt-text-tertiary);
}

.att-drawer__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.att-drawer__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: 8px;
  transition: background-color 0.12s;
  min-width: 0;
}

.att-drawer__item:hover {
  background-color: var(--jt-surface-hover);
}

.att-drawer__icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  border-radius: 6px;
  background-color: var(--jt-surface-sunken);
}

.att-drawer__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.att-drawer__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-primary);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.att-drawer__meta {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--jt-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.att-drawer__delete {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.12s;
  padding: 0;
}

.att-drawer__item:hover .att-drawer__delete {
  opacity: 1;
}

.att-drawer__delete:hover {
  background-color: color-mix(in srgb, var(--jt-error) 10%, transparent);
  color: var(--jt-error);
}
</style>
