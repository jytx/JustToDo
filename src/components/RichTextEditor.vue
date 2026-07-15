<script setup lang="ts">
// 富文本编辑器 —— 基于 Tiptap
// 控件清单：
//   - 文本格式：加粗 / 斜体 / 下划线 / 删除线 / 行内代码 / 清除格式
//   - 段落：H1/H2/H3 标题下拉 / 引用 / 分隔线 / 硬换行
//   - 列表：无序 / 有序 / 任务列表（todo 复选框）
//   - 链接：插入 / 编辑（弹窗输入 URL）
//   - 代码块：多语言高亮
//   - 图片：粘贴 / 拖拽 / 缩放 / 预览
//   - 气泡菜单：选中文本时浮出快捷工具栏
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import HardBreak from "@tiptap/extension-hard-break";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { BubbleMenuPlugin } from "@tiptap/extension-bubble-menu";
import { PluginKey } from "@tiptap/pm/state";
import { common, createLowlight } from "lowlight";
import { watch, onBeforeUnmount, onMounted, ref, nextTick, computed } from "vue";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

const lowlight = createLowlight(common);

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const uploading = ref(false);

/** 图片预览 lightbox */
const allImages = ref<string[]>([]);
const previewIndex = ref(0);
const previewScale = ref(1);
const editorContainerRef = ref<HTMLElement | null>(null);

const previewSrc = computed(() => allImages.value[previewIndex.value] ?? null);

const editor = useEditor({
  content: props.modelValue || "",
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      // HardBreak 已单独加载并禁用 StarterKit 自带的，避免冲突
      hardBreak: false,
    }),
    Underline,
    Link.configure({
      openOnClick: false, // 单击不直接打开链接，方便编辑
      autolink: true, // 自动识别 URL 转为链接
      HTMLAttributes: {
        rel: "noopener noreferrer",
        target: "_blank",
      },
    }),
    HardBreak,
    TaskList,
    TaskItem.configure({ nested: true }),
    CodeBlockLowlight.configure({ lowlight }),
    Image.configure({
      inline: false,
      allowBase64: false,
      resize: {
        enabled: true,
        minWidth: 80,
        minHeight: 80,
        alwaysPreserveAspectRatio: true,
      },
    } as any),
  ],
  onUpdate: ({ editor }) => {
    emit("update:modelValue", editor.getHTML());
  },
  editorProps: {
    attributes: {
      class: "rich-text__content",
      "data-placeholder": props.placeholder ?? "添加备注...",
    },
    handlePaste: (_view, event) => {
      const cd = event.clipboardData;
      if (!cd) return false;

      // 1. 检查 items 中的图片
      for (const item of Array.from(cd.items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            uploadImage(file);
            return true;
          }
        }
      }

      // 2. 兜底：检查 files 中的图片
      if (cd.files && cd.files.length > 0) {
        for (const file of Array.from(cd.files)) {
          if (file.type.startsWith("image/")) {
            uploadImage(file);
            return true;
          }
        }
      }

      return false;
    },
    handleDrop: (_view, event) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return false;
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          uploadImage(file);
          event.preventDefault();
          return true;
        }
      }
      return false;
    },
  },
});

// ─── 气泡菜单（bubble menu）── 选中文本时浮出 ───────────
const bubbleMenuRef = ref<HTMLElement | null>(null);

// ─── 链接弹窗状态 ───────────────────────────────────
const linkDialogVisible = ref(false);
const linkInputValue = ref("");
/** 记录弹窗打开时光标是否在已有链接上（用于切换为"编辑"模式） */
const linkIsEditing = ref(false);

function openLinkDialog() {
  if (!editor.value) return;
  // 优先取选中文本所在链接的 href（编辑模式）
  const existing = editor.value.getAttributes("link").href as string | undefined;
  linkIsEditing.value = !!existing;
  linkInputValue.value = existing ?? "";
  linkDialogVisible.value = true;
}

function closeLinkDialog() {
  linkDialogVisible.value = false;
  linkInputValue.value = "";
  linkIsEditing.value = false;
}

function applyLink() {
  if (!editor.value) return;
  const url = linkInputValue.value.trim();
  if (!url) {
    // 清空链接
    editor.value.chain().focus().extendMarkRange("link").unsetLink().run();
  } else {
    // 自动补 https://
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    editor.value
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: normalized })
      .run();
  }
  closeLinkDialog();
}

function removeLink() {
  if (!editor.value) return;
  editor.value.chain().focus().extendMarkRange("link").unsetLink().run();
  closeLinkDialog();
}

/** 标题下拉选择 */
function onHeadingSelect(key: string) {
  if (!editor.value) return;
  const chain = editor.value.chain().focus();
  if (key === "h1") chain.toggleHeading({ level: 1 }).run();
  else if (key === "h2") chain.toggleHeading({ level: 2 }).run();
  else if (key === "h3") chain.toggleHeading({ level: 3 }).run();
  else {
    // "p"：清掉所有 heading 级别，回到普通段落
    chain.setParagraph().run();
  }
}

watch(
  () => props.modelValue,
  (val) => {
    if (editor.value && val !== editor.value.getHTML()) {
      editor.value.commands.setContent(val || "", { emitUpdate: false });
    }
  },
);

onMounted(() => {
  // 监听编辑器内图片点击 → 预览
  const handler = (e: Event) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG") {
      e.preventDefault();
      e.stopPropagation();
      collectImages();
      const clickedSrc = (target as HTMLImageElement).src;
      const idx = allImages.value.indexOf(clickedSrc);
      previewIndex.value = idx >= 0 ? idx : 0;
      previewScale.value = 1;
    }
  };
  nextTick(() => {
    editorContainerRef.value?.addEventListener("click", handler);

    // 挂载气泡菜单插件（选中文本时浮出快捷工具栏）
    if (editor.value && bubbleMenuRef.value) {
      const plugin = BubbleMenuPlugin({
        pluginKey: new PluginKey("richTextBubbleMenu"),
        editor: editor.value,
        element: bubbleMenuRef.value,
        options: { placement: "top" },
      });
      editor.value.registerPlugin(plugin);
    }
  });
  (window as any).__richTextClickHandler = handler;

  // ESC 关闭预览 + 方向键切换
  window.addEventListener("keydown", onPreviewKeydown);
});

onBeforeUnmount(() => {
  const handler = (window as any).__richTextClickHandler;
  if (handler) editorContainerRef.value?.removeEventListener("click", handler);
  window.removeEventListener("keydown", onPreviewKeydown);
  editor.value?.destroy();
});

/** 收集编辑器中所有图片 src */
function collectImages() {
  const imgs = editorContainerRef.value?.querySelectorAll("img");
  allImages.value = imgs ? Array.from(imgs).map((img) => (img as HTMLImageElement).src) : [];
}

function closePreview() {
  allImages.value = [];
  previewIndex.value = 0;
  previewScale.value = 1;
}

function prevImage() {
  previewScale.value = 1;
  previewIndex.value = (previewIndex.value - 1 + allImages.value.length) % allImages.value.length;
}

function nextImage() {
  previewScale.value = 1;
  previewIndex.value = (previewIndex.value + 1) % allImages.value.length;
}

function onPreviewKeydown(e: KeyboardEvent) {
  if (!previewSrc.value) return;
  if (e.key === "Escape") closePreview();
  else if (e.key === "ArrowLeft") prevImage();
  else if (e.key === "ArrowRight") nextImage();
}

/** 滚轮缩放 */
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.1 : -0.1;
  previewScale.value = Math.max(0.2, Math.min(5, previewScale.value + delta));
}

async function uploadImage(file: File) {
  uploading.value = true;
  try {
    const base64 = await fileToBase64(file);
    const ext = file.name.split(".").pop()?.toLowerCase() || "png";

    const filename = await invoke<string>("save_image", {
      data: base64,
      ext,
    });

    const fullPath = await invoke<string>("get_attachment_fullpath", {
      filename,
    });

    const src = convertFileSrc(fullPath);

    // 获取图片原始尺寸，设置初始宽度
    const dims = await getImageSize(src);
    const editorWidth = editorContainerRef.value?.clientWidth ?? 400;
    const maxWidth = editorWidth - 24;
    const width = dims.width > maxWidth ? maxWidth : dims.width;

    editor.value?.chain().focus().setImage({ src, width }).run();
  } catch (e) {
    console.error("[RichText] 图片上传失败:", e);
  } finally {
    uploading.value = false;
  }
}

function getImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = document.createElement("img");
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = src;
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function insertImageFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) uploadImage(file);
  };
  input.click();
}
</script>

<template>
  <div class="rich-text" v-if="editor">
    <!-- 工具栏 -->
    <div class="rich-text__toolbar">
      <!-- 文本格式组 -->
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('bold') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleBold().run()"
        title="加粗 (Cmd+B)"
      >
        <icon-bold :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('italic') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleItalic().run()"
        title="斜体 (Cmd+I)"
      >
        <icon-italic :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('underline') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleUnderline().run()"
        title="下划线 (Cmd+U)"
      >
        <icon-underline :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('strike') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleStrike().run()"
        title="删除线"
      >
        <icon-strikethrough :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('code') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleCode().run()"
        title="行内代码"
      >
        <icon-code :size="14" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        type="text"
        @click="editor.chain().focus().clearNodes().unsetAllMarks().run()"
        title="清除格式"
      >
        <icon-eraser :size="16" />
      </a-button>
      <span class="rich-text__divider" />

      <!-- 段落块组 -->
      <!-- 标题下拉（H1/H2/H3 + 段落） -->
      <a-dropdown trigger="click" position="bl" :popup-offset="4">
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('heading') ? 'primary' : 'text'"
          title="标题级别"
        >
          <span class="rich-text__heading-label">
            <template v-if="editor.isActive('heading', { level: 1 })">H1</template>
            <template v-else-if="editor.isActive('heading', { level: 2 })">H2</template>
            <template v-else-if="editor.isActive('heading', { level: 3 })">H3</template>
            <template v-else>¶</template>
          </span>
        </a-button>
        <template #content>
          <a-menu class="rich-text__heading-menu" @menu-item-click="onHeadingSelect">
            <a-menu-item key="p">
              <span class="rich-text__heading-menu-text">¶ 正文</span>
            </a-menu-item>
            <a-menu-item key="h1">
              <span class="rich-text__heading-menu-text">H1 标题</span>
            </a-menu-item>
            <a-menu-item key="h2">
              <span class="rich-text__heading-menu-text">H2 标题</span>
            </a-menu-item>
            <a-menu-item key="h3">
              <span class="rich-text__heading-menu-text">H3 标题</span>
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('blockquote') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleBlockquote().run()"
        title="引用"
      >
        <icon-quote :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        type="text"
        @click="editor.chain().focus().setHorizontalRule().run()"
        title="分隔线"
      >
        <icon-minus :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        type="text"
        @click="editor.chain().focus().setHardBreak().run()"
        title="硬换行 (Shift+Enter)"
      >
        <icon-refresh :size="14" />
      </a-button>
      <span class="rich-text__divider" />

      <!-- 列表组 -->
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('bulletList') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleBulletList().run()"
        title="无序列表"
      >
        <icon-list :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('orderedList') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleOrderedList().run()"
        title="有序列表"
      >
        <icon-ordered-list :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('taskList') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleTaskList().run()"
        title="任务列表"
      >
        <icon-check-square :size="16" />
      </a-button>
      <span class="rich-text__divider" />

      <!-- 代码块 + 链接 + 图片 -->
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('codeBlock') ? 'primary' : 'text'"
        @click="editor.chain().focus().toggleCodeBlock().run()"
        title="代码块"
      >
        <icon-code-square :size="16" />
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('link') ? 'primary' : 'text'"
        @click="openLinkDialog"
        title="插入 / 编辑链接"
      >
        <icon-link :size="16" />
      </a-button>
      <a-button
        type="text"
        size="mini"
        shape="circle"
        :loading="uploading"
        @click="insertImageFromFile"
        title="插入图片"
      >
        <icon-image :size="16" />
      </a-button>
    </div>

    <!-- 编辑区 -->
    <div ref="editorContainerRef" class="rich-text__editor-wrapper">
      <EditorContent :editor="editor" class="rich-text__editor" />
    </div>

    <!-- 气泡菜单：选中文本时由 BubbleMenuPlugin 浮出（脱离文档流，用 teleport 到 body 防止被遮） -->
    <teleport to="body">
      <div ref="bubbleMenuRef" class="rich-text__bubble-menu">
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('bold') ? 'primary' : 'text'"
          @click="editor.chain().focus().toggleBold().run()"
          title="加粗"
        >
          <icon-bold :size="14" />
        </a-button>
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('italic') ? 'primary' : 'text'"
          @click="editor.chain().focus().toggleItalic().run()"
          title="斜体"
        >
          <icon-italic :size="14" />
        </a-button>
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('underline') ? 'primary' : 'text'"
          @click="editor.chain().focus().toggleUnderline().run()"
          title="下划线"
        >
          <icon-underline :size="14" />
        </a-button>
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('strike') ? 'primary' : 'text'"
          @click="editor.chain().focus().toggleStrike().run()"
          title="删除线"
        >
          <icon-strikethrough :size="14" />
        </a-button>
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('code') ? 'primary' : 'text'"
          @click="editor.chain().focus().toggleCode().run()"
          title="行内代码"
        >
          <icon-code :size="12" />
        </a-button>
        <span class="rich-text__bubble-divider" />
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('link') ? 'primary' : 'text'"
          @click="openLinkDialog"
          title="链接"
        >
          <icon-link :size="14" />
        </a-button>
      </div>
    </teleport>

    <!-- 图片预览 lightbox -->
    <teleport to="body">
      <div
        v-if="previewSrc"
        class="rich-text__lightbox"
        @click.self="closePreview"
        @wheel="onWheel"
      >
        <!-- 关闭按钮 -->
        <button class="rich-text__lightbox-close" @click="closePreview">
          <icon-close :size="24" />
        </button>

        <!-- 上一张 -->
        <button
          v-if="allImages.length > 1"
          class="rich-text__lightbox-nav rich-text__lightbox-nav--left"
          @click.stop="prevImage"
        >
          <icon-left :size="28" />
        </button>

        <!-- 图片 -->
        <img
          :src="previewSrc"
          class="rich-text__lightbox-img"
          :style="{ transform: `scale(${previewScale})` }"
          @click.stop
        />

        <!-- 下一张 -->
        <button
          v-if="allImages.length > 1"
          class="rich-text__lightbox-nav rich-text__lightbox-nav--right"
          @click.stop="nextImage"
        >
          <icon-right :size="28" />
        </button>

        <!-- 底部信息 -->
        <div v-if="allImages.length > 1" class="rich-text__lightbox-info">
          {{ previewIndex + 1 }} / {{ allImages.length }} · 滚轮缩放 {{ Math.round(previewScale * 100) }}%
        </div>
        <div v-else class="rich-text__lightbox-info">
          滚轮缩放 {{ Math.round(previewScale * 100) }}%
        </div>
      </div>
    </teleport>

    <!-- 链接弹窗 -->
    <a-modal
      :visible="linkDialogVisible"
      :width="440"
      :footer="false"
      :mask-closable="false"
      :title="linkIsEditing ? '编辑链接' : '插入链接'"
      @cancel="closeLinkDialog"
      @ok="applyLink"
    >
      <div class="rich-text__link-field">
        <label class="rich-text__link-label">链接地址</label>
        <a-input
          v-model="linkInputValue"
          placeholder="https://example.com"
          allow-clear
          autofocus
          @keydown.enter.prevent="applyLink"
          @keydown.esc="closeLinkDialog"
        />
        <p class="rich-text__link-hint">
          支持 http / https 协议；留空可清除链接；输入 example.com 自动补 https://
        </p>
      </div>
      <div class="rich-text__link-actions">
        <a-button v-if="linkIsEditing" status="danger" type="outline" size="small" @click="removeLink">
          移除链接
        </a-button>
        <span style="flex: 1" />
        <a-button size="small" @click="closeLinkDialog">取消</a-button>
        <a-button type="primary" size="small" @click="applyLink">
          {{ linkIsEditing ? "更新" : "插入" }}
        </a-button>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.rich-text {
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  overflow: hidden;
}

.rich-text__toolbar {
  display: flex;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface-sunken);
  align-items: center;
  flex-wrap: wrap;
}

.rich-text__divider {
  width: 1px;
  height: 16px;
  background-color: var(--jt-border);
  margin: 0 2px;
  flex-shrink: 0;
}

.rich-text__editor-wrapper {
  padding: 10px 12px;
  min-height: 160px;
  max-height: none;
  overflow-y: visible;
}

.rich-text__editor :deep(.rich-text__content) {
  outline: none;
  font-size: 13px;
  font-family: var(--font-body);
  line-height: 1.6;
  min-height: 138px;
}

.rich-text__editor :deep(.rich-text__content:empty)::before {
  content: attr(data-placeholder);
  color: var(--jt-text-tertiary);
  pointer-events: none;
}

.rich-text__editor :deep(.rich-text__content p) {
  margin: 0 0 8px;
}

.rich-text__editor :deep(.rich-text__content p:first-child) {
  margin-top: 0;
}

.rich-text__editor :deep(.rich-text__content p:last-child) {
  margin-bottom: 0;
}

/* 标题 */
.rich-text__editor :deep(.rich-text__content h1) {
  font-size: 20px;
  font-weight: 700;
  margin: 14px 0 8px;
  line-height: 1.4;
}
.rich-text__editor :deep(.rich-text__content h2) {
  font-size: 17px;
  font-weight: 700;
  margin: 12px 0 8px;
  line-height: 1.4;
}
.rich-text__editor :deep(.rich-text__content h3) {
  font-size: 15px;
  font-weight: 600;
  margin: 10px 0 6px;
  line-height: 1.4;
}

/* 下划线 */
.rich-text__editor :deep(.rich-text__content u) {
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* 链接 */
.rich-text__editor :deep(.rich-text__content a) {
  color: var(--jt-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.rich-text__editor :deep(.rich-text__content a:hover) {
  opacity: 0.8;
}

/* 引用 */
.rich-text__editor :deep(.rich-text__content blockquote) {
  border-left: 3px solid var(--jt-primary);
  padding-left: 12px;
  margin: 8px 0;
  color: var(--jt-text-secondary);
  font-style: italic;
}

/* 分隔线 */
.rich-text__editor :deep(.rich-text__content hr) {
  border: none;
  border-top: 1px solid var(--jt-border);
  margin: 12px 0;
}

.rich-text__editor :deep(.rich-text__content ul),
.rich-text__editor :deep(.rich-text__content ol) {
  padding-left: 20px;
  margin: 0 0 8px;
}

/* 任务列表 */
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"]) {
  list-style: none;
  padding-left: 0;
  margin: 4px 0 8px;
}
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"] ul[data-type="taskList"]) {
  /* 嵌套二级任务列表：每级缩进 24px，与父级 checkbox 位置明显错开 */
  padding-left: 24px;
  margin: 2px 0 4px;
}
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"] li) {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 2px 0;
}
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"] li > label) {
  flex-shrink: 0;
  margin-top: 4px;
  user-select: none;
}
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"] li > div) {
  flex: 1;
  min-width: 0;
}
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"] input[type="checkbox"]) {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--jt-primary);
}
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"] li[data-checked="true"] > div) {
  color: var(--jt-text-tertiary);
  text-decoration: line-through;
}

/* 图片 */
.rich-text__editor :deep(.rich-text__content img) {
  border-radius: 6px;
  margin: 8px 0;
  cursor: zoom-in;
}

/* resize 容器（data-resize-container）—— inline-flex 让宽度跟随图片 */
.rich-text__editor :deep([data-resize-container]) {
  display: inline-flex !important;
  position: relative;
  max-width: 100%;
}

/* resize wrapper */
.rich-text__editor :deep([data-resize-wrapper]) {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

/* 选中状态边框 */
.rich-text__editor :deep([data-resize-container].ProseMirror-selectednode) {
  outline: 2px solid var(--jt-primary);
  outline-offset: 2px;
  border-radius: 6px;
}

/* resize 手柄（四角） */
.rich-text__editor :deep([data-resize-handle]) {
  width: 12px !important;
  height: 12px !important;
  background-color: var(--jt-primary) !important;
  border: 2px solid #fff !important;
  border-radius: 50% !important;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.3);
  z-index: 10;
}

/* 代码块（带语法高亮） */
.rich-text__editor :deep(.rich-text__content pre) {
  background: var(--jt-surface-sunken);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-x: auto;
  margin: 8px 0;
}

.rich-text__editor :deep(.rich-text__content pre code) {
  background: none;
  padding: 0;
  font-size: 12px;
}

/* lowlight 语法高亮配色 */
.rich-text__editor :deep(.hljs-comment),
.rich-text__editor :deep(.hljs-quote) {
  color: var(--jt-text-tertiary);
  font-style: italic;
}

.rich-text__editor :deep(.hljs-keyword),
.rich-text__editor :deep(.hljs-selector-tag),
.rich-text__editor :deep(.hljs-built_in),
.rich-text__editor :deep(.hljs-name),
.rich-text__editor :deep(.hljs-tag) {
  color: #c678dd;
}

.rich-text__editor :deep(.hljs-string),
.rich-text__editor :deep(.hljs-attr),
.rich-text__editor :deep(.hljs-template-tag),
.rich-text__editor :deep(.hljs-template-variable) {
  color: #98c379;
}

.rich-text__editor :deep(.hljs-number),
.rich-text__editor :deep(.hljs-literal),
.rich-text__editor :deep(.hljs-boolean) {
  color: #d19a66;
}

.rich-text__editor :deep(.hljs-function),
.rich-text__editor :deep(.hljs-title),
.rich-text__editor :deep(.hljs-class .hljs-title) {
  color: #61afef;
}

.rich-text__editor :deep(.hljs-variable),
.rich-text__editor :deep(.hljs-property),
.rich-text__editor :deep(.hljs-symbol),
.rich-text__editor :deep(.hljs-constant) {
  color: #e06c75;
}

.rich-text__editor :deep(.hljs-type),
.rich-text__editor :deep(.hljs-meta) {
  color: #56b6c2;
}

/* 行内代码 */
.rich-text__editor :deep(.rich-text__content code) {
  background: var(--jt-surface-sunken);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}

/* 图片预览 lightbox */
.rich-text__lightbox {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.85);
}

.rich-text__lightbox-img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  transition: transform 0.1s ease;
  user-select: none;
}

.rich-text__lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  background: rgba(255, 255, 255, 0.15);
  border: none;
  border-radius: 50%;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  cursor: pointer;
  transition: background 0.15s;
}

.rich-text__lightbox-close:hover {
  background: rgba(255, 255, 255, 0.3);
}

.rich-text__lightbox-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.15);
  border: none;
  border-radius: 50%;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  cursor: pointer;
  transition: background 0.15s;
}

.rich-text__lightbox-nav:hover {
  background: rgba(255, 255, 255, 0.3);
}

.rich-text__lightbox-nav--left {
  left: 24px;
}

.rich-text__lightbox-nav--right {
  right: 24px;
}

.rich-text__lightbox-info {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  font-family: var(--font-mono);
  white-space: nowrap;
}

/* ─── 标题下拉按钮（按钮里显示当前级别） ───────────────── */
.rich-text__heading-label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  min-width: 14px;
  display: inline-block;
  text-align: center;
}

.rich-text__heading-menu-text {
  font-family: var(--font-body);
  font-size: 13px;
}

.rich-text__heading-menu :deep(.arco-menu-item) {
  padding: 0 !important;
  margin: 0 !important;
  min-height: 32px !important;
}
.rich-text__heading-menu :deep(.arco-menu-item-inner) {
  padding: 0 12px !important;
}

/* ─── 链接弹窗 ─────────────────────────────────────── */
.rich-text__link-field {
  margin-top: 4px;
}
.rich-text__link-label {
  display: block;
  font-size: 12px;
  color: var(--jt-text-secondary);
  margin-bottom: 8px;
}
.rich-text__link-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--jt-text-tertiary);
  line-height: 1.5;
}
.rich-text__link-actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
  align-items: center;
}

/* ─── 气泡菜单（bubble menu）── 选中文字时浮出 ─────────────── */
.rich-text__bubble-menu {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background-color: var(--jt-surface);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
  border: 1px solid var(--jt-border);
}
.rich-text__bubble-divider {
  width: 1px;
  height: 16px;
  background-color: var(--jt-border);
  margin: 0 2px;
}

body[arco-theme="dark"] .rich-text__bubble-menu {
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}
</style>
