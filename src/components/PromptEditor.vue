<script setup lang="ts">
// 提示词编辑器：Markdown 源码 / 预览切换
// 用于设置页 AI 提示词编辑。源码模式是 textarea（等宽字体），
// 预览模式用 marked 渲染。项目已有 marked 库，直接复用。
import { ref, watch } from "vue";
import { marked } from "marked";

const props = defineProps<{
  /** 提示词文本（v-model） */
  modelValue: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [v: string];
  /** 失焦/内容变化时通知父组件保存（与设置项自动保存一致） */
  change: [v: string];
}>();

/** 当前模式：edit 源码 | preview 预览 */
const mode = ref<"edit" | "preview">("edit");
/** 预览渲染的 HTML（marked v18 parse 异步，用 watch 渲染） */
const previewHtml = ref("");

// 预览模式时实时渲染（切到预览或内容变化时）
watch(
  () => [mode.value, props.modelValue] as const,
  async ([m, val]) => {
    if (m === "preview") {
      previewHtml.value = val ? await marked.parse(val) : "";
    }
  },
  { immediate: true },
);

/** 输入时同步到父组件（v-model） */
function onInput(e: Event): void {
  const v = (e.target as HTMLTextAreaElement).value;
  emit("update:modelValue", v);
}

/** 失焦时触发 change 保存（与设置项自动保存一致） */
function onBlur(): void {
  emit("change", props.modelValue);
}

/** 切换模式 */
function toggleMode(): void {
  mode.value = mode.value === "edit" ? "preview" : "edit";
}
</script>

<template>
  <div class="prompt-editor">
    <!-- 顶部工具栏：模式切换 -->
    <div class="prompt-editor__toolbar">
      <a-button type="text" size="mini" @click="toggleMode">
        <template #icon>
          <icon-eye v-if="mode === 'edit'" :size="14" />
          <icon-edit v-else :size="14" />
        </template>
        {{ mode === "edit" ? "预览" : "编辑" }}
      </a-button>
    </div>

    <!-- 源码模式：textarea（等宽字体） -->
    <textarea
      v-if="mode === 'edit'"
      class="prompt-editor__textarea"
      :value="modelValue"
      @input="onInput"
      @blur="onBlur"
      spellcheck="false"
    ></textarea>

    <!-- 预览模式：Markdown 渲染 -->
    <div v-else class="prompt-editor__preview" v-html="previewHtml"></div>
  </div>
</template>

<style scoped>
.prompt-editor {
  width: 100%;
  margin-top: 4px;
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  overflow: hidden;
}

.prompt-editor__toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 2px 4px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface-hover);
}

/* 源码 textarea：等宽字体，自动高度 */
.prompt-editor__textarea {
  width: 100%;
  min-height: 400px;
  max-height: 600px;
  padding: 10px 12px;
  border: none;
  outline: none;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--jt-text-primary);
  background-color: var(--jt-surface);
}

/* 预览区：复用 Markdown 渲染样式 */
.prompt-editor__preview {
  min-height: 400px;
  max-height: 600px;
  overflow-y: auto;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--jt-text-primary);
}

.prompt-editor__preview :deep(h1),
.prompt-editor__preview :deep(h2),
.prompt-editor__preview :deep(h3) {
  font-weight: 600;
  margin: 10px 0 6px;
}

.prompt-editor__preview :deep(h1) { font-size: 15px; }
.prompt-editor__preview :deep(h2) { font-size: 14px; }
.prompt-editor__preview :deep(h3) { font-size: 13px; }

.prompt-editor__preview :deep(p) {
  margin: 6px 0;
}

.prompt-editor__preview :deep(ul),
.prompt-editor__preview :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}

.prompt-editor__preview :deep(li) {
  margin: 2px 0;
}

.prompt-editor__preview :deep(strong) {
  font-weight: 600;
}

.prompt-editor__preview :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 3px;
  background-color: var(--jt-surface-hover);
}
</style>
