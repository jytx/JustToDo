<script setup lang="ts">
// 提示词编辑器：Markdown 源码 / 预览切换 + Markdown 工具栏
// 用于设置页 AI 提示词编辑。源码模式是 textarea（等宽字体），
// 预览模式用 marked 渲染。项目已有 marked 库，直接复用。
//
// 工具栏点击在 textarea 光标处插入 Markdown 语法（加粗/斜体/标题/列表等），
// 与任务详情面板的富文本工具栏风格一致，但操作的是纯文本（非 Tiptap）。
import { ref, watch, nextTick } from "vue";
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
/** 工具栏是否展开（仅在编辑模式可用） */
const toolbarOpen = ref(false);

/** textarea 元素引用（工具栏插入需要操作光标位置） */
const textareaRef = ref<HTMLTextAreaElement | null>(null);

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

/** 切换工具栏展开/收起 */
function toggleToolbar(): void {
  toolbarOpen.value = !toolbarOpen.value;
}

// ─── Markdown 工具栏：在 textarea 光标处插入语法 ───

/**
 * 行内格式：包裹选中文本（如 **加粗**）。
 * 无选中时插入占位符（如 **文本**）并选中占位文字。
 */
function wrapInline(before: string, after: string, placeholder: string): void {
  const ta = textareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = props.modelValue;
  const selected = text.slice(start, end) || placeholder;
  const newText = text.slice(0, start) + before + selected + after + text.slice(end);
  emit("update:modelValue", newText);
  // 选中插入的内容（方便继续输入替换）
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start + before.length, start + before.length + selected.length);
  });
}

/**
 * 行首格式：在当前行行首插入前缀（如 ## 、- ）。
 * 若有选区，对选区内的每一行都加前缀（多行列表）。
 */
function insertLinePrefix(prefix: string): void {
  const ta = textareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = props.modelValue;
  // 找到选区起始行的行首
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  // 对 lineStart 到 end 之间的每一行加前缀
  const block = text.slice(lineStart, end);
  const newBlock = block.split("\n").map((line) => prefix + line).join("\n");
  const newText = text.slice(0, lineStart) + newBlock + text.slice(end);
  emit("update:modelValue", newText);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(lineStart, lineStart + newBlock.length);
  });
}

/** 加粗 */
function insertBold(): void {
  wrapInline("**", "**", "加粗文本");
}
/** 斜体 */
function insertItalic(): void {
  wrapInline("*", "*", "斜体文本");
}
/** 行内代码 */
function insertCode(): void {
  wrapInline("`", "`", "代码");
}
/** H1/H2/H3 标题 */
function insertHeading(level: number): void {
  insertLinePrefix("#".repeat(level) + " ");
}
/** 无序列表 */
function insertBulletList(): void {
  insertLinePrefix("- ");
}
/** 有序列表 */
function insertOrderedList(): void {
  insertLinePrefix("1. ");
}
/** 引用 */
function insertQuote(): void {
  insertLinePrefix("> ");
}
/** 代码块 */
function insertCodeBlock(): void {
  const ta = textareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const text = props.modelValue;
  const block = "\n```\n代码\n```\n";
  const newText = text.slice(0, start) + block + text.slice(start);
  emit("update:modelValue", newText);
  nextTick(() => {
    ta.focus();
    const codeStart = start + 5; // \n```\n 后
    ta.setSelectionRange(codeStart, codeStart + 2); // 选中"代码"
  });
}
</script>

<template>
  <div class="prompt-editor">
    <!-- 顶部工具栏：模式切换 + 富文本工具栏开关 -->
    <div class="prompt-editor__toolbar">
      <a-button type="text" size="mini" @click="toggleToolbar" :disabled="mode !== 'edit'" title="Markdown 工具栏">
        <template #icon><icon-edit :size="14" /></template>
        工具
      </a-button>
      <a-button type="text" size="mini" @click="toggleMode">
        <template #icon>
          <icon-eye v-if="mode === 'edit'" :size="14" />
          <icon-edit v-else :size="14" />
        </template>
        {{ mode === "edit" ? "预览" : "编辑" }}
      </a-button>
    </div>

    <!-- Markdown 工具栏（仅编辑模式 + 展开时显示） -->
    <div v-if="toolbarOpen && mode === 'edit'" class="prompt-editor__md-toolbar">
      <a-button size="mini" shape="circle" type="text" title="加粗" @click="insertBold">
        <icon-bold :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="斜体" @click="insertItalic">
        <icon-italic :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="行内代码" @click="insertCode">
        <icon-code :size="14" />
      </a-button>
      <span class="prompt-editor__md-divider"></span>
      <a-button size="mini" shape="circle" type="text" title="H1 标题" @click="insertHeading(1)">
        <span class="prompt-editor__md-label">H1</span>
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="H2 标题" @click="insertHeading(2)">
        <span class="prompt-editor__md-label">H2</span>
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="H3 标题" @click="insertHeading(3)">
        <span class="prompt-editor__md-label">H3</span>
      </a-button>
      <span class="prompt-editor__md-divider"></span>
      <a-button size="mini" shape="circle" type="text" title="无序列表" @click="insertBulletList">
        <icon-list :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="有序列表" @click="insertOrderedList">
        <icon-ordered-list :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="引用" @click="insertQuote">
        <icon-quote :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="代码块" @click="insertCodeBlock">
        <icon-code-square :size="14" />
      </a-button>
    </div>

    <!-- 源码模式：textarea（等宽字体） -->
    <textarea
      v-if="mode === 'edit'"
      ref="textareaRef"
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
  gap: 2px;
  padding: 2px 4px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface-hover);
}

/* Markdown 工具栏：与任务详情富文本工具栏风格一致 */
.prompt-editor__md-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding: 4px 8px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface);
}

.prompt-editor__md-divider {
  width: 1px;
  height: 14px;
  background-color: var(--jt-border);
  margin: 0 4px;
}

.prompt-editor__md-label {
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono);
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
