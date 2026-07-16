<script setup lang="ts">
// 富文本编辑器 —— 基于 Tiptap
// 控件清单：
//   - 文本格式：加粗 / 斜体 / 下划线 / 删除线 / 行内代码 / 清除格式
//   - 段落：H1/H2/H3 标题下拉 / 引用 / 分隔线 / 硬换行
//   - 列表：无序 / 有序 / 任务列表（todo 复选框）
//   - 链接：插入 / 编辑（弹窗输入 URL）
//   - 代码块：多语言高亮
//   - 图片：粘贴 / 拖拽 / 缩放 / 预览
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import HardBreak from "@tiptap/extension-hard-break";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Suggestion from "@tiptap/suggestion";
import { Extension } from "@tiptap/core";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { common, createLowlight } from "lowlight";
import { watch, onBeforeUnmount, onMounted, ref, nextTick, computed, createApp } from "vue";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import SlashCommandMenu, { type SlashCommandItem } from "./SlashCommandMenu.vue";
import RichTextFloatingMenu from "./RichTextFloatingMenu.vue";
import BlockDragHandle from "./BlockDragHandle.vue";

const lowlight = createLowlight(common);

/**
 * 自定义扩展：覆盖 Tiptap 内置的 Mod-a / selectAll 行为。
 *
 * 默认 Tiptap 用 AllSelection（from=0, to=doc.content.size），
 * 但在含 taskList 的 doc 中表现是"只选光标所在 listItem"。
 * 改用 TextSelection.create(doc, 0, doc.content.size) 能正确全选整篇。
 *
 * 两层兜底：
 *  1. addCommands 覆盖 selectAll 命令（被 mod-a 调用）
 *  2. addKeyboardShortcuts 直接拦截 Mod-a 并 return true
 */
const SelectAllFix = Extension.create({
  name: "selectAllFix",
  addCommands() {
    return {
      selectAll:
        () =>
        ({ state, dispatch }) => {
          const tr = state.tr.setSelection(
            TextSelection.create(state.doc, 0, state.doc.content.size),
          );
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-a": () => {
        const { state, dispatch } = this.editor.view;
        if (!dispatch) return true;
        dispatch(
          state.tr.setSelection(
            TextSelection.create(state.doc, 0, state.doc.content.size),
          ),
        );
        return true;
      },
    };
  },
});

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  /** 无边框模式（融入父容器，详情面板主区用） */
  borderless?: boolean;
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

// ─── Slash Command 菜单（Notion-like 输入 / 唤起 block 菜单）────────
// items 定义每个 block 类型；command 在被选中时执行（call editor commands）
const slashItems: SlashCommandItem[] = [
  { key: "text", title: "正文", description: "Paragraph", keywords: ["text", "p"] },
  { key: "h1", title: "H1 标题", description: "Heading 1", keywords: ["heading", "标题"] },
  { key: "h2", title: "H2 标题", description: "Heading 2", keywords: ["heading", "标题"] },
  { key: "h3", title: "H3 标题", description: "Heading 3", keywords: ["heading", "标题"] },
  {
    key: "bullet",
    title: "无序列表",
    description: "Bullet list",
    keywords: ["ul", "list", "列表"],
  },
  {
    key: "ordered",
    title: "有序列表",
    description: "Numbered list",
    keywords: ["ol", "list", "列表"],
  },
  {
    key: "todo",
    title: "待办列表",
    description: "To-do list",
    keywords: ["task", "todo", "checklist"],
  },
  { key: "quote", title: "引用", description: "Quote", keywords: ["blockquote"] },
  { key: "code", title: "代码", description: "Code block", keywords: ["pre"] },
  { key: "hr", title: "分隔线", description: "Divider", keywords: ["hr", "line"] },
];

/**
 * Slash Command 工厂：返回一个 ProseMirror Plugin 实例，
 * 用于在 editor 创建后用 editor.registerPlugin(imperative) 注册。
 *
 * 选 block 命令在 command 回调里：
 *  - editor.chain().focus().deleteRange(range) 删除 /xxx 范围
 *  - 链上 toggleXxx / setParagraph / setHorizontalRule 等切换 block 类型
 *  - 一次 .run() 让二者合并到同一个 ProseMirror transaction，
 *    避免双 transaction 之间 Suggestion utility 维护的 range 失效造成字符残留。
 */
function buildSlashCommandPlugin(editorInstance: TiptapEditor) {
  return (Suggestion as any)({
    editor: editorInstance,
    char: "/",
    startOfLine: false,
    allowSpaces: false,
    items: ({ query }: { query: string }) =>
      slashItems.filter((it) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        const hay = [it.title, it.description ?? "", ...(it.keywords ?? [])]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      }),
    command: ({
      editor,
      range,
      props: commandProps,
    }: {
      editor: import("@tiptap/core").Editor;
      range: { from: number; to: number };
      /**
       * utility 的 props.command(item) → 命令 prop 实际是
       * {editor, range, props: item} 三层结构（utility 包装），
       * 所以这里 `props` 就是 commandProps，要拿真正 item 用
       * `commandProps.props`。
       */
      props: { editor: import("@tiptap/core").Editor; range: { from: number; to: number }; props: SlashCommandItem };
    }) => {
      const item = commandProps.props;
      const c = editor.chain().focus().deleteRange(range as any);
      switch (item.key) {
        case "text":
          c.setParagraph().run();
          break;
        case "h1":
          c.toggleHeading({ level: 1 }).run();
          break;
        case "h2":
          c.toggleHeading({ level: 2 }).run();
          break;
        case "h3":
          c.toggleHeading({ level: 3 }).run();
          break;
        case "bullet":
          if (!editor.isActive("bulletList")) c.toggleBulletList().run();
          break;
        case "ordered":
          if (!editor.isActive("orderedList")) c.toggleOrderedList().run();
          break;
        case "todo":
          if (!editor.isActive("taskList")) c.toggleTaskList().run();
          break;
        case "quote":
          if (!editor.isActive("blockquote")) c.toggleBlockquote().run();
          break;
        case "code":
          if (!editor.isActive("codeBlock")) c.toggleCodeBlock().run();
          break;
        case "hr":
          c.setHorizontalRule().run();
          break;
      }
    },
    // Vue createApp 挂 SlashCommandMenu；由 Suggestion utility 提供 mount + 定位
    render: () => {
      let mountedApp: { unmount: () => void } | null = null;
      let unmountSuggestion: (() => void) | null = null;

      function buildComponentProps(props: any) {
        const rect = props.clientRect?.();
        const buildCommandFn = (item: SlashCommandItem) => {
          props.command({ editor: props.editor, range: props.range, props: item });
        };
        return {
          items: (props.items as SlashCommandItem[]) ?? [],
          query: (props.query as string) ?? "",
          editor: props.editor,
          open: true,
          rect: rect
            ? { left: rect.left, top: rect.top, bottom: rect.bottom }
            : null,
          onSelectCommand: buildCommandFn,
        };
      }

      function teardown() {
        if (unmountSuggestion) {
          unmountSuggestion();
          unmountSuggestion = null;
        }
        if (mountedApp) {
          mountedApp.unmount();
          mountedApp = null;
        }
      }

      function setupWith(props: any) {
        teardown();
        const element = document.createElement("div");
        element.setAttribute("data-slash-menu", "1");
        const app = createApp(SlashCommandMenu, buildComponentProps(props));
        app.mount(element);
        unmountSuggestion = props.mount(element);
        mountedApp = app;
      }

      return {
        onStart: (props: any) => setupWith(props),
        onUpdate: (props: any) => setupWith(props),
        onExit: () => teardown(),
        // 必须 return true 让 Tiptap 知道按键被拦截，避免继续插入字符
        onKeyDown: () => true,
      };
    },
  });
}

/** Imperative 注册：等 editor 创建完成（watch），调 registerPlugin。
 * Extension.create 包装后 addProseMirrorPlugins 在本环境下没被 Tiptap 收集到
 * ProseMirror state.plugins（实测），所以改回 imperative 路径。
 */
function installSlashPlugin(editorInstance: TiptapEditor) {
  editorInstance.registerPlugin(buildSlashCommandPlugin(editorInstance));
}

function uninstallSlashPlugin(editorInstance: TiptapEditor) {
  try {
    // Suggestion 内置 pluginKey 是 "suggestion"，unregisterPlugin 用 string 即可
    editorInstance.unregisterPlugin("suggestion");
  } catch {
    /* ignore */
  }
}




const previewSrc = computed(() => allImages.value[previewIndex.value] ?? null);

// editor 实例由 useEditor() 创建，再以 ref 暴露给外部（defineExpose 用）
const editor = useEditor({
  content: props.modelValue || "",
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      // HardBreak 已单独加载并禁用 StarterKit 自带的，避免冲突
      hardBreak: false,
      // dropcursor（拖拽时显示的横线）：默认 1px currentColor 太细不醒目，
      // 加粗到 2px 并用主题强调色，配合 drag handle 拖拽时更易判断落点
      dropcursor: { width: 2, color: "#4F46E5" },
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
    CodeBlockLowlight.configure({ lowlight }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // 注：故意不加 @tiptap/extension-placeholder。
    // 它默认给每个空段落都加提示文字，回车后每行都显示，体验差。
    // 改为依赖下方 CSS `.rich-text__content:empty::before { ... }`，仅在
    // doc 完全为空时显示一次"按 / 唤起命令…"，符合 Notion-like 行为。
    SelectAllFix,
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
    // Slash Command —— 不在 extensions 数组里，用 editor 准备好后
    // editor.registerPlugin() imperative 注册（详见下方 watch）。
    // Extension.create({ addProseMirrorPlugins() }) 路径在本环境下
    // addProseMirrorPlugins 没被 Tiptap 收集到 ProseMirror plugins（实测确认），
    // 所以改用 imperative 路径。
  ],
  onUpdate: ({ editor }) => {
    emit("update:modelValue", editor.getHTML());
  },
  editorProps: {
    attributes: {
      class: "rich-text__content",
      // 文档完全空时显示的提示。
      // 由 CSS `.rich-text__content:empty::before` 通过 data-placeholder 读取。
      "data-placeholder": props.placeholder ?? "按 / 唤起命令，输入备注…",
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

// ─── 工具条相关状态已抽离到 RichTextToolbar 组件 ───

// Slash Command plugin 注册：
// useEditor 创建的 editor 是 ref；注册要等 editor 实例 ready。
// 在 watch 中监测 editor.value 变化，第一次非 undefined 时 installSlashPlugin。
watch(
  editor,
  (ed, _old, onCleanup) => {
    if (!ed) return;
    installSlashPlugin(ed);
    onCleanup(() => {
      uninstallSlashPlugin(ed);
    });
  },
  { immediate: true },
);

watch(
  () => props.modelValue,
  (val) => {
    if (editor.value && val !== editor.value.getHTML()) {
      editor.value.commands.setContent(val || "", { emitUpdate: false });
    }
  },
);

// 暴露给父级：让外部工具条能拿到 editor 实例并调用命令
defineExpose({
  /** Tiptap editor 实例（首次挂载前为 null） */
  get editor() {
    return editor.value;
  },
  /** 聚焦编辑器（点击工具条按钮前自动调用，确保命令作用于当前内容） */
  focus: () => editor.value?.commands.focus(),
});

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
</script>

<template>
  <div
    class="rich-text"
    :class="{ 'rich-text--borderless': borderless }"
    v-if="editor"
  >
    <!-- 编辑区 -->
    <div ref="editorContainerRef" class="rich-text__editor-wrapper">
      <EditorContent :editor="editor" class="rich-text__editor" />
    </div>

    <!-- 空段落浮 + 按钮（Notion-like 入口之一） -->
    <RichTextFloatingMenu :editor="editor" />

    <!-- 块拖拽手柄 + 落点横线（自定义鼠标事件实现） -->
    <BlockDragHandle :editor="editor" />

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
  </div>
</template>

<style scoped>
.rich-text {
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  overflow: hidden;
}

.rich-text--borderless {
  border: none;
  border-radius: 0;
  overflow: visible;
}

.rich-text__editor-wrapper {
  padding: 10px 12px;
  min-height: 160px;
  max-height: none;
  overflow-y: visible;
}

.rich-text--borderless .rich-text__editor-wrapper {
  padding: 0;
  min-height: 0;
}

.rich-text__editor :deep(.rich-text__content) {
  outline: none;
  font-size: 13px;
  font-family: var(--font-body);
  line-height: 1.6;
  min-height: 138px;
}

.rich-text__editor :deep(.rich-text__content:empty)::before {
  /* doc 完全空时显示的占位提示。
     注意：这里**不能再给每个空段落加 .is-empty 提示**，
     否则按回车后每行都显示，体验差。*/
  content: attr(data-placeholder);
  color: var(--jt-text-tertiary);
  pointer-events: none;
}

/* 拖拽手柄样式已迁移到 BlockDragHandle.vue（自定义鼠标事件实现） */

.rich-text__editor :deep(.rich-text__content p) {
  margin: 0;
  /* Notion 风格的段落间距 */
  padding: 3px 0;
}

.rich-text__editor :deep(.rich-text__content p:first-child) {
  margin-top: 0;
}

.rich-text__editor :deep(.rich-text__content p:last-child) {
  margin-bottom: 0;
}

/* 标题 — Geist 显示气质：靠字号 + 字重 + 字间距区分层级 */
.rich-text__editor :deep(.rich-text__content h1) {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.025em;
  margin: 8px 0 4px;
  line-height: 1.3;
}
.rich-text__editor :deep(.rich-text__content h2) {
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 6px 0 4px;
  line-height: 1.3;
}
.rich-text__editor :deep(.rich-text__content h3) {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.015em;
  margin: 4px 0 2px;
  line-height: 1.3;
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
  padding: 4px 12px;
  margin: 4px 0;
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
  margin: 4px 0;
}

/* 任务列表 */
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"]) {
  list-style: none;
  padding-left: 0;
  margin: 4px 0;
}
.rich-text__editor :deep(.rich-text__content ul[data-type="taskList"] ul[data-type="taskList"]) {
  /* 嵌套二级任务列表：每级缩进 24px，与父级 checkbox 位置明显错开 */
  padding-left: 24px;
  margin: 2px 0 2px;
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
/* 工具条已抽离到 RichTextToolbar 组件，样式也一并迁过去 */
</style>
