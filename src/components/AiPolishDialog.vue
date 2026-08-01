<script setup lang="ts">
// AI 文本润色预览弹窗
// 左右对比布局：左原文 / 右润色结果。
// 顶部有「源码/预览」切换（两边同步）+ Markdown 工具栏（源码模式可用，操作右侧编辑区）。
import { computed, ref, watch, nextTick } from "vue";
import { marked } from "marked";
import {
  IconEdit,
  IconEye,
  IconBold,
  IconItalic,
  IconUnderline,
  IconStrikethrough,
  IconCode,
  IconEraser,
  IconQuote,
  IconMinus,
  IconRefresh,
  IconList,
  IconOrderedList,
  IconCheckSquare,
  IconCodeSquare,
} from "@arco-design/web-vue/es/icon";

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

/** 当前模式：edit 源码 | preview 预览（两边同步） */
const mode = ref<"edit" | "preview">("preview");
/** 润色结果渲染后的 HTML（预览模式用） */
const renderedPolished = ref("");
/** 原文渲染后的 HTML（预览模式用） */
const renderedOriginal = ref("");
/** 可编辑的润色结果（源码模式可改，确认时用这个值） */
const editablePolished = ref("");
/** 右侧编辑 textarea 引用（工具栏操作光标用） */
const editTextareaRef = ref<HTMLTextAreaElement | null>(null);

/** 有结果可确认（loading 结束且有内容） */
const canConfirm = computed(() => !props.loading && editablePolished.value && !props.error);

// polishedText 变化时：预览渲染 + 初始化可编辑文本
watch(
  () => props.polishedText,
  async (val) => {
    renderedPolished.value = val ? await marked.parse(val) : "";
    if (!props.loading) {
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

// 原文始终渲染
watch(
  () => props.originalText,
  async (val) => {
    renderedOriginal.value = val ? await marked.parse(val) : "";
  },
  { immediate: true },
);

/** 切换源码/预览模式 */
function toggleMode(): void {
  mode.value = mode.value === "edit" ? "preview" : "edit";
}

// ─── Markdown 工具栏：在右侧 textarea 光标处插入语法 ───

/** 行内格式：包裹选中文本 */
function wrapInline(before: string, after: string, placeholder: string): void {
  const ta = editTextareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = editablePolished.value;
  const selected = text.slice(start, end) || placeholder;
  const newText = text.slice(0, start) + before + selected + after + text.slice(end);
  editablePolished.value = newText;
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start + before.length, start + before.length + selected.length);
  });
}

/** 行首格式：在当前行行首插入前缀 */
function insertLinePrefix(prefix: string): void {
  const ta = editTextareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = editablePolished.value;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const block = text.slice(lineStart, end);
  const newBlock = block.split("\n").map((line) => prefix + line).join("\n");
  editablePolished.value = text.slice(0, lineStart) + newBlock + text.slice(end);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(lineStart, lineStart + newBlock.length);
  });
}

function insertBold(): void {
  wrapInline("**", "**", "加粗文本");
}
function insertItalic(): void {
  wrapInline("*", "*", "斜体文本");
}
function insertUnderline(): void {
  wrapInline("<u>", "</u>", "下划线文本");
}
function insertStrike(): void {
  wrapInline("~~", "~~", "删除线文本");
}
function insertCode(): void {
  wrapInline("`", "`", "代码");
}
function insertHeading(level: number): void {
  insertLinePrefix("#".repeat(level) + " ");
}
function insertBulletList(): void {
  insertLinePrefix("- ");
}
function insertOrderedList(): void {
  insertLinePrefix("1. ");
}
function insertTaskList(): void {
  insertLinePrefix("- [ ] ");
}
function insertQuote(): void {
  insertLinePrefix("> ");
}
function insertHr(): void {
  const ta = editTextareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const text = editablePolished.value;
  const insert = "\n---\n";
  const newText = text.slice(0, start) + insert + text.slice(start);
  editablePolished.value = newText;
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start + insert.length, start + insert.length);
  });
}
function insertHardBreak(): void {
  const ta = editTextareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const text = editablePolished.value;
  const insert = "  \n";
  editablePolished.value = text.slice(0, start) + insert + text.slice(start);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start + insert.length, start + insert.length);
  });
}
function insertCodeBlock(): void {
  wrapInline("\n```\n", "\n```\n", "代码块");
}
/** 清除格式：去掉 Markdown 标记符号 */
function clearFormat(): void {
  const ta = editTextareaRef.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = editablePolished.value;
  const selected = text.slice(start, end);
  if (!selected) return;
  const cleaned = selected
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");
  editablePolished.value = text.slice(0, start) + cleaned + text.slice(end);
  nextTick(() => {
    ta.focus();
    ta.setSelectionRange(start, start + cleaned.length);
  });
}

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
    :width="1000"
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
        <!-- 顶部工具栏：源码/预览切换 -->
        <div class="ai-polish__toolbar">
          <a-button type="text" size="mini" @click="toggleMode">
            <template #icon>
              <icon-eye v-if="mode === 'edit'" :size="14" />
              <icon-edit v-else :size="14" />
            </template>
            {{ mode === "edit" ? "预览" : "编辑" }}
          </a-button>
        </div>

        <!-- Markdown 工具栏（源码模式常态展示，与 PromptEditor 完全一致） -->
        <div v-if="mode === 'edit'" class="ai-polish__md-toolbar">
          <!-- 文本格式组 -->
          <a-button size="mini" shape="circle" type="text" title="加粗" @click="insertBold">
            <icon-bold :size="14" />
          </a-button>
          <a-button size="mini" shape="circle" type="text" title="斜体" @click="insertItalic">
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
          <span class="ai-polish__md-divider"></span>
          <!-- 段落块组 -->
          <a-button size="mini" shape="circle" type="text" title="H1 标题" @click="insertHeading(1)">
            <span class="ai-polish__md-label">H1</span>
          </a-button>
          <a-button size="mini" shape="circle" type="text" title="H2 标题" @click="insertHeading(2)">
            <span class="ai-polish__md-label">H2</span>
          </a-button>
          <a-button size="mini" shape="circle" type="text" title="H3 标题" @click="insertHeading(3)">
            <span class="ai-polish__md-label">H3</span>
          </a-button>
          <a-button size="mini" shape="circle" type="text" title="引用" @click="insertQuote">
            <icon-quote :size="14" />
          </a-button>
          <a-button size="mini" shape="circle" type="text" title="分隔线" @click="insertHr">
            <icon-minus :size="14" />
          </a-button>
          <a-button size="mini" shape="circle" type="text" title="硬换行" @click="insertHardBreak">
            <icon-refresh :size="14" />
          </a-button>
          <span class="ai-polish__md-divider"></span>
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
          <span class="ai-polish__md-divider"></span>
          <!-- 代码块 -->
          <a-button size="mini" shape="circle" type="text" title="代码块" @click="insertCodeBlock">
            <icon-code-square :size="14" />
          </a-button>
        </div>

        <!-- 左右对比布局：左原文 / 右润色结果 -->
        <div class="ai-polish__compare">
          <!-- 左：原文 -->
          <div class="ai-polish__pane">
            <div class="ai-polish__pane-label">原文</div>
            <div class="ai-polish__pane-body">
              <!-- 预览模式：渲染 HTML -->
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-if="mode === 'preview'" class="ai-polish__content" v-html="renderedOriginal"></div>
              <!-- 源码模式：只读 textarea -->
              <textarea
                v-else
                class="ai-polish__textarea ai-polish__textarea--readonly"
                :value="originalText"
                readonly
                spellcheck="false"
              ></textarea>
            </div>
          </div>

          <!-- 右：润色结果（流式 / 可编辑） -->
          <div class="ai-polish__pane">
            <div class="ai-polish__pane-label">
              润色结果
              <a-spin v-if="loading" :size="12" class="ai-polish__pane-spinner" />
            </div>
            <div class="ai-polish__pane-body">
              <!-- 纯 loading（还没收到内容） -->
              <div v-if="loading && !polishedText" class="ai-polish__loading">
                <a-spin :size="20" />
                <span>AI 正在润色...</span>
              </div>
              <!-- 流式中：渲染 HTML 预览（强制预览，不可编辑） -->
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-else-if="loading" class="ai-polish__content" v-html="renderedPolished"></div>
              <!-- 预览模式：渲染 HTML -->
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-else-if="mode === 'preview'" class="ai-polish__content" v-html="renderedPolished"></div>
              <!-- 源码模式：可编辑 textarea -->
              <textarea
                v-else
                ref="editTextareaRef"
                v-model="editablePolished"
                class="ai-polish__textarea"
                spellcheck="false"
              ></textarea>
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

/* 顶部工具栏 */
.ai-polish__toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  margin-bottom: 8px;
}

/* Markdown 工具栏 */
.ai-polish__md-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  margin-bottom: 8px;
  background: var(--jt-surface-hover);
  border-radius: 6px;
  border: 1px solid var(--jt-border);
}
.ai-polish__md-divider {
  width: 1px;
  height: 16px;
  background: var(--jt-border);
  margin: 0 2px;
}
.ai-polish__md-label {
  font-size: 11px;
  font-weight: 600;
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
  /* 固定高度让左右等高，内容多时各自滚动 */
  height: 360px;
  overflow-y: auto;
  padding: 16px;
  background: var(--jt-surface-sunken);
  border-radius: 8px;
  border: 1px solid var(--jt-border);
  /* 允许选中复制 */
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

/* 可编辑 textarea（loading 结束后用户可修改润色结果） */
.ai-polish__textarea {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.7;
  color: var(--jt-text-primary);
  resize: none;
  padding: 0;
}
/* 只读原文 textarea：颜色稍淡 */
.ai-polish__textarea--readonly {
  color: var(--jt-text-secondary);
  cursor: default;
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
