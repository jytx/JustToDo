<script setup lang="ts">
// 统一确认弹窗 —— 危险操作（删除等）的极简卡片风弹窗
//
// 封装 <a-modal> + 全局 .confirm-dialog 样式（定义在 styles/confirm-dialog.css），
// 消除 6 处重复的 DOM 模板。视觉与原"删除任务"弹窗完全一致：
//   无标题栏 · 圆角 12px · 顶部红底警告图标 + 主文案 · 副提示 · 底部右对齐按钮
//
// 用法：
//   <ConfirmDialog
//     v-model:visible="open"
//     :confirm-text="删除"
//     @confirm="onDelete"
//   >
//     <template #title>删除任务「<strong>{{ name }}</strong>」？</template>
//     此操作无法撤销。
//   </ConfirmDialog>
import { IconExclamationCircle } from "@arco-design/web-vue/es/icon";

interface Props {
  /** 是否显示（v-model:visible） */
  visible: boolean;
  /** 副提示文字（也可用默认 slot 传入更复杂内容） */
  desc?: string;
  /** 确认按钮文字（默认"删除"） */
  confirmText?: string;
  /** 取消按钮文字（默认"取消"） */
  cancelText?: string;
  /** 是否危险操作（true=红色确认按钮；默认 true） */
  danger?: boolean;
  /** 确认按钮 loading（异步删除时防止重复点击） */
  loading?: boolean;
  /** 点击遮罩/ESC 是否关闭（默认 true；危险操作可设 false 强制走按钮） */
  maskClosable?: boolean;
}

withDefaults(defineProps<Props>(), {
  desc: "",
  confirmText: "删除",
  cancelText: "取消",
  danger: true,
  loading: false,
  maskClosable: true,
});

const emit = defineEmits<{
  "update:visible": [value: boolean];
  /** 点击确认按钮 */
  confirm: [];
  /** 点击取消 / 遮罩 / ESC */
  cancel: [];
}>();

function close() {
  emit("update:visible", false);
}
function onCancel() {
  emit("cancel");
  close();
}
function onConfirm() {
  emit("confirm");
  // 不自动关闭：交由调用方在异步操作完成后通过 v-model:visible 关闭
  // （避免删除失败时弹窗提前消失，错误信息无处依附）
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="400"
    :footer="false"
    :mask-closable="maskClosable"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="confirm-dialog-modal"
    :modal-style="{ maxWidth: 'calc(100vw - 32px)' }"
    @cancel="onCancel"
  >
    <div class="confirm-dialog">
      <div class="confirm-dialog__title">
        <span class="confirm-dialog__icon"><icon-exclamation-circle :size="16" /></span>
        <slot name="title">确认操作？</slot>
      </div>
      <p class="confirm-dialog__desc">
        <slot>{{ desc }}</slot>
      </p>
      <div class="confirm-dialog__footer">
        <a-button :disabled="loading" @click="onCancel">{{ cancelText }}</a-button>
        <a-button
          :status="danger ? 'danger' : undefined"
          type="primary"
          :loading="loading"
          @click="onConfirm"
        >
          {{ confirmText }}
        </a-button>
      </div>
    </div>
  </a-modal>
</template>
