<script setup lang="ts">
// AI 文本润色预览弹窗
// 左右对比布局：左原文（只读渲染）/ 右润色结果（RichTextEditor 可编辑）。
import { computed, ref, watch } from "vue";
import { marked } from "marked";
import { IconEdit } from "@arco-design/web-vue/es/icon";
import RichTextEditor from "@/components/RichTextEditor.vue";
import RichTextToolbar from "@/components/RichTextToolbar.vue";

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
  /** 确认替换（传用户编辑后的 HTML） */
  confirm: [text: string];
  /** 取消 */
  cancel: [];
}>();

/** 原文渲染后的 HTML（左侧只读展示） */
const renderedOriginal = ref("");
/** 可编辑的润色结果（HTML，loading 结束后用户可修改） */
const editablePolished = ref("");
/** RichTextEditor 实例引用 */
const richTextEditorRef = ref<InstanceType<typeof RichTextEditor> | null>(null);

/** 有结果可确认（loading 结束且有内容） */
const canConfirm = computed(() => !props.loading && editablePolished.value && !props.error);

// polishedText 变化时：loading 中渲染预览，结束时初始化可编辑区
watch(
  () => props.polishedText,
  (val) => {
    if (!props.loading) {
      editablePolished.value = val;
    }
  },
);

// loading 从 true→false 时，把最终结果初始化到可编辑区
watch(
  () => props.loading,
  (isLoading, wasLoading) => {
    if (wasLoading && !isLoading && props.polishedText) {
      editablePolished.value = props.polishedText;
    }
  },
);

// 原文始终渲染
watch(
  () => props.originalText,
  async (val) => {
    renderedOriginal.value = val ? await marked.parse(val) : "";
  },
  { immediate: true },
);

/** 确认：把用户编辑后的 HTML 传给父组件 */
function onConfirm(): void {
  if (!canConfirm.value) return;
  const html = richTextEditorRef.value?.editor?.getHTML() || editablePolished.value;
  emit("confirm", html);
}

/** 取消 */
function onCancel(): void {
  emit("cancel");
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="1200"
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
        <!-- 左右对比布局：左原文 / 右润色结果 -->
        <div class="ai-polish__compare">
          <!-- 左：原文（只读渲染） -->
          <div class="ai-polish__pane">
            <div class="ai-polish__pane-label">原文</div>
            <div class="ai-polish__pane-body">
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="ai-polish__content" v-html="renderedOriginal"></div>
            </div>
          </div>

          <!-- 右：润色结果 -->
          <div class="ai-polish__pane">
            <div class="ai-polish__pane-label">
              润色结果
              <a-spin v-if="loading" :size="12" class="ai-polish__pane-spinner" />
            </div>
            <div class="ai-polish__pane-body">
              <!-- loading 中：渲染 HTML 预览 -->
              <div v-if="loading && !polishedText" class="ai-polish__loading">
                <a-spin :size="20" />
                <span>AI 正在润色...</span>
              </div>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-else-if="loading" class="ai-polish__content" v-html="polishedText"></div>
              <!-- loading 结束：RichTextEditor 可编辑 -->
              <div v-else class="ai-polish__editor-wrap">
                <div v-if="richTextEditorRef" class="ai-polish__toolbar">
                  <RichTextToolbar :editor="richTextEditorRef.editor" compact />
                </div>
                <RichTextEditor
                  ref="richTextEditorRef"
                  v-model="editablePolished"
                  borderless
                  placeholder="润色结果..."
                  :drag-handle="false"
                />
              </div>
            </div>
          </div>
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

/* 左右对比布局 */
.ai-polish__compare {
  display: flex;
  gap: 12px;
}

.ai-polish__pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ai-polish__pane-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--jt-text-tertiary);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-polish__pane-spinner {
  opacity: 0.5;
}

.ai-polish__pane-body {
  height: 360px;
  overflow-y: auto;
  padding: 16px;
  background: var(--jt-surface-sunken);
  border-radius: 8px;
  border: 1px solid var(--jt-border);
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

/* 右侧可编辑区：工具栏 + RichTextEditor */
.ai-polish__editor-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin: -16px;
}
.ai-polish__toolbar {
  padding: 4px 8px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface);
  flex-shrink: 0;
}
.ai-polish__editor-wrap :deep(.rich-text-editor) {
  flex: 1;
  overflow-y: auto;
}

/* 底部操作 */
.ai-polish__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
</style>
