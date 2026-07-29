<script setup lang="ts">
// 任务详情面板的附件下拉浮窗（带箭头）
//
// 从 chips 行附件 PropertyChip 的位置下方弹出，带箭头指向 trigger，
// 比抽屉更轻量（不再占据详情面板 360px 宽度，描述区彻底不被压缩）。
//
// 职责：
//   - 弹窗容器（开关 + 箭头 + 顶部 header 自管）
//   - 标题 "📎 附件 (N)" 右侧 "+" 添加按钮（点击调 useAttachmentUpload.pickFiles）
//   - 下方用 <AttachmentSection> 渲染列表（含预览、⋯ 菜单、删除）
//
// 为什么顶部 header 自管（不复用 AttachmentSection 内部 header）：
//   - AttachmentSection header 写在 scoped style，无法叠加"+"按钮
//   - AttachmentSection 是多场景复用组件（详情面板主区等），侵入它会让其他场景凭空多个"+"
//   - 这里通过 :deep() 隐藏嵌套 AttachmentSection 的 header，浮窗独占自绘 header

import { computed } from "vue";
import AttachmentSection from "@/components/AttachmentSection.vue";
import { useAttachmentUpload } from "@/composables/useAttachmentUpload";
import type { Attachment } from "@/types";

const props = defineProps<{
  /** v-model:visible */
  visible: boolean;
  taskId: string;
  attachments: Attachment[];
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

// 附件上传（点 "+" 触发；与详情面板 footer 更多菜单共用同一上传链路）
const { pickFiles: pickAttachmentFiles, uploading } = useAttachmentUpload(
  () => props.taskId,
);

async function onAddClick() {
  await pickAttachmentFiles();
}

const visible = computed(() => props.visible);
</script>

<template>
  <a-popover
    :visible="visible"
    :show-arrow="true"
    :arrow-style="{ backgroundColor: 'transparent' }"
    :content-style="{ padding: 0, border: 'none', background: 'transparent', boxShadow: 'none' }"
    :popup-style="{ padding: 0 }"
    position="bottom"
    trigger="click"
    :popup-visible-async="false"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <!-- a-popover 的 trigger 是默认 slot（PropertyChip 直接放这里作为触发元素） -->
    <slot />
    <template #content>
      <div class="att-popover">
        <!-- 自绘 header：标题 + 附件计数 + "+" 添加按钮 -->
        <header class="att-popover__header">
          <span class="att-popover__title">
            <span class="att-popover__icon">📎</span>
            <span>附件</span>
            <span class="att-popover__count">({{ attachments.length }})</span>
          </span>
          <button
            class="att-popover__add"
            title="添加附件"
            :disabled="uploading"
            @click="onAddClick"
          >
            <icon-plus :size="14" />
            <span>添加附件</span>
          </button>
        </header>
        <div class="att-popover__list">
          <AttachmentSection :task-id="taskId" :attachments="attachments" />
        </div>
      </div>
    </template>
  </a-popover>
</template>

<style scoped>
.att-popover {
  /* 浮窗外观：圆角、表面背景、与详情面板 chips 行其它浮层一致 */
  width: 360px;
  /* 固定高度 480：内容少时多余部分是空白，内容多时滚动。 */
  height: 480px;
  display: flex;
  flex-direction: column;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  scrollbar-width: none;
  font-family: var(--font-body);
}

.att-popover::-webkit-scrollbar {
  display: none;
}

body[arco-theme="dark"] .att-popover {
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.3);
}

/* 自绘 header：标题 + 添加按钮水平排列 */
.att-popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--jt-border);
  user-select: none;
}

.att-popover__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--jt-text-secondary, #6b7280);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.att-popover__icon {
  font-size: 14px;
  line-height: 1;
}

.att-popover__count {
  color: var(--jt-text-tertiary, #9ca3af);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.att-popover__add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: background-color 0.12s;
}

.att-popover__add:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--jt-primary) 12%, var(--jt-surface-sunken));
}

.att-popover__add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 列表区：占满剩余高度，内部滚动；隐藏嵌套 AttachmentSection 的 header
   （它已经在 att-popover__header 自绘了，避免双 header）。 */
.att-popover__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  scrollbar-width: none;
}

.att-popover__list::-webkit-scrollbar {
  display: none;
}

/* 嵌套的 AttachmentSection 自带 header 在浮窗中已不需要（自绘了） */
.att-popover__list :deep(.attachment-section__header) {
  display: none;
}
</style>

