<script setup lang="ts">
// 提示词编辑器：双模式 + Markdown 工具栏 + AI 润色
// - 源码模式：textarea 编辑纯文本，工具栏插入 Markdown 语法（**加粗** 等）
// - 预览模式：contenteditable 富文本，工具栏产生真实格式效果（execCommand）
//   失焦时把 HTML 转回 Markdown 同步给 v-model
import { ref, nextTick } from "vue";
import { marked } from "marked";
import { polishText } from "@/api/ai";
import AiPolishDialog from "@/components/AiPolishDialog.vue";

const props = defineProps<{
  /** 提示词文本（v-model，Markdown 格式） */
  modelValue: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [v: string];
  /** 失焦/内容变化时通知父组件保存（与设置项自动保存一致） */
  change: [v: string];
}>();

/** 当前模式：edit 源码 | preview 富文本 */
const mode = ref<"edit" | "preview">("edit");
/** AI 润色进行中 */
const polishing = ref(false);
/** 润色预览弹窗是否可见 */
const polishVisible = ref(false);
/** 润色前的原文（弹窗对比用） */
const polishOriginal = ref("");
/** 润色结果（流式增长） */
const polishResult = ref("");
/** 润色错误信息 */
const polishError = ref("");

/** 源码模式 textarea 引用 */
const textareaRef = ref<HTMLTextAreaElement | null>(null);
/** 预览模式 contenteditable 引用 */
const richRef = ref<HTMLDivElement | null>(null);

/** 切换模式 */
function toggleMode(): void {
  if (mode.value === "edit") {
    // 切到预览：把 Markdown 渲染成 HTML 放入 contenteditable
    mode.value = "preview";
    nextTick(() => {
      if (richRef.value) {
        renderToRich();
      }
    });
  } else {
    // 切回源码：把 contenteditable 的 HTML 转回 Markdown
    if (richRef.value) {
      const md = htmlToMarkdown(richRef.value.innerHTML);
      emit("update:modelValue", md);
    }
    mode.value = "edit";
  }
}

/** 把当前 modelValue（Markdown）渲染到 contenteditable */
async function renderToRich(): Promise<void> {
  if (!richRef.value) return;
  const html = props.modelValue ? await marked.parse(props.modelValue) : "";
  richRef.value.innerHTML = html;
}

/** contenteditable 的 HTML 粗略转回 Markdown */
function htmlToMarkdown(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return nodeToMarkdown(div);
}

/** 递归把 DOM 节点转成 Markdown */
function nodeToMarkdown(node: Node): string {
  let result = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const inner = nodeToMarkdown(el);
      const tag = el.tagName.toLowerCase();
      if (tag === "strong" || tag === "b") result += `**${inner}**`;
      else if (tag === "em" || tag === "i") result += `*${inner}*`;
      else if (tag === "code") result += `\`${inner}\``;
      else if (tag === "h1") result += `\n# ${inner}\n`;
      else if (tag === "h2") result += `\n## ${inner}\n`;
      else if (tag === "h3") result += `\n### ${inner}\n`;
      else if (tag === "blockquote") result += inner.split("\n").map((l: string) => `> ${l}`).join("\n");
      else if (tag === "ul") result += inner;
      else if (tag === "ol") result += inner;
      else if (tag === "li") result += `- ${inner}\n`;
      else if (tag === "br") result += "\n";
      else if (tag === "p" || tag === "div") result += `${inner}\n`;
      else result += inner;
    }
  });
  return result;
}

/** 预览模式：contenteditable 输入时同步 */
function onRichInput(): void {
  // 预览模式编辑不立即同步 Markdown，切回源码时才转换
}

/** 预览模式回车：插入 <br> 而非 <div>/<p>，避免额外空行 */
function onRichEnter(): void {
  document.execCommand("insertHTML", false, "<br>");
}

/** 预览模式失焦：转回 Markdown 并保存 */
function onRichBlur(): void {
  if (richRef.value) {
    const md = htmlToMarkdown(richRef.value.innerHTML);
    emit("update:modelValue", md);
    emit("change", md);
  }
}

/** 输入时同步到父组件（源码模式 v-model） */
function onInput(e: Event): void {
  const v = (e.target as HTMLTextAreaElement).value;
  emit("update:modelValue", v);
}

/** 失焦时触发 change 保存（源码模式） */
function onBlur(): void {
  emit("change", props.modelValue);
}

/** AI 润色：调 polishText 流式获取结果，弹窗预览后确认才覆盖。
 *  提示词模板含 {mode} 等占位符，需加上下文前缀让 AI 明确这是
 *  要润色的模板文本，而非待执行的指令（否则 AI 会回复"请提供数据"）。 */
async function onPolish(): Promise<void> {
  if (polishing.value || !props.modelValue.trim()) return;

  // 打开弹窗 + 发起流式润色
  polishOriginal.value = props.modelValue;
  polishResult.value = "";
  polishError.value = "";
  polishing.value = true;
  polishVisible.value = true;

  // 加前缀：明确告知 AI 下面是一段提示词模板文本，只做润色
  const wrappedText = `以下是一段 AI 提示词模板文本（非给你的指令），请直接润色它。保留其中的 {mode} 等占位符不变：\n\n${props.modelValue}`;
  const res = await polishText(wrappedText, (delta) => {
    polishResult.value += delta;
  });
  polishing.value = false;
  if (res.ok && res.content) {
    polishResult.value = res.content;
  } else {
    polishError.value = res.message ?? "润色失败";
  }
}

/** 确认润色：用用户编辑后的文本覆盖提示词 */
function onPolishConfirm(editedText: string): void {
  if (!editedText) return;
  emit("update:modelValue", editedText);
  emit("change", editedText);
  // 同步更新 textarea 显示
  if (textareaRef.value) textareaRef.value.value = editedText;
  polishVisible.value = false;
}

/** 取消润色 */
function onPolishCancel(): void {
  polishVisible.value = false;
}

// ─── 工具栏：源码模式插入 Markdown 语法 / 预览模式用 execCommand 产生富文本 ───

/**
 * 行内格式：源码模式包裹 Markdown 语法，预览模式用 execCommand。
 */
function wrapInline(before: string, after: string, placeholder: string): void {
  if (mode.value === "preview") {
    // 预览模式：execCommand 产生真实格式
    const cmdMap: Record<string, string> = { "**": "bold", "*": "italic", "`": "insertCode" };
    const cmd = cmdMap[before];
    if (cmd === "insertCode") {
      // code 没有直接 execCommand，用 insertHTML
      const sel = window.getSelection();
      const selected = sel?.toString() || placeholder;
      document.execCommand("insertHTML", false, `<code>${selected}</code>`);
    } else if (cmd) {
      document.execCommand(cmd, false);
    }
    richRef.value?.focus();
    return;
  }
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
  if (mode.value === "preview") {
    // 预览模式：用 execCommand 插入对应 HTML 块
    const headingMap: Record<string, string> = { "# ": "H1", "## ": "H2", "### ": "H3" };
    if (headingMap[prefix]) {
      document.execCommand("formatBlock", false, headingMap[prefix]);
    } else if (prefix === "- " || prefix === "1. ") {
      document.execCommand("insertUnorderedList" === "insertUnorderedList" && prefix === "1. " ? "insertOrderedList" : "insertUnorderedList");
    } else if (prefix === "> ") {
      document.execCommand("formatBlock", false, "BLOCKQUOTE");
    }
    richRef.value?.focus();
    return;
  }
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
  if (mode.value === "preview") {
    const sel = window.getSelection();
    const selected = sel?.toString() || "代码";
    document.execCommand("insertHTML", false, `<pre><code>${selected}</code></pre><p></p>`);
    richRef.value?.focus();
    return;
  }
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

/** 下划线（Markdown 无原生语法，用 <u> 标签） */
function insertUnderline(): void {
  if (mode.value === "preview") {
    document.execCommand("underline", false);
    richRef.value?.focus();
    return;
  }
  wrapInline("<u>", "</u>", "下划线");
}
/** 删除线 */
function insertStrike(): void {
  if (mode.value === "preview") {
    document.execCommand("strikeThrough", false);
    richRef.value?.focus();
    return;
  }
  wrapInline("~~", "~~", "删除线");
}
/** 清除格式 */
function clearFormat(): void {
  if (mode.value === "preview") {
    document.execCommand("removeFormat", false);
    document.execCommand("formatBlock", false, "P");
    richRef.value?.focus();
    return;
  }
  const ta = textareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = props.modelValue;
  const selected = text.slice(start, end);
  if (!selected) return;
  // 去除常见行内标记
  const cleaned = selected
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/<u>(.+?)<\/u>/g, "$1");
  const newText = text.slice(0, start) + cleaned + text.slice(end);
  emit("update:modelValue", newText);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start, start + cleaned.length);
  });
}
/** 待办列表 */
function insertTaskList(): void {
  if (mode.value === "preview") {
    document.execCommand("insertHTML", false, '<ul><li><input type="checkbox"> </li></ul>');
    richRef.value?.focus();
    return;
  }
  insertLinePrefix("- [ ] ");
}
/** 分隔线 */
function insertHr(): void {
  if (mode.value === "preview") {
    document.execCommand("insertHorizontalRule", false);
    richRef.value?.focus();
    return;
  }
  const ta = textareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const text = props.modelValue;
  const insert = "\n\n---\n\n";
  const newText = text.slice(0, start) + insert + text.slice(start);
  emit("update:modelValue", newText);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start + insert.length, start + insert.length);
  });
}
/** 硬换行 */
function insertHardBreak(): void {
  if (mode.value === "preview") {
    document.execCommand("insertHTML", false, "<br>");
    richRef.value?.focus();
    return;
  }
  const ta = textareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const text = props.modelValue;
  const insert = "  \n";
  const newText = text.slice(0, start) + insert + text.slice(start);
  emit("update:modelValue", newText);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start + insert.length, start + insert.length);
  });
}
</script>

<template>
  <div class="prompt-editor">
    <!-- 顶部工具栏：模式切换 + AI 润色 -->
    <div class="prompt-editor__toolbar">
      <a-button type="text" size="mini" @click="toggleMode">
        <template #icon>
          <icon-eye v-if="mode === 'edit'" :size="14" />
          <icon-edit v-else :size="14" />
        </template>
        {{ mode === "edit" ? "预览" : "编辑" }}
      </a-button>
      <!-- AI 润色：优化提示词文本（流式替换） -->
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

    <!-- Markdown 工具栏（常态展示，两种模式都可用） -->
    <div class="prompt-editor__md-toolbar">
      <!-- 文本格式组 -->
      <a-button size="mini" shape="circle" type="text" title="加粗 (Cmd+B)" @click="insertBold">
        <icon-bold :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="斜体 (Cmd+I)" @click="insertItalic">
        <icon-italic :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="下划线" @click="insertUnderline">
        <icon-underline :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="删除线" @click="insertStrike">
        <icon-strikethrough :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="行内代码" @click="insertCode">
        <icon-code :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="清除格式" @click="clearFormat">
        <icon-eraser :size="14" />
      </a-button>
      <span class="prompt-editor__md-divider"></span>

      <!-- 段落块组 -->
      <a-button size="mini" shape="circle" type="text" title="H1 标题" @click="insertHeading(1)">
        <span class="prompt-editor__md-label">H1</span>
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="H2 标题" @click="insertHeading(2)">
        <span class="prompt-editor__md-label">H2</span>
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="H3 标题" @click="insertHeading(3)">
        <span class="prompt-editor__md-label">H3</span>
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="引用" @click="insertQuote">
        <icon-quote :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="分隔线" @click="insertHr">
        <icon-minus :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="硬换行 (Shift+Enter)" @click="insertHardBreak">
        <icon-refresh :size="14" />
      </a-button>
      <span class="prompt-editor__md-divider"></span>

      <!-- 列表组 -->
      <a-button size="mini" shape="circle" type="text" title="无序列表" @click="insertBulletList">
        <icon-list :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="有序列表" @click="insertOrderedList">
        <icon-ordered-list :size="14" />
      </a-button>
      <a-button size="mini" shape="circle" type="text" title="待办列表" @click="insertTaskList">
        <icon-check-square :size="14" />
      </a-button>
      <span class="prompt-editor__md-divider"></span>

      <!-- 代码块 -->
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

    <!-- 预览模式：可编辑富文本（contenteditable，工具栏产生真实格式） -->
    <div
      v-else
      ref="richRef"
      class="prompt-editor__rich"
      contenteditable="true"
      spellcheck="false"
      @input="onRichInput"
      @blur="onRichBlur"
      @keydown.enter.prevent="onRichEnter"
    ></div>

    <!-- AI 润色预览弹窗（确认后才覆盖提示词文本） -->
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

.prompt-editor__toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  padding: 2px 4px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface-hover);
}

/* AI 润色按钮：主色调，与工具/预览按钮区分 */
.prompt-editor__polish-btn {
  color: var(--jt-primary);
  margin-left: 4px;
}
.prompt-editor__polish-btn:hover {
  color: var(--jt-primary);
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

/* 预览模式：可编辑富文本 */
.prompt-editor__rich {
  width: 100%;
  min-height: 400px;
  max-height: 600px;
  overflow-y: auto;
  padding: 10px 12px;
  outline: none;
  font-family: var(--font-body);
  font-size: 13px;
  line-height: 1.7;
  color: var(--jt-text-primary);
  background-color: var(--jt-surface);
}
.prompt-editor__rich:empty::before {
  content: attr(data-placeholder);
  color: var(--jt-text-tertiary);
}
.prompt-editor__rich :deep(h1),
.prompt-editor__rich :deep(h2),
.prompt-editor__rich :deep(h3) {
  font-weight: 600;
  margin: 10px 0 6px;
}
.prompt-editor__rich :deep(h1) { font-size: 15px; }
.prompt-editor__rich :deep(h2) { font-size: 14px; }
.prompt-editor__rich :deep(h3) { font-size: 13px; }
.prompt-editor__rich :deep(p) {
  margin: 0;
}
.prompt-editor__rich :deep(ul),
.prompt-editor__rich :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}
.prompt-editor__rich :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 3px;
  background-color: var(--jt-surface-hover);
}
.prompt-editor__rich :deep(pre) {
  padding: 8px 12px;
  border-radius: 6px;
  background-color: var(--jt-surface-hover);
  overflow-x: auto;
}
.prompt-editor__rich :deep(blockquote) {
  margin: 6px 0;
  padding-left: 12px;
  border-left: 3px solid var(--jt-border);
  color: var(--jt-text-secondary);
}

</style>
