<script setup lang="ts">
// AI 文本润色预览弹窗
// 展示润色后的文本（流式逐字出现），用户确认后写回编辑器。
// 下方折叠区可展开查看原文对比。
import { computed, ref, watch } from "vue";
import { marked } from "marked";
import { IconEdit, IconDown, IconRight } from "@arco-design/web-vue/es/icon";

const props = defineProps<{
  /** 弹窗是否可见 */
  visible: boolean;
  /** 润色后的文本（Markdown 或 HTML，流式增长中） */
  polishedText: string;
  /** 原始文本（Markdown 或 HTML） */
  originalText: string;
  /** 是否正在生成（流式加载中） */
  loading: boolean;
  /** 错误信息 */
  error: string;
}>();

const emit = defineEmits<{
  /** 确认替换（传用户编辑后的文本） */
  confirm: [text: string];
  /** 取消 */
  cancel: [];
}>();

/** 原文是否展开 */
const showOriginal = ref(false);
/** 润色结果渲染后的 HTML（loading 中流式展示用） */
const renderedPolished = ref("");
/** 原文渲染后的 HTML */
const renderedOriginal = ref("");
/** 可编辑的润色结果（loading 结束后用户可手动修改，确认时用这个值） */
const editablePolished = ref("");

/** 有结果可确认（loading 结束且有内容） */
const canConfirm = computed(() => !props.loading && editablePolished.value && !props.error);

// polishedText 变化时：loading 中用 marked 渲染展示，结束时初始化可编辑文本
watch(
  () => props.polishedText,
  async (val) => {
    if (props.loading) {
      // 流式中：渲染 HTML 预览
      renderedPolished.value = val ? await marked.parse(val) : "";
    } else {
      // 流式结束：初始化可编辑文本
      editablePolished.value = val;
    }
  },
  { immediate: true },
);

// loading 从 true→false 时，把最终结果初始化到可编辑区
watch(
  () => props.loading,
  async (isLoading, wasLoading) => {
    if (wasLoading && !isLoading && props.polishedText) {
      editablePolished.value = props.polishedText;
    }
  },
);

// 原文展开时渲染
watch([() => props.originalText, showOriginal], async ([val, expanded]) => {
  if (expanded && val) {
    renderedOriginal.value = await marked.parse(val);
  }
});

/** 确认：把用户编辑后的结果传给父组件 */
function onConfirm(): void {
  if (!canConfirm.value) return;
  emit("confirm", editablePolished.value);
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
          <!-- 纯 loading（还没收到内容） -->
          <div v-if="loading && !polishedText" class="ai-polish__loading">
            <a-spin :size="20" />
            <span>AI 正在润色...</span>
          </div>
          <!-- 流式中：渲染 HTML 预览（带转圈角标） -->
          <template v-else-if="loading">
            <div class="ai-polish__streaming-badge">
              <a-spin :size="12" />
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="ai-polish__content" v-html="renderedPolished"></div>
          </template>
          <!-- 流式结束：可编辑 textarea，用户可手动修改 -->
          <textarea
            v-else
            v-model="editablePolished"
            class="ai-polish__textarea"
            spellcheck="false"
          ></textarea>
        </div>

        <!-- 原文对比（折叠） -->
        <div class="ai-polish__original-toggle" @click="showOriginal = !showOriginal">
          <component :is="showOriginal ? IconDown : IconRight" :size="12" />
          <span>查看原文</span>
        </div>
        <div v-if="showOriginal" class="ai-polish__original">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-html="renderedOriginal"></div>
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
  /* 允许选中复制（Arco modal 默认可能禁止） */
  user-select: text;
  -webkit-user-select: text;
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

/* 可编辑 textarea（loading 结束后用户可修改润色结果） */
.ai-polish__textarea {
  width: 100%;
  min-height: 120px;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.7;
  color: var(--jt-text-primary);
  resize: vertical;
  padding: 0;
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
