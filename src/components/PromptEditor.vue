<script setup lang="ts">
// 提示词编辑器：复用 RichTextEditor（Tiptap）+ RichTextToolbar + AI 润色
// 编辑时是富文本（所见即所得），工具栏产生真实格式效果。
// 初始化时把 Markdown 转 HTML 喂给编辑器，保存时存 HTML。
import { ref, watch } from "vue";
import { marked } from "marked";
import { polishText } from "@/api/ai";
import AiPolishDialog from "@/components/AiPolishDialog.vue";
import RichTextEditor from "@/components/RichTextEditor.vue";
import RichTextToolbar from "@/components/RichTextToolbar.vue";

const props = defineProps<{
  /** 提示词文本（v-model，Markdown 或 HTML） */
  modelValue: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [v: string];
  /** 失焦/内容变化时通知父组件保存 */
  change: [v: string];
}>();

/** RichTextEditor 实例引用（工具栏需要 editor） */
const richTextEditorRef = ref<InstanceType<typeof RichTextEditor> | null>(null);

/** 编辑器内容（HTML）。初始化时把 Markdown 转成 HTML */
const editorContent = ref("");

/** 是否已初始化（避免初始化时的 watch 回写） */
let initialized = false;

// 初始化：把传入的 Markdown 转 HTML
async function initContent(): Promise<void> {
  if (initialized) return;
  initialized = true;
  // 如果已经是 HTML（含标签）直接用，否则当 Markdown 渲染
  const val = props.modelValue;
  if (val && /<[a-z][\s\S]*>/i.test(val)) {
    editorContent.value = val;
  } else {
    editorContent.value = val ? await marked.parse(val) : "";
  }
}
initContent();

/** 编辑器内容变化：同步到父组件 + 触发保存 */
function onEditorUpdate(v: string): void {
  emit("update:modelValue", v);
  emit("change", v);
}

// 外部 modelValue 变化时（如恢复默认），重新渲染
watch(
  () => props.modelValue,
  async (val) => {
    if (val !== editorContent.value) {
      if (val && /<[a-z][\s\S]*>/i.test(val)) {
        editorContent.value = val;
      } else {
        editorContent.value = val ? await marked.parse(val) : "";
      }
    }
  },
);

// ─── AI 润色 ───
const polishing = ref(false);
const polishVisible = ref(false);
const polishOriginal = ref("");
const polishResult = ref("");
const polishError = ref("");

async function onPolish(): Promise<void> {
  if (polishing.value) return;
  const text = richTextEditorRef.value?.editor?.getHTML() || editorContent.value;
  if (!text.trim()) return;

  polishOriginal.value = text;
  polishResult.value = "";
  polishError.value = "";
  polishing.value = true;
  polishVisible.value = true;

  const res = await polishText(text, (delta) => {
    polishResult.value += delta;
  });
  polishing.value = false;
  if (res.ok && res.content) {
    polishResult.value = res.content;
  } else {
    polishError.value = res.message ?? "润色失败";
  }
}

function onPolishConfirm(editedText: string): void {
  if (!editedText) return;
  editorContent.value = editedText;
  emit("update:modelValue", editedText);
  emit("change", editedText);
  polishVisible.value = false;
}

function onPolishCancel(): void {
  polishVisible.value = false;
}
</script>

<template>
  <div class="prompt-editor">
    <!-- 富文本工具栏 + AI 润色按钮（同一行） -->
    <div v-if="richTextEditorRef" class="prompt-editor__toolbar-wrap">
      <RichTextToolbar :editor="richTextEditorRef.editor" compact />
      <span class="prompt-editor__toolbar-spacer"></span>
      <a-button
        type="text"
        size="mini"
        :loading="polishing"
        :disabled="polishing"
        title="AI 润色"
        class="prompt-editor__polish-btn"
        @click="onPolish"
      >
        <template #icon><icon-robot :size="14" /></template>
        润色
      </a-button>
    </div>

    <!-- 富文本编辑器 -->
    <RichTextEditor
      ref="richTextEditorRef"
      v-model="editorContent"
      borderless
      placeholder="输入提示词内容..."
      :drag-handle="false"
      @update:model-value="onEditorUpdate"
    />

    <!-- AI 润色预览弹窗 -->
    <AiPolishDialog
      :visible="polishVisible"
      :polished-text="polishResult"
      :original-text="polishOriginal"
      :loading="polishing"
      :error="polishError"
      @confirm="onPolishConfirm"
      @cancel="onPolishCancel"
    />
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

.prompt-editor__toolbar-wrap {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface-hover);
  gap: 2px;
}

.prompt-editor__toolbar-spacer {
  flex: 1;
}

.prompt-editor__polish-btn {
  color: var(--jt-primary);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}
.prompt-editor__polish-btn :deep(.arco-btn-content) {
  display: inline-flex;
  align-items: center;
}
.prompt-editor__polish-btn :deep(.arco-icon) {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}
.prompt-editor__polish-btn:hover {
  color: var(--jt-primary);
}
</style>
