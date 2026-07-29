<script setup lang="ts">
// 附件区 —— 任务详情面板中独立于富文本 note 的附件管理区块
// 位置：备注(RichTextEditor)下方、检查项(checklist)上方
// 功能：添加(按钮/拖拽/粘贴)、列表展示、预览触发、更多菜单(定位/系统打开/复制路径/删除)
import { ref, computed, reactive } from "vue";
import { Message, Modal } from "@arco-design/web-vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTaskStore } from "@/stores/task";
import {
  categorizeAttachment,
  isBlockedAttachment,
  type Attachment,
  type AttachmentCategory,
} from "@/types";
import { getAttachmentFullpath, revealAttachment, copyAttachmentPath } from "@/api/db";
import AttachmentPreview from "@/components/AttachmentPreview.vue";
import MenuPopover from "@/components/MenuPopover.vue";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";

const props = defineProps<{
  taskId: string;
  attachments: Attachment[];
}>();

const taskStore = useTaskStore();

// 当前预览的附件（null = 关闭预览）
const previewAttachment = ref<Attachment | null>(null);

// 上传中标记（批量添加时显示进度反馈）
const uploading = ref(false);

// 拖拽高亮
const dragOver = ref(false);

// 每行附件的菜单展开状态（key = attachment.id）
// 用 reactive 对象而非 ref<Map>，确保模板能响应式更新
const menuVisibleMap = reactive<Record<string, boolean>>({});

// ─── 文件类型展示 ────────────────────────────────────────
/** 文件类型 → emoji 图标 + 主题色 */
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

// ─── 添加附件 ────────────────────────────────────────────
/** 校验并过滤文件列表（拦截可执行类） */
function filterValidFiles(files: File[]): File[] {
  const blocked: string[] = [];
  const valid: File[] = [];
  for (const f of files) {
    if (isBlockedAttachment(f.name)) {
      blocked.push(f.name);
    } else {
      valid.push(f);
    }
  }
  if (blocked.length > 0) {
    Message.warning(`已拦截可执行文件：${blocked.join("、")}`);
  }
  return valid;
}

/** 点击「+ 添加」按钮 → 系统文件选择器 */
async function pickFiles() {
  const selected = await openDialog({
    multiple: true,
  });
  if (!selected) return;
  // openDialog 单选返回 string，多选返回 string[]；统一成数组
  const paths = Array.isArray(selected) ? selected : [selected];
  // 从路径读 File 对象（Tauri dialog 返回的是路径字符串，需要 fetch 转 File）
  const files: File[] = [];
  for (const p of paths) {
    const file = await pathToFile(p);
    if (file) files.push(file);
  }
  await addFiles(files);
}

/** 把本地文件路径转为 File 对象（通过 fetch asset 协议读 blob） */
async function pathToFile(path: string): Promise<File | null> {
  try {
    // Tauri 2 中可用 fetch + convertFileSrc 读本地文件
    const src = convertFileSrc(path);
    const res = await fetch(src);
    const blob = await res.blob();
    // 从路径提取文件名
    const name = path.split(/[/\\]/).pop() ?? "file";
    return new File([blob], name, { type: blob.type });
  } catch (e) {
    console.error("[Attachment] 读文件失败:", path, e);
    return null;
  }
}

/** 批量添加文件到当前任务 */
async function addFiles(files: File[]) {
  const valid = filterValidFiles(files);
  if (valid.length === 0) return;

  uploading.value = true;
  try {
    await taskStore.addAttachments(props.taskId, valid);
    Message.success(`已添加 ${valid.length} 个附件`);
  } catch (e) {
    console.error("[Attachment] 添加附件失败:", e);
    Message.error("添加附件失败：" + String(e));
  } finally {
    uploading.value = false;
  }
}

// ─── 拖拽上传 ────────────────────────────────────────────
function onDragOver(e: DragEvent) {
  e.preventDefault();
  dragOver.value = true;
}

function onDragLeave(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length > 0) {
    addFiles(files);
  }
}

// ─── 附件操作（每行的「⋯ 更多」菜单）────────────────────

/** 获取附件的 asset:// URL（用于图片/视频/音频/pdf 预览与系统打开） */
async function getAssetUrl(att: Attachment): Promise<string> {
  const full = await getAttachmentFullpath(att.storedName);
  return convertFileSrc(full);
}

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
      confirmRemoveAttachment(att);
      break;
  }
}

/** 删除附件（带二次确认） */
function confirmRemoveAttachment(att: Attachment) {
  Modal.warning({
    title: "删除附件",
    content: `确定删除「${att.originalName}」吗？附件文件也会从磁盘移除。`,
    hideCancel: false,
    okText: "删除",
    cancelText: "取消",
    onOk: async () => {
      try {
        await taskStore.removeAttachment(props.taskId, att.id);
        Message.success("已删除附件");
      } catch (e) {
        Message.error("删除附件失败：" + String(e));
      }
    },
  });
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
  <div
    class="attachment-section"
    :class="{ 'attachment-section--drag': dragOver }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="attachment-section__header">
      <span class="attachment-section__title">
        <span class="attachment-section__icon">📎</span>
        附件
        <span v-if="attachments.length" class="attachment-section__count">
          ({{ attachments.length }})
        </span>
      </span>
      <button
        class="attachment-section__add"
        :disabled="uploading"
        :title="uploading ? '上传中…' : '添加附件'"
        @click="pickFiles"
      >
        <span v-if="uploading" class="attachment-section__spinner" />
        <span v-else>＋</span>
        <span class="attachment-section__add-text">添加</span>
      </button>
    </div>

    <!-- 空状态：拖拽提示 -->
    <div v-if="attachments.length === 0" class="attachment-section__empty">
      <span v-if="!dragOver">拖拽文件到此，或点击「添加」</span>
      <span v-else>松开以上传</span>
    </div>

    <!-- 附件列表 -->
    <div v-else class="attachment-section__list">
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

    <!-- 拖拽高亮遮罩 -->
    <div v-if="dragOver" class="attachment-section__drop-hint">
      <span>📎 松开以上传文件</span>
    </div>

    <!-- 预览弹窗 -->
    <AttachmentPreview
      v-if="previewAttachment"
      :attachment="previewAttachment"
      @close="closePreview"
    />
  </div>
</template>

<style scoped>
.attachment-section {
  position: relative;
  margin-top: 8px;
  padding: 4px 0;
  border-radius: 8px;
  transition: background-color 0.15s;
}

.attachment-section--drag {
  background-color: var(--jt-bg-tertiary, rgba(79, 70, 229, 0.08));
  outline: 2px dashed var(--jt-accent, #4f46e5);
  outline-offset: -2px;
}

.attachment-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
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

.attachment-section__add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--jt-accent, #4f46e5);
  background: transparent;
  border: 1px solid var(--jt-border-light, #e5e7eb);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s;
}

.attachment-section__add:hover:not(:disabled) {
  background-color: var(--jt-bg-tertiary, rgba(79, 70, 229, 0.08));
  border-color: var(--jt-accent, #4f46e5);
}

.attachment-section__add:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.attachment-section__spinner {
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: attachment-spin 0.8s linear infinite;
}

@keyframes attachment-spin {
  to {
    transform: rotate(360deg);
  }
}

.attachment-section__empty {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--jt-text-tertiary, #9ca3af);
  text-align: center;
  border: 1px dashed var(--jt-border-light, #e5e7eb);
  border-radius: 6px;
  margin: 4px 4px 0;
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

.attachment-section__drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--jt-accent, #4f46e5);
  font-weight: 600;
  background-color: var(--jt-bg-tertiary, rgba(79, 70, 229, 0.12));
  border-radius: 8px;
  pointer-events: none;
}
</style>
