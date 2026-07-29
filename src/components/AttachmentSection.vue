<script setup lang="ts">
// 附件区 —— 纯展示组件（添加入口在任务详情面板的更多菜单里）
// 仅在有附件时渲染（v-if 由父组件控制）。本组件负责：列表展示、预览、每行操作。
import { ref, computed, reactive } from "vue";
import { Message } from "@arco-design/web-vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTaskStore } from "@/stores/task";
import {
  categorizeAttachment,
  type Attachment,
  type AttachmentCategory,
} from "@/types";
import { getAttachmentFullpath, revealAttachment, copyAttachmentPath } from "@/api/db";
import AttachmentPreview from "@/components/AttachmentPreview.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import MenuPopover from "@/components/MenuPopover.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";

const props = defineProps<{
  taskId: string;
  attachments: Attachment[];
}>();

const taskStore = useTaskStore();

// 当前预览的附件（null = 关闭预览）
const previewAttachment = ref<Attachment | null>(null);

// 每行附件的菜单展开状态（key = attachment.id）
// 用 reactive 对象而非 ref<Map>，确保模板能响应式更新
const menuVisibleMap = reactive<Record<string, boolean>>({});

// ─── 文件类型展示 ────────────────────────────────────────
/** 文件类型 → emoji 图标 */
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

/** 格式化文件大小（字节 → KB/MB） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── 附件操作（每行的「⋯ 更多」菜单）────────────────────

/** 获取附件的 asset:// URL（用于图片/视频/音频/pdf 预览与系统打开） */
async function getAssetUrl(att: Attachment): Promise<string> {
  const full = await getAttachmentFullpath(att.storedName);
  return convertFileSrc(full);
}

/** 待删除的附件（null = 确认弹窗关闭） */
const pendingDelete = ref<Attachment | null>(null);

/** 附件操作类型（与菜单项一一对应） */
type AttachmentAction = "reveal" | "systemOpen" | "copyPath" | "delete";

async function handleAction(action: AttachmentAction, att: Attachment) {
  switch (action) {
    case "reveal":
      try {
        await revealAttachment(att.storedName);
      } catch (e) {
        Message.error("定位文件失败：" + String(e));
      }
      break;
    case "systemOpen":
      try {
        // 用 webview 打开 asset url，交给系统处理（图片/视频会被 webview 渲染，
        // 其他类型会触发系统默认程序；这里更稳妥的做法是 reveal 后让用户双击）
        const url = await getAssetUrl(att);
        window.open(url, "_blank");
      } catch (e) {
        Message.error("打开失败：" + String(e));
      }
      break;
    case "copyPath":
      try {
        await copyAttachmentPath(att.storedName);
        Message.success("已复制文件路径");
      } catch (e) {
        Message.error("复制路径失败：" + String(e));
      }
      break;
    case "delete":
      pendingDelete.value = att;
      break;
  }
}

/** 确认删除附件（弹窗点"删除"时触发） */
async function confirmDeleteAttachment() {
  const att = pendingDelete.value;
  if (!att) return;
  try {
    await taskStore.removeAttachment(props.taskId, att.id);
    Message.success("已删除附件");
  } catch (e) {
    Message.error("删除附件失败：" + String(e));
  } finally {
    pendingDelete.value = null;
  }
}

// ─── 预览 ────────────────────────────────────────────────
/** 点击附件行 → 根据类型分流 */
async function onAttachmentClick(att: Attachment) {
  const cat = categoryOf(att);
  if (cat === "other") {
    // 不支持应用内预览，提示定位
    Message.info("此类型不支持应用内预览，已为你定位到文件");
    await revealAttachment(att.storedName).catch(() => {});
    return;
  }
  previewAttachment.value = att;
}

function closePreview() {
  previewAttachment.value = null;
}

// ─── 展示 ────────────────────────────────────────────────
const sortedAttachments = computed(() =>
  // 按添加时间倒序（最新在上）
  [...props.attachments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
</script>

<template>
  <div class="attachment-section">
    <div class="attachment-section__header">
      <span class="attachment-section__title">
        <span class="attachment-section__icon">📎</span>
        附件
        <span class="attachment-section__count">({{ attachments.length }})</span>
      </span>
    </div>

    <!-- 附件列表 -->
    <div class="attachment-section__list">
      <div
        v-for="att in sortedAttachments"
        :key="att.id"
        class="attachment-item"
        :title="`点击预览：${att.originalName}`"
        @click="onAttachmentClick(att)"
      >
        <span class="attachment-item__icon">{{ CATEGORY_ICON[categoryOf(att)] }}</span>
        <div class="attachment-item__info">
          <span class="attachment-item__name">{{ att.originalName }}</span>
          <span class="attachment-item__meta">{{ formatSize(att.size) }}</span>
        </div>
        <MenuPopover
          v-model:visible="menuVisibleMap[att.id]"
          placement="bottom-right"
          @click.stop
        >
          <template #trigger>
            <button
              class="attachment-item__more"
              title="更多操作"
              @click.stop="menuVisibleMap[att.id] = !menuVisibleMap[att.id]"
            >
              <icon-more :size="16" />
            </button>
          </template>
          <MenuPopoverItem @click="handleAction('reveal', att); menuVisibleMap[att.id] = false">
            <icon-folder :size="15" />
            <span>打开所在文件夹</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="handleAction('systemOpen', att); menuVisibleMap[att.id] = false">
            <icon-settings :size="15" />
            <span>用浏览器打开</span>
          </MenuPopoverItem>
          <MenuPopoverItem @click="handleAction('copyPath', att); menuVisibleMap[att.id] = false">
            <icon-copy :size="15" />
            <span>复制文件路径</span>
          </MenuPopoverItem>
          <MenuPopoverItem danger @click="handleAction('delete', att); menuVisibleMap[att.id] = false">
            <icon-delete :size="15" />
            <span>删除附件</span>
          </MenuPopoverItem>
        </MenuPopover>
      </div>
    </div>

    <!-- 预览弹窗 -->
    <AttachmentPreview
      v-if="previewAttachment"
      :attachment="previewAttachment"
      @close="closePreview"
    />

    <!-- 删除附件确认弹窗（统一极简卡片风） -->
    <ConfirmDialog
      :visible="!!pendingDelete"
      desc="附件文件也会从磁盘移除，此操作无法撤销。"
      @update:visible="(v) => { if (!v) pendingDelete = null; }"
      @confirm="confirmDeleteAttachment"
    >
      <template #title>删除附件「<strong>{{ pendingDelete?.originalName }}</strong>」？</template>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.attachment-section {
  margin-top: 8px;
  padding: 4px 0;
}

.attachment-section__header {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  user-select: none;
}

.attachment-section__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--jt-text-secondary, #6b7280);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.attachment-section__icon {
  font-size: 14px;
}

.attachment-section__count {
  color: var(--jt-text-tertiary, #9ca3af);
  font-weight: 400;
}

.attachment-section__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.12s;
}

.attachment-item:hover {
  background-color: var(--jt-bg-secondary, #f3f4f6);
}

.attachment-item__icon {
  font-size: 18px;
  flex-shrink: 0;
  line-height: 1;
}

.attachment-item__info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.attachment-item__name {
  font-size: 13px;
  color: var(--jt-text-primary, #1f2937);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.attachment-item__meta {
  font-size: 11px;
  color: var(--jt-text-tertiary, #9ca3af);
}

.attachment-item__more {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: var(--jt-text-tertiary, #9ca3af);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.12s;
}

.attachment-item:hover .attachment-item__more {
  opacity: 1;
}

.attachment-item__more:hover {
  background-color: var(--jt-bg-tertiary, rgba(0, 0, 0, 0.06));
  color: var(--jt-text-primary, #1f2937);
}
</style>
