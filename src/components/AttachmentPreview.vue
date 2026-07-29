<script setup lang="ts">
// 附件预览弹窗 —— 根据附件类型分流渲染
// markdown/text：应用内渲染（marked + DOMPurify）
// 图片：直接 <img>（webview 原生支持缩放）
// 视频：<video controls>
// 音频：<audio controls>
// PDF：<iframe>（webview 原生 PDF 渲染）
import { ref, computed, watch, onMounted } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { categorizeAttachment, type Attachment } from "@/types";
import { getAttachmentFullpath, readAttachmentText, revealAttachment } from "@/api/db";

const props = defineProps<{ attachment: Attachment }>();
const emit = defineEmits<{ (e: "close"): void }>();

const category = computed(() => categorizeAttachment(props.attachment.originalName));

// asset:// URL（图片/视频/音频/pdf 用）
const assetUrl = ref("");

// 文本内容（markdown/text 用）
const textContent = ref("");
const loading = ref(false);
const errorMsg = ref("");

// markdown 预览模式（渲染 / 源码）
type ViewMode = "rendered" | "source";
const viewMode = ref<ViewMode>("rendered");

// 渲染后的 markdown HTML（XSS 过滤）
const renderedHtml = ref("");

// 按 ESC 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  loadContent();
});

watch(
  () => props.attachment.id,
  () => loadContent(),
);

async function loadContent() {
  loading.value = true;
  errorMsg.value = "";
  try {
    // 非文本类：拿 asset url
    if (category.value !== "markdown" && category.value !== "text") {
      const full = await getAttachmentFullpath(props.attachment.storedName);
      assetUrl.value = convertFileSrc(full);
    } else {
      // 文本类：读内容
      const text = await readAttachmentText(props.attachment.storedName);
      textContent.value = text;
      if (category.value === "markdown") {
        await renderMarkdown(text);
      }
    }
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    loading.value = false;
  }
}

/** markdown 渲染区 DOM 引用（用于点击事件委托） */
const mdBodyRef = ref<HTMLElement | null>(null);

/**
 * 自定义 marked 的链接渲染：从源头避免产出可导航的 <a href>。
 *
 * 桌面应用中，webview 原生导航会把整个应用"带走"（脱离 hash 路由后无法返回）。
 * 仅靠 DOM 渲染后再移除 href 有时序风险（viewMode 切换后不会重新处理），
 * 所以在 marked 渲染阶段就把外链改写成不可导航的 <a data-href>：
 *   - 外链(http/https/mailto/tel)：href → data-href，不输出 href 属性，
 *     点击由 onMdClick 接管，用 opener.openUrl 在系统浏览器打开
 *   - 锚点(#xxx)/相对路径：保持原样（页内跳转）
 */
const renderer = new marked.Renderer();
const originalLinkRenderer = renderer.link.bind(renderer);
renderer.link = function ({ href, tokens, ...rest }) {
  const isExternal = /^(https?:|mailto:|tel:)/i.test(href);
  if (!isExternal) {
    return originalLinkRenderer({ href, tokens, ...rest });
  }
  // 完全自己生成 <a>，不依赖原 renderer 输出格式（避免 regex 替换的脆弱性）。
  // 只输出 data-href（无 href），从源头杜绝 webview 原生导航。
  // 链接文字：优先用 marked 内部的 inline parser 渲染 tokens（保留加粗/代码等嵌套），
  // 降级则取 tokens 的纯文本（this.parser 在某些 marked 版本/上下文可能缺失）
  let text: string;
  try {
    text = this.parser.parseInline(tokens);
  } catch {
    text = tokens
      .map((t: { text?: string; raw?: string }) => t.text ?? t.raw ?? "")
      .join("");
  }
  const safeHref = href.replace(/"/g, "&quot;");
  return `<a data-href="${safeHref}" class="md-ext-link" title="在新浏览器打开：${safeHref}">${text}</a>`;
};

/** 渲染 markdown 为安全的 HTML（XSS 过滤） */
async function renderMarkdown(text: string) {
  try {
    const rawHtml = await marked.parse(text, {
      renderer,
      gfm: true, // gfm 表格
      breaks: true, // 换行转 <br>
    });
    renderedHtml.value = DOMPurify.sanitize(rawHtml, {
      // 允许 data-href 和 class（自定义链接拦截需要）
      ADD_ATTR: ["data-href", "target"],
    });
  } catch (e) {
    errorMsg.value = "Markdown 渲染失败：" + String(e);
  }
}

/** 点击事件委托：外链用 opener 在系统浏览器打开，阻止 webview 原生导航 */
async function onMdClick(e: MouseEvent) {
  // 从点击目标往上找最近的 <a data-href>
  const target = (e.target as HTMLElement)?.closest<HTMLAnchorElement>(
    "a[data-href]",
  );
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  const href = target.getAttribute("data-href") ?? "";
  if (!href) return;
  try {
    await openUrl(href);
  } catch (err) {
    errorMsg.value = "打开链接失败：" + String(err);
  }
}

function close() {
  emit("close");
}

function stopPropagation(e: Event) {
  // 点击内容区不触发遮罩关闭
  e.stopPropagation();
}

async function reveal() {
  try {
    await revealAttachment(props.attachment.storedName);
  } catch (e) {
    errorMsg.value = "定位失败：" + String(e);
  }
}

// 标题（截断）
const titleText = computed(() => {
  const name = props.attachment.originalName;
  return name.length > 40 ? name.slice(0, 40) + "…" : name;
});
</script>

<template>
  <Teleport to="body">
    <div class="att-preview" @click="close">
      <div class="att-preview__dialog" @click="stopPropagation">
        <!-- 头部 -->
        <header class="att-preview__header">
          <span class="att-preview__title" :title="attachment.originalName">
            {{ titleText }}
          </span>
          <div class="att-preview__actions">
            <button
              v-if="category === 'markdown'"
              class="att-preview__tab"
              :class="{ 'att-preview__tab--active': viewMode === 'rendered' }"
              @click="viewMode = 'rendered'"
            >
              渲染
            </button>
            <button
              v-if="category === 'markdown'"
              class="att-preview__tab"
              :class="{ 'att-preview__tab--active': viewMode === 'source' }"
              @click="viewMode = 'source'"
            >
              源码
            </button>
            <button class="att-preview__reveal" title="打开所在文件夹" @click="reveal">
              <icon-folder :size="18" />
            </button>
            <button class="att-preview__close" title="关闭 (Esc)" @click="close">
              <icon-close :size="18" />
            </button>
          </div>
        </header>

        <!-- 内容区 -->
        <div class="att-preview__body">
          <div v-if="loading" class="att-preview__loading">加载中…</div>

          <div v-else-if="errorMsg" class="att-preview__error">
            <p>{{ errorMsg }}</p>
            <button class="att-preview__reveal-btn" @click="reveal">
              打开所在文件夹
            </button>
          </div>

          <!-- markdown 渲染模式 -->
          <article
            v-else-if="category === 'markdown' && viewMode === 'rendered'"
            ref="mdBodyRef"
            class="att-preview__md markdown-body"
            v-html="renderedHtml"
            @click="onMdClick"
          />

          <!-- markdown/text 源码模式 -->
          <pre
            v-else-if="(category === 'markdown' && viewMode === 'source') || category === 'text'"
            class="att-preview__source"
          >{{ textContent }}</pre>

          <!-- 图片 -->
          <div v-else-if="category === 'image'" class="att-preview__media">
            <img :src="assetUrl" :alt="attachment.originalName" />
          </div>

          <!-- 视频 -->
          <div v-else-if="category === 'video'" class="att-preview__media att-preview__media--video">
            <video :src="assetUrl" controls autoplay />
          </div>

          <!-- 音频 -->
          <div v-else-if="category === 'audio'" class="att-preview__media att-preview__media--audio">
            <icon-music :size="80" class="att-preview__audio-icon" />
            <audio :src="assetUrl" controls autoplay />
          </div>

          <!-- PDF -->
          <iframe
            v-else-if="category === 'pdf'"
            :src="assetUrl"
            class="att-preview__pdf"
            title="PDF 预览"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.att-preview {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background-color: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  animation: att-fade-in 0.15s ease;
}

@keyframes att-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.att-preview__dialog {
  width: 100%;
  max-width: 900px;
  height: 100%;
  max-height: 88vh;
  background-color: var(--jt-bg-primary, #ffffff);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.att-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--jt-border-light, #e5e7eb);
  flex-shrink: 0;
}

.att-preview__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--jt-text-primary, #1f2937);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.att-preview__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.att-preview__tab {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--jt-text-secondary, #6b7280);
  background: transparent;
  border: 1px solid var(--jt-border-light, #e5e7eb);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s;
}

.att-preview__tab:hover {
  background-color: var(--jt-bg-secondary, #f3f4f6);
}

.att-preview__tab--active {
  color: var(--jt-accent, #4f46e5);
  border-color: var(--jt-accent, #4f46e5);
  background-color: rgba(79, 70, 229, 0.08);
}

.att-preview__reveal,
.att-preview__close {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--jt-text-secondary, #6b7280);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s;
}

.att-preview__reveal:hover,
.att-preview__close:hover {
  background-color: var(--jt-bg-secondary, #f3f4f6);
  color: var(--jt-text-primary, #1f2937);
}

.att-preview__body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.att-preview__loading,
.att-preview__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--jt-text-tertiary, #9ca3af);
  font-size: 14px;
}

.att-preview__reveal-btn {
  padding: 6px 16px;
  font-size: 13px;
  color: var(--jt-accent, #4f46e5);
  background: transparent;
  border: 1px solid var(--jt-accent, #4f46e5);
  border-radius: 6px;
  cursor: pointer;
}

.att-preview__reveal-btn:hover {
  background-color: rgba(79, 70, 229, 0.08);
}

/* markdown 渲染样式 */
.att-preview__md {
  padding: 24px 32px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--jt-text-primary, #1f2937);
}

.att-preview__md :deep(h1),
.att-preview__md :deep(h2),
.att-preview__md :deep(h3),
.att-preview__md :deep(h4) {
  margin: 1.4em 0 0.6em;
  font-weight: 600;
  line-height: 1.3;
}

.att-preview__md :deep(h1) {
  font-size: 1.6em;
  border-bottom: 1px solid var(--jt-border-light, #e5e7eb);
  padding-bottom: 0.3em;
}

.att-preview__md :deep(h2) {
  font-size: 1.35em;
  border-bottom: 1px solid var(--jt-border-light, #e5e7eb);
  padding-bottom: 0.3em;
}

.att-preview__md :deep(h3) {
  font-size: 1.15em;
}

.att-preview__md :deep(p) {
  margin: 0.6em 0;
}

.att-preview__md :deep(ul),
.att-preview__md :deep(ol) {
  margin: 0.6em 0;
  padding-left: 1.8em;
}

.att-preview__md :deep(li) {
  margin: 0.2em 0;
}

.att-preview__md :deep(code) {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.88em;
  background-color: var(--jt-bg-tertiary, rgba(0, 0, 0, 0.06));
  padding: 0.15em 0.4em;
  border-radius: 4px;
}

.att-preview__md :deep(pre) {
  margin: 0.8em 0;
  padding: 12px 16px;
  background-color: var(--jt-bg-secondary, #1e1e1e);
  border-radius: 8px;
  overflow-x: auto;
}

.att-preview__md :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.85em;
  line-height: 1.5;
}

.att-preview__md :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.4em 1em;
  border-left: 3px solid var(--jt-accent, #4f46e5);
  color: var(--jt-text-secondary, #6b7280);
  background-color: var(--jt-bg-tertiary, rgba(0, 0, 0, 0.03));
}

.att-preview__md :deep(a) {
  color: var(--jt-accent, #4f46e5);
  text-decoration: underline;
  cursor: pointer;
}

/* 外链（无 href，由 JS 接管点击 → opener.openUrl）：保持链接视觉 */
.att-preview__md :deep(a.md-ext-link) {
  cursor: pointer;
}

.att-preview__md :deep(a:hover) {
  opacity: 0.8;
}

.att-preview__md :deep(table) {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
}

.att-preview__md :deep(th),
.att-preview__md :deep(td) {
  border: 1px solid var(--jt-border-light, #e5e7eb);
  padding: 6px 12px;
  text-align: left;
}

.att-preview__md :deep(th) {
  background-color: var(--jt-bg-tertiary, #f3f4f6);
  font-weight: 600;
}

.att-preview__md :deep(img) {
  max-width: 100%;
  border-radius: 8px;
}

.att-preview__md :deep(hr) {
  border: none;
  border-top: 1px solid var(--jt-border-light, #e5e7eb);
  margin: 1.2em 0;
}

/* 源码模式 */
.att-preview__source {
  margin: 0;
  padding: 16px 24px;
  font-family: "JetBrains Mono", monospace;
  font-size: 13px;
  line-height: 1.6;
  color: var(--jt-text-primary, #1f2937);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 媒体（图片/视频/音频） */
.att-preview__media {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 16px;
}

.att-preview__media img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
}

.att-preview__media--video video {
  max-width: 100%;
  max-height: 100%;
}

.att-preview__media--audio {
  flex-direction: column;
  gap: 20px;
}

.att-preview__audio-icon {
  color: var(--jt-text-tertiary, #9ca3af);
  opacity: 0.6;
}

/* PDF */
.att-preview__pdf {
  width: 100%;
  height: 100%;
  border: none;
}

/* 深色模式适配 */
:global(body[arco-theme="dark"]) .att-preview__dialog {
  background-color: var(--jt-bg-primary, #1f1f1f);
}
:global(body[arco-theme="dark"]) .att-preview__title {
  color: var(--jt-text-primary, #f3f4f6);
}
:global(body[arco-theme="dark"]) .att-preview__md {
  color: var(--jt-text-primary, #f3f4f6);
}
</style>
