<script setup lang="ts">
// AI 文本润色预览弹窗
// 展示润色后的文本（流式逐字出现），用户确认后写回编辑器。
// 下方折叠区可展开查看原文对比。
import { computed } from "vue";
import { IconEdit, IconDown, IconRight } from "@arco-design/web-vue/es/icon";
import { ref } from "vue";

const props = defineProps<{
  /** 弹窗是否可见 */
  visible: boolean;
  /** 润色后的文本（HTML，流式增长中） */
  polishedText: string;
  /** 原始文本（HTML） */
  originalText: string;
  /** 是否正在生成（流式加载中） */
  loading: boolean;
  /** 错误信息 */
  error: string;
}>();

const emit = defineEmits<{
  /** 确认替换 */
  confirm: [];
  /** 取消 */
  cancel: [];
}>();

/** 原文是否展开 */
const showOriginal = ref(false);

/** 有结果可确认（loading 结束且有内容） */
const canConfirm = computed(() => !props.loading && props.polishedText && !props.error);

/** 确认 */
function onConfirm(): void {
  if (!canConfirm.value) return;
  emit("confirm");
}

/** 取消 */
function onCancel(): void {
  emit("cancel");
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="640"
    :footer="false"
    :mask-closable="!loading"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="ai-polish-modal"
    wrap-class="ai-polish-wrap"
    @update:visible="(v: boolean) => { if (!v && !loading) onCancel(); }"
  >
    <template #title>
      <span class="ai-polish__title">
        <icon-edit :size="16" />
        AI 文本润色
      </span>
    </template>

    <div class="ai-polish">
      <!-- 错误 -->
      <div v-if="error" class="ai-polish__error">
        <p>{{ error }}</p>
        <a-button type="outline" size="small" @click="onCancel">关闭</a-button>
      </div>

      <template v-else>
        <!-- 润色结果（流式逐字显示） -->
        <div class="ai-polish__result">
          <div v-if="loading && !polishedText" class="ai-polish__loading">
            <a-spin :size="20" />
            <span>AI 正在润色...</span>
          </div>
          <template v-else>
            <div v-if="loading" class="ai-polish__streaming-badge">
              <a-spin :size="12" />
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="ai-polish__content" v-html="polishedText"></div>
          </template>
        </div>

        <!-- 原文对比（折叠） -->
        <div class="ai-polish__original-toggle" @click="showOriginal = !showOriginal">
          <component :is="showOriginal ? IconDown : IconRight" :size="12" />
          <span>查看原文</span>
        </div>
        <div v-if="showOriginal" class="ai-polish__original">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-html="originalText"></div>
        </div>

        <!-- 底部操作 -->
        <div class="ai-polish__footer">
          <a-button size="small" :disabled="loading" @click="onCancel">取消</a-button>
          <a-button
            type="primary"
            size="small"
            :disabled="!canConfirm"
            :loading="loading"
            @click="onConfirm"
          >
            替换原文
          </a-button>
        </div>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.ai-polish__title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--jt-primary);
  font-size: 15px;
}

.ai-polish {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 错误 */
.ai-polish__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 0;
  color: var(--jt-error);
}

/* 润色结果区 */
.ai-polish__result {
  position: relative;
  min-height: 120px;
  max-height: 400px;
  overflow-y: auto;
  padding: 16px;
  background: var(--jt-surface-sunken);
  border-radius: 8px;
  border: 1px solid var(--jt-border);
}

.ai-polish__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--jt-text-secondary);
  font-size: 13px;
  min-height: 80px;
}

.ai-polish__streaming-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0.5;
}

.ai-polish__content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--jt-text-primary);
}
.ai-polish__content :deep(p) {
  margin: 0 0 8px;
}
.ai-polish__content :deep(p:last-child) {
  margin-bottom: 0;
}
.ai-polish__content :deep(h1),
.ai-polish__content :deep(h2),
.ai-polish__content :deep(h3) {
  font-size: 16px;
  font-weight: 600;
  margin: 12px 0 8px;
}
.ai-polish__content :deep(ul),
.ai-polish__content :deep(ol) {
  padding-left: 20px;
  margin: 0 0 8px;
}
.ai-polish__content :deep(strong) {
  font-weight: 600;
}

/* 原文折叠 */
.ai-polish__original-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  user-select: none;
}
.ai-polish__original-toggle:hover {
  color: var(--jt-text-secondary);
}

.ai-polish__original {
  max-height: 200px;
  overflow-y: auto;
  padding: 12px 16px;
  background: var(--jt-surface);
  border-radius: 8px;
  border: 1px solid var(--jt-border);
  font-size: 13px;
  line-height: 1.6;
  color: var(--jt-text-tertiary);
}
.ai-polish__original :deep(p) {
  margin: 0 0 6px;
}
.ai-polish__original :deep(p:last-child) {
  margin-bottom: 0;
}

/* 底部操作 */
.ai-polish__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
</style>
