<script setup lang="ts">
// 任务详情面板的附件下拉浮窗（带箭头）
//
// 从 chips 行附件 PropertyChip 的位置下方弹出，带箭头指向 trigger，
// 比抽屉更轻量（不再占据详情面板 360px 宽度，描述区彻底不被压缩）。
//
// 职责单一：仅承担"弹窗容器"职责（开关 + 箭头 + 布局）。
// 弹窗内容嵌入 <AttachmentSection>，由后者负责：
//   - 附件列表渲染（emoji 图标 + 文件名 + 大小）
//   - 点击行预览 / 未支持类型 fallback 定位
//   - 单行 ⋯ 菜单：打开所在文件夹 / 用浏览器打开 / 复制文件路径 / 删除
//   - 删除二次确认（ConfirmDialog）
//
// 为什么用 Arco 原生 <a-popover> 而不是项目内 Popover 包装：
//   - 原生支持 show-arrow / arrow-style（Popover 包装组件简化掉了）
//   - 自动处理 outside-click、ESC 关闭、滚动定位
//   - teleported 到 body，避开详情面板 overflow:hidden 截断

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
        <AttachmentSection :task-id="taskId" :attachments="attachments" />
      </div>
    </template>
  </a-popover>
</template>

<style scoped>
.att-popover {
  /* 浮窗外观：圆角、表面背景、与详情面板 chips 行其它浮层一致 */
  width: 320px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 4px 0;
  scrollbar-width: none;
}

.att-popover::-webkit-scrollbar {
  display: none;
}

body[arco-theme="dark"] .att-popover {
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.3);
}
</style>
