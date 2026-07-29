<script setup lang="ts">
// 任务详情面板的附件抽屉壳子
//
// 职责单一：仅承担"抽屉容器"职责（开关 + 标题 + 关闭按钮 + 布局）。
// 抽屉内容直接嵌入 <AttachmentSection>，由后者负责：
//   - 附件列表渲染（emoji 图标 + 文件名 + 大小）
//   - 点击行预览 / 未支持类型 fallback 定位
//   - 单行 ⋯ 菜单：打开所在文件夹 / 用浏览器打开 / 复制文件路径 / 删除
//   - 删除二次确认（ConfirmDialog）
//
// 为什么抽屉壳子和 AttachmentSection 分离：
//   - 抽屉只负责"展示位置"（从右向左滑入、不挡主区）
//   - 附件列表只负责"展示内容"（所有能力都在它内部实现）
//   - AttachmentSection 仍可在详情面板主区、未来其它场景复用
//   - 任一能力的改进（如预览增强、批量删除）只在 AttachmentSection 一处改

import AttachmentSection from "@/components/AttachmentSection.vue";
import type { Attachment } from "@/types";

defineProps<{
  /** v-model:visible */
  visible: boolean;
  taskId: string;
  attachments: Attachment[];
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

function onClose() {
  emit("update:visible", false);
}
</script>

<template>
  <!-- placement="right" 让抽屉贴详情面板右边缘、从右向左滑入详情面板内部。
       :mask="false" 不挡任务列表可点；:header="false" :closable="false" 都去掉 Arco 默认 chrome。
       抽屉内的"附件 (N)"标题由嵌入的 AttachmentSection 自带，避免双重 header。 -->
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
      <!-- 抽屉自带的极简 header：左侧让位给 AttachmentSection 自带的标题空间，
           实际只渲染关闭按钮（避免双重标题） -->
      <header class="att-drawer__header">
        <button
          class="att-drawer__close"
          title="关闭"
          @click="onClose"
        >
          <icon-close :size="16" />
        </button>
      </header>

      <div class="att-drawer__body">
        <AttachmentSection :task-id="taskId" :attachments="attachments" />
      </div>
    </div>
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
  justify-content: flex-end;
  height: 36px;
  padding: 0 8px;
  flex-shrink: 0;
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
  scrollbar-width: none;
}

.att-drawer__body::-webkit-scrollbar {
  display: none;
}
</style>
