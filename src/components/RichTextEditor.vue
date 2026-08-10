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
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import HardBreak from "@tiptap/extension-hard-break";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Suggestion from "@tiptap/suggestion";
import { marked } from "marked";
import TurndownService from "turndown";
import * as turndownPluginGfm from "turndown-plugin-gfm";
import { Extension } from "@tiptap/core";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { watch, onBeforeUnmount, onMounted, ref, computed, createApp, nextTick } from "vue";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import SlashCommandMenu, { type SlashCommandItem } from "./SlashCommandMenu.vue";
import RichTextFloatingMenu from "./RichTextFloatingMenu.vue";
import BlockDragHandle from "./BlockDragHandle.vue";
import TableToolbar from "./TableToolbar.vue";
import TableSizePicker from "./TableSizePicker.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import ContextMenu from "./ContextMenu.vue";
import { CodeBlockFold } from "@/extensions/CodeBlockFold";
import { HeadingFold } from "@/extensions/HeadingFold";
import { tableExtension } from "@/extensions/TableFold";

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

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    /** 无边框模式（融入父容器，详情面板主区用） */
    borderless?: boolean;
    /** 是否启用块拖拽手柄（默认 true；模板编辑弹窗等小场景下传 false 关闭） */
    dragHandle?: boolean;
  }>(),
  {
    placeholder: "",
    borderless: false,
    dragHandle: true,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const uploading = ref(false);

/**
 * IME composition 起始位置（compositionstart 时记录）。
 * WebKit 的 deleteCompositionText 不可取消（cancelable=false），执行后
 * ProseMirror 的 selection 会错误偏移到标题节点外。insertFromComposition
 * 时用此变量记录的正确起始位置插入中文，绕过 selection 偏移问题。
 * 详见 editorProps.handleDOMEvents 注释。
 */
let compStartPos: number | null = null;

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
  { key: "h4", title: "H4 标题", description: "Heading 4", keywords: ["heading", "标题"] },
  { key: "h5", title: "H5 标题", description: "Heading 5", keywords: ["heading", "标题"] },
  { key: "h6", title: "H6 标题", description: "Heading 6", keywords: ["heading", "标题"] },
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
  { key: "table", title: "表格", description: "Table", keywords: ["table", "表格"] },
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
        case "h4":
          c.toggleHeading({ level: 4 }).run();
          break;
        case "h5":
          c.toggleHeading({ level: 5 }).run();
          break;
        case "h6":
          c.toggleHeading({ level: 6 }).run();
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
        case "table":
          // 不直接插固定大小，先 run 掉已链上的 deleteRange（清 "/表格..."），
          // 再弹出行列选择器，选 N×N 后插入
          c.run();
          openTablePicker();
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
        // 表格 hover 二级选中行列：删除 "/表格" 范围 + 插入指定大小表格
        const buildPickTableFn = (rows: number, cols: number) => {
          const ed = props.editor;
          ed.chain()
            .focus()
            .deleteRange(props.range)
            .insertTable({ rows, cols, withHeaderRow: true })
            .run();
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
          onPickTable: buildPickTableFn,
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

// ─── 源码/预览模式切换 ───
/** 源码模式开关：true 时显示 textarea 编辑 Markdown，false 时显示富文本 */
const sourceMode = ref<boolean>(false);
/** 源码模式的 Markdown 文本（切换时填充） */
const sourceText = ref<string>("");
/** 进入源码模式时备份的原 HTML（切回时若源码未改，用此无损恢复，避免 turndown/marked 往返丢格式） */
let sourceHtmlBackup = "";
/** TurndownService 实例：富文本 HTML → Markdown（切到源码模式时用） */
const turndownService = new TurndownService({
  headingStyle: "atx",     // 标题用 # 风格
  codeBlockStyle: "fenced", // 代码块用 ``` 围栏
  bulletListMarker: "-",   // 无序列表用 -
});
// GFM 删除线插件（~~text~~）
turndownService.use(turndownPluginGfm.strikethrough);
// 标题 NodeView（heading-block）：编辑器内标题渲染为 .heading-block--h{N} 包裹的
// div（NodeViewContent 固定 as=div，见 HeadingView），turndown 默认 heading 规则
// 按 h1-h6 tagName 识别不到。这里自定义规则按 class 的级别数字转 ATX 标题（# 前缀）。
turndownService.addRule("headingBlocks", {
  filter: (node: HTMLElement) => /^heading-block--h[1-6]$/.test(node.className ?? ""),
  replacement: (content: string, node: HTMLElement) => {
    const m = /^heading-block--h([1-6])$/.exec(node.className ?? "");
    if (!m) return content;
    // 折叠按钮（空 button + 图标）转出的空内容直接丢弃，只保留标题文字
    return `${"#".repeat(Number(m[1]))} ${content.trim()}\n\n`;
  },
});
// 表格 → Markdown 表格语法（| col | col |）。
// 不用 gfm.tables：Tiptap 表格单元格内含 <p>、colspan/rowspan 属性，gfm 规则
// 处理不了会拆成零散文本。这里自定义规则：逐行取单元格纯文本，用 | 拼接。
turndownService.addRule("tables", {
  filter: (node: HTMLElement) => node.nodeName === "TABLE",
  replacement: (_content: string, node: HTMLElement) => {
    const rows: string[][] = [];
    node.querySelectorAll("tr").forEach((tr) => {
      const cells: string[] = [];
      tr.querySelectorAll(":scope > td, :scope > th").forEach((cell) => {
        // 单元格纯文本：去掉内部 <p> 的换行，压缩空格
        const text = (cell.textContent ?? "").trim().replace(/\s*\n\s*/g, " ");
        cells.push(text.replace(/\|/g, "\\|"));
      });
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length === 0) return "";
    // 第一行作表头，第二行是分隔行 | --- | --- |
    const header = `| ${rows[0].join(" | ")} |`;
    const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
    const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`);
    return `\n\n${[header, sep, ...body].join("\n")}\n\n`;
  },
});
// 任务列表（checkbox）转 Markdown 任务语法：- [ ] / - [x]
turndownService.addRule("taskListItems", {
  filter: (node: HTMLElement) => node.nodeName === "LI" && node.getAttribute("data-type") === "taskItem",
  replacement: (content: string, node: HTMLElement) => {
    const checked = node.getAttribute("data-checked") === "true";
    return `- [${checked ? "x" : " "}] ${content.trim()}\n`;
  },
});

/** 进入源码模式时备份的 Markdown（用于检测切回时是否改动过） */
let sourceTextBackup = "";
/** textarea DOM 引用（用于 JS 同步高度，CSS absolute 对 textarea 拉伸不可靠） */
const sourceTextareaRef = ref<HTMLTextAreaElement | null>(null);

/** 切换到源码模式：富文本 HTML → Markdown（同时备份原 HTML 供无损切回） */
async function enterSourceMode(): Promise<void> {
  if (!editor.value) return;
  sourceHtmlBackup = editor.value.getHTML();
  sourceText.value = turndownService.turndown(sourceHtmlBackup);
  sourceTextBackup = sourceText.value;
  sourceMode.value = true;
  // 切换后同步 textarea 高度 = 编辑区高度（textarea 的 absolute height:100% 在
  // 某些浏览器不生效，用 JS 显式设置最可靠）
  await nextTick();
  syncSourceHeight();
}
/** 同步 textarea 高度到编辑区实际高度 */
function syncSourceHeight(): void {
  const wrapper = editorContainerRef.value;
  const ta = sourceTextareaRef.value;
  if (wrapper && ta) {
    ta.style.height = wrapper.clientHeight + "px";
  }
}
/** 切换回预览模式：源码未改则用备份 HTML 无损恢复；改了则 marked 转 HTML */
function exitSourceMode(): void {
  if (!editor.value) return;
  if (sourceText.value === sourceTextBackup) {
    // 源码未改：用原 HTML 恢复，避免 turndown→marked 往返转换丢失格式
    editor.value.commands.setContent(sourceHtmlBackup, { emitUpdate: false });
  } else {
    // 源码改了：用 marked 转 HTML（用户主动编辑，接受格式变化）
    const html = marked.parse(sourceText.value, { async: false }) as string;
    editor.value.commands.setContent(html, { emitUpdate: false });
    emit("update:modelValue", editor.value.getHTML());
  }
  sourceMode.value = false;
}
/** 切换按钮点击 */
function toggleSourceMode(): void {
  if (sourceMode.value) exitSourceMode();
  else enterSourceMode();
}

/**
 * 检测剪贴板 HTML 是否只是"代码块包裹的纯文本"（伪 HTML）。
 * IDE（如 WebStorm）复制 .md 文件时会把整段内容包成 <pre><code>...</code></pre>，
 * 这不是真实富文本，应改用纯文本走 Markdown 解析，否则会被渲染成一个大代码块。
 * 判定：去掉 pre/code 标签后，不含其他结构化标签（h1-h6/ul/ol/blockquote/p/table 等）。
 */
function isCodeBlockOnlyHtml(html: string): boolean {
  // 必须以 <pre 开头（代码块包裹的典型特征）
  if (!/<pre[\s>]/i.test(html)) return false;
  // 去掉 pre/code/pre* 标签后，检查是否还有结构化标签
  const stripped = html.replace(/<\/?(pre|code)[^>]*>/gi, "");
  const hasStructure = /<(h[1-6]|ul|ol|li|blockquote|p|table|thead|tbody|tr|td|th|img|a)\b/i.test(stripped);
  return !hasStructure;
}

/**
 * 检测纯文本是否含块级 Markdown 结构（用于粘贴时决定是否当 Markdown 解析）。
 * 只认"多行块级语法"（标题/列表/代码块围栏/引用/分隔线），避免误判普通文本。
 * 单行内联语法（*斜体*、`代码`）不触发，因为普通文本也可能含这些字符。
 */
function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let blockMatches = 0;
  for (const line of lines) {
    // ATX 标题：# / ## / ... / ######
    if (/^#{1,6}\s+\S/.test(line)) blockMatches++;
    // 无序列表项：- / * / + 后接空格
    else if (/^[-*+]\s+\S/.test(line)) blockMatches++;
    // 有序列表项：1. / 12) 等
    else if (/^\d+[.)]\s+\S/.test(line)) blockMatches++;
    // 引用块：>
    else if (/^>\s?/.test(line)) blockMatches++;
    // 围栏代码块：``` 或 ~~~
    else if (/^(```|~~~)/.test(line)) blockMatches++;
    // 分隔线：--- / *** / ___（三个以上同类字符）
    else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) blockMatches++;
  }
  // 至少 1 个块级结构即判定为 Markdown（块级语法在普通文本中极少出现）
  return blockMatches >= 1;
}

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
      // heading 由 HeadingFold 替代（支持折叠 + 持久化 folded attribute），
      // 这里禁用 StarterKit 内置的避免冲突
      heading: false,
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
    // 代码块：自定义 NodeView（语言切换 + 复制 + 折叠），folded attribute 持久化
    CodeBlockFold,
    // 标题：H1-H6 + 折叠（folded attribute 持久化 + Decoration Plugin 隐藏下属块）
    HeadingFold.configure({ levels: [1, 2, 3, 4, 5, 6] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // 表格：TableKit（Table + TableRow + TableCell + TableHeader）
    tableExtension,
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
        /* 允许自由拉伸（不再保持纵横比）—— 用户可以单独改宽 / 高 */
        alwaysPreserveAspectRatio: false,
        /* 8 个方向：4 角 + 4 边 */
        directions: [
          "top",
          "right",
          "bottom",
          "left",
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
        ],
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

      // 3. Markdown 源码粘贴：从 .md 文件或纯文本编辑器复制的 Markdown，
      //    Tiptap 默认会当纯文本/代码块插入。检测到块级 Markdown 结构时，用 marked
      //    转成 HTML 再插入，使其渲染成富文本（标题/列表/代码块/引用等）。
      const html = cd.getData("text/html");
      const text = cd.getData("text/plain");
      // 触发 Markdown 解析的条件：无 HTML（纯文本来源），或 HTML 只是代码块包裹
      // （IDE 如 WebStorm 复制 .md 文件时会生成 <pre><code> 包裹的"伪 HTML"）。
      // 有真实富文本 HTML（网页/Word）则走 Tiptap 默认处理，不干预。
      const isPseudoHtml = !!html && isCodeBlockOnlyHtml(html);
      if (text && (!html || isPseudoHtml) && looksLikeMarkdown(text)) {
        const rendered = marked.parse(text, { async: false }) as string;
        if (editor.value) {
          editor.value.commands.insertContent(rendered);
          event.preventDefault();
          return true;
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
    handleDOMEvents: {
      // ── WebKit IME composition 修复 ──────────────────────
      // Tauri 用 WKWebView（WebKit），ProseMirror 识别为 Safari。IME 回车确认
      // 中文时，deleteCompositionText（cancelable=false 无法拦截）执行后
      // ProseMirror 的 selection 会错误偏移到标题节点外（如从 pos 7 跳到 9），
      // 导致 insertFromComposition 把中文插到下一行段落而非标题内。
      //
      // 修复：compositionstart 记录 selection 起始位置，insertFromComposition
      // 时 preventDefault 浏览器默认插入，改用 transaction 精确替换拼音区间。
      compositionstart: (view) => {
        compStartPos = view.state.selection.from;
        return false;
      },
      beforeinput: (view, event) => {
        const ie = event as InputEvent;
        if (ie.inputType === "insertFromComposition" && ie.data) {
          ie.preventDefault();
          const { state } = view;
          const from = compStartPos ?? state.selection.from;
          const tr = state.tr.insertText(ie.data, from, state.selection.to);
          tr.setMeta("composition", true);
          view.dispatch(tr);
          compStartPos = null;
          return true;
        }
        return false;
      },
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

// ─── 表格右键菜单 ───────────────────────────────────
/** 表格右键菜单显隐 + 定位（在 table/td/th 上右键时弹出） */
const tableContextMenuVisible = ref(false);
const tableContextMenuPos = ref({ x: 0, y: 0 });

/** 表格行列选择器（斜杠菜单/块手柄菜单选「表格」时弹出，选行列后插入） */
const tablePickerVisible = ref(false);
const tablePickerPos = ref({ x: 0, y: 0 });

/** 弹出行列选择器：锚到当前光标位置（斜杠/手柄菜单触发）。
 *  下方空间不足时改在光标上方弹出，避免选择器底部超出视口被裁切。 */
function openTablePicker(): void {
  const ed = editor.value;
  if (!ed) return;
  const coords = ed.view.coordsAtPos(ed.state.selection.from);
  // 选择器预估高度：10 行 × (16+2)px + padding/label ≈ 230px
  const PICKER_H = 240;
  const spaceBelow = window.innerHeight - coords.bottom;
  const placeAbove = spaceBelow < PICKER_H && coords.top > PICKER_H;
  tablePickerPos.value = {
    x: coords.left,
    y: placeAbove ? coords.top - PICKER_H - 6 : coords.bottom + 6,
  };
  tablePickerVisible.value = true;
}

/** 行列选择器确认：插入指定大小表格并关闭 */
function onPickTableSize(rows: number, cols: number): void {
  editor.value?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
  tablePickerVisible.value = false;
}

/** 选择器点外部关闭 */
function onTablePickerOutside(e: MouseEvent): void {
  if (!tablePickerVisible.value) return;
  const pop = document.querySelector(".rt-table-picker");
  if (pop && !pop.contains(e.target as Node)) {
    tablePickerVisible.value = false;
  }
}

/** 编辑器 wrapper 上的 contextmenu：若 target 在表格内，阻止默认 + 弹菜单 */
function onEditorContextMenu(e: MouseEvent): void {
  const ed = editor.value;
  if (!ed) return;
  const target = e.target as HTMLElement | null;
  if (!target) return;
  // 判断点击是否在表格相关元素上
  if (target.closest("table, td, th")) {
    e.preventDefault();
    tableContextMenuPos.value = { x: e.clientX, y: e.clientY };
    tableContextMenuVisible.value = true;
  }
}

/** 表格右键菜单的命令执行后关闭菜单 */
function runTableCommand(fn: (ed: NonNullable<TiptapEditor>) => void): void {
  const ed = editor.value;
  if (ed) fn(ed);
  tableContextMenuVisible.value = false;
}

/* === 图片 hover 放大镜状态 ===
   鼠标悬浮在 [data-resize-container] 上时，右上角浮现按钮；
   点击按钮才打开 lightbox（直接点图片进入 ProseMirror 选中态，不再触发预览）。
   性能关键点：
   ① 按钮 DOM 始终存在，仅切 opacity/visibility，避免显隐切换时 v-if 重建节点卡顿；
   ② 拖拽放大/缩小图片时按钮要跟随 —— 用 ResizeObserver + 容器 Resize 监听。 */
const hoveredContainer = ref<HTMLElement | null>(null);
const hoverBtnPos = ref<{ top: number; right: number } | null>(null);
/** 按钮 DOM 始终存在；visibility 控制是否显示（透明时不点击） */
const zoomBtnMounted = ref(false);
const zoomBtnVisible = ref(false);
/** 拖拽 resize 把手期间 —— 按钮隐藏，避免误触 */
const isResizing = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let containerResizeObs: ResizeObserver | null = null;
let contentScrollEl: HTMLElement | null = null;
let contentScrollHandler: (() => void) | null = null;

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    zoomBtnVisible.value = false;
    hoveredContainer.value = null;
    hoverBtnPos.value = null;
    hideTimer = null;
  }, 150);
}
function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/** 重算按钮位置（hover 进入 / 滚动 / 拖拽改变图片尺寸时调用） */
function updateBtnPos() {
  const c = hoveredContainer.value;
  if (!c) return;
  const r = c.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return; // 图像不可见
  hoverBtnPos.value = {
    top: r.top + 8,
    right: window.innerWidth - r.right + 8,
  };
}

/** 释放所有跟随监听（在 hover 真正结束时调用） */
function detachContainerTracking() {
  if (containerResizeObs) {
    containerResizeObs.disconnect();
    containerResizeObs = null;
  }
  if (contentScrollEl && contentScrollHandler) {
    contentScrollEl.removeEventListener("scroll", contentScrollHandler, true);
    contentScrollEl = null;
    contentScrollHandler = null;
  }
}

/** 在 hover 进入时挂上"图片尺寸变化时同步按钮位置"的监听
   —— 拖拽 resize 手柄时图片大小持续变，按钮要跟随 */
function attachContainerTracking(c: HTMLElement) {
  detachContainerTracking();
  if (typeof ResizeObserver !== "undefined") {
    containerResizeObs = new ResizeObserver(() => updateBtnPos());
    containerResizeObs.observe(c);
  }
  // 编辑器可能在滚动容器里（详情面板）；监听滚动容器的滚动
  let scrollParent: HTMLElement | null = c.parentElement;
  while (scrollParent && scrollParent !== document.body) {
    const cs = getComputedStyle(scrollParent);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
      contentScrollEl = scrollParent;
      contentScrollHandler = () => updateBtnPos();
      contentScrollEl.addEventListener("scroll", contentScrollHandler, true);
      break;
    }
    scrollParent = scrollParent.parentElement;
  }
}

/** handle 的 mousedown/touchstart —— 标记开始拖拽
   （用 capture 阶段抢先，让 tiptap 也能收到事件不会被我们吞掉）*/
function onResizeHandlePointerDown(e: PointerEvent | TouchEvent | MouseEvent) {
  const target = (e.target as HTMLElement) || null;
  if (!target || !target.closest("[data-resize-handle]")) return;
  isResizing.value = true;
  // 立即隐藏放大镜（不依赖 mouseover 重新评估）
  zoomBtnVisible.value = false;
  // mouseup 时恢复：监听一次 window
  const restore = () => {
    isResizing.value = false;
    window.removeEventListener("mouseup", restore, true);
    window.removeEventListener("touchend", restore, true);
    window.removeEventListener("touchcancel", restore, true);
    // 如果鼠标还在图片上，恢复按钮显示
    if (hoveredContainer.value && zoomBtnMounted.value) {
      zoomBtnVisible.value = true;
    }
  };
  window.addEventListener("mouseup", restore, true);
  window.addEventListener("touchend", restore, true);
  window.addEventListener("touchcancel", restore, true);
}

function onEditorMouseOver(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  const c = t?.closest<HTMLElement>("[data-resize-container]");
  if (!c) return;
  cancelHide();
  hoveredContainer.value = c;
  updateBtnPos();
  zoomBtnMounted.value = true;
  // 正在拖拽 resize 手柄时不显示（避免误点）
  zoomBtnVisible.value = !isResizing.value;
  attachContainerTracking(c);
}

function onEditorMouseOut(e: MouseEvent) {
  const next = e.relatedTarget as HTMLElement | null;
  // 鼠标在容器内不同子元素间移动：不处理
  if (next && next.closest("[data-resize-container]") === hoveredContainer.value) return;
  // 鼠标进入放大镜按钮本身：保持显示
  if (next && next.closest(".rich-text__image-zoom-btn")) {
    cancelHide();
    return;
  }
  scheduleHide();
}

function onZoomBtnMouseEnter() {
  cancelHide();
}
function onZoomBtnMouseLeave(e: MouseEvent) {
  const next = e.relatedTarget as HTMLElement | null;
  if (next && next.closest(".rich-text__image-zoom-btn")) return;
  // 离开按钮且没回到 image 容器，延迟隐藏
  if (next && next.closest("[data-resize-container]") === hoveredContainer.value) {
    // 鼠标很快回到图片则保持显示
    cancelHide();
    return;
  }
  scheduleHide();
}

function onZoomBtnClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  const c = hoveredContainer.value;
  if (!c) return;
  const img = c.querySelector("img");
  if (!img) return;
  const src = (img as HTMLImageElement).src;
  collectImages();
  const idx = allImages.value.indexOf(src);
  openPreview(idx >= 0 ? idx : 0);
  cancelHide();
  zoomBtnVisible.value = false;
}

/** 块标签集合：用于在点击左侧边缘时，按 y 坐标找到对应的块级元素 */
const BLOCK_TAGS = ["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE"];

/**
 * 修复「点击编辑器内容区左侧 padding 带无法定位光标到行首」：
 *
 * 详情面板用 borderless 模式，编辑器 wrapper 左侧有 24px padding（给块拖拽手柄让位）。
 * 用户点这块 padding 区时，ProseMirror 的 posAtCoords 把落点解析给相邻块或文档根，
 * 光标落不到「想点的那个块」的开头，表现为「第一行写完后无法在它前面加内容」。
 *
 * 策略：在编辑器 dom 上监听 mousedown（capture，抢在 ProseMirror 之前），
 * 若点击 x 落在内容区最左边一带，按点击的 y 坐标找到垂直方向上对应的块级元素，
 * 把光标设到该块内容开头并阻止默认点击（不让 ProseMirror 再把光标挪走）。
 */
function onEditorGutterMouseDown(e: MouseEvent): void {
  const ed = editor.value;
  const pmDom = ed?.view?.dom;
  if (!ed || !pmDom) return;
  // 仅处理点击在 .ProseMirror 自身或其内部（编辑器内容区）
  if (!pmDom.contains(e.target as Node) && e.target !== pmDom) return;

  const contentRect = pmDom.getBoundingClientRect();
  // 点击 x 在内容区最左边缘带内（左侧 6px 范围）才接管
  if (e.clientX > contentRect.left + 6) return;

  // 按点击的 y 坐标，找垂直方向上命中的块级元素
  const blocks = Array.from(pmDom.querySelectorAll<HTMLElement>(BLOCK_TAGS.join(",")));
  const hit = blocks.find((el) => {
    const r = el.getBoundingClientRect();
    return e.clientY >= r.top && e.clientY <= r.bottom;
  });
  if (!hit) return;

  // 找到该块 DOM 对应的文档位置，定位光标到块内开头
  // posAtDOM(块, 0) 返回块内第一个可定位位置（已跳过块开始标记）
  const blockInnerStart = ed.view.posAtDOM(hit, 0);
  if (blockInnerStart == null || blockInnerStart < 0) return;
  e.preventDefault();
  ed.chain().focus().setTextSelection(blockInnerStart).run();
}

onMounted(() => {
  // ESC / 方向键：用 capture 阶段抢在 AppLayout 之前处理，
  // 防止 lightbox 关闭时顺带把详情面板也关了
  window.addEventListener("keydown", onPreviewKeydown, { capture: true });
  // 表格行列选择器点外部关闭
  window.addEventListener("mousedown", onTablePickerOutside, true);
  // 行首左侧边缘点击修复：capture 抢在 ProseMirror 默认点击处理之前
  window.addEventListener("mousedown", onEditorGutterMouseDown, true);
  // 滚动 / 缩放窗口时同步按钮位置（按钮用了 position: fixed）
  window.addEventListener("scroll", updateBtnPos, true);
  window.addEventListener("resize", updateBtnPos);
  // 拖拽手柄的 pointerdown/touchstart —— 标记开始拖拽，按钮隐藏
  const container = editorContainerRef.value;
  if (container) {
    container.addEventListener("pointerdown", onResizeHandlePointerDown, true);
    container.addEventListener("touchstart", onResizeHandlePointerDown, true);
  }
  // 拖拽手柄 resize 期间，鼠标位置不变不触发 mouseover；
  // 用 requestAnimationFrame 持续跟随：仅在按钮可见时跑
  const tick = () => {
    if (zoomBtnVisible.value && hoveredContainer.value) {
      updateBtnPos();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  cancelHide();
  detachContainerTracking();
  window.removeEventListener("keydown", onPreviewKeydown, { capture: true } as any);
  window.removeEventListener("mousedown", onTablePickerOutside, true);
  window.removeEventListener("mousedown", onEditorGutterMouseDown, true);
  window.removeEventListener("scroll", updateBtnPos, true);
  window.removeEventListener("resize", updateBtnPos);
  const container = editorContainerRef.value;
  if (container) {
    container.removeEventListener("pointerdown", onResizeHandlePointerDown, true);
    container.removeEventListener("touchstart", onResizeHandlePointerDown, true);
  }
  editor.value?.destroy();
});

/** 收集编辑器中所有图片 src */
function collectImages() {
  const imgs = editorContainerRef.value?.querySelectorAll("img");
  allImages.value = imgs ? Array.from(imgs).map((img) => (img as HTMLImageElement).src) : [];
}

/** 打开 lightbox 预览第 idx 张（先收集所有图片定位下标） */
function openPreview(idx: number) {
  collectImages();
  previewIndex.value = idx;
  previewScale.value = 1;
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
  /* Lightbox 打开时，在 capture 阶段（详见 onMounted）抢在 AppLayout 之前处理，
     阻止它"关闭详情面板"。stopImmediatePropagation 让后续同阶段监听器也拿不到事件。 */
  if (e.key === "Escape") {
    e.stopImmediatePropagation();
    e.preventDefault();
    closePreview();
  } else if (e.key === "ArrowLeft") {
    e.stopImmediatePropagation();
    e.preventDefault();
    prevImage();
  } else if (e.key === "ArrowRight") {
    e.stopImmediatePropagation();
    e.preventDefault();
    nextImage();
  }
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
    <div
      ref="editorContainerRef"
      class="rich-text__editor-wrapper"
      @mouseover="onEditorMouseOver"
      @mouseout="onEditorMouseOut"
      @scroll="updateBtnPos"
      @contextmenu="onEditorContextMenu"
    >
      <!-- 富文本预览模式 -->
      <EditorContent
        :editor="editor"
        class="rich-text__editor"
        :class="{ 'rich-text__editor--hidden': sourceMode }"
      />
      <!-- 源码编辑模式：textarea 直接编辑 Markdown（opacity 过渡，不用 v-show） -->
      <textarea
        ref="sourceTextareaRef"
        v-model="sourceText"
        class="rich-text__source"
        :class="{ 'rich-text__source--visible': sourceMode }"
        placeholder="输入 Markdown 源码..."
        spellcheck="false"
      ></textarea>
      <!-- 源码/预览切换按钮（右上角浮动，</> 图标） -->
      <button
        class="rich-text__source-toggle"
        :class="{ 'rich-text__source-toggle--on': sourceMode }"
        :title="sourceMode ? '切换到富文本预览' : '切换到 Markdown 源码'"
        @click="toggleSourceMode"
      >
        <icon-code :size="14" />
      </button>
      <!-- 块拖拽手柄 + 落点横线（放在 wrapper 内、absolute 定位，hover 链不断）
           可通过 dragHandle prop 关闭（模板编辑弹窗等小场景不需要） -->
      <BlockDragHandle v-if="dragHandle && !sourceMode" :editor="editor" :on-pick-table="openTablePicker" />
    </div>

    <!-- 空段落浮 + 按钮（Notion-like 入口之一） -->
    <RichTextFloatingMenu :editor="editor" />

    <!-- 表格浮动工具条（光标在表格内时显示） -->
    <TableToolbar :editor="editor" />

    <!-- 表格行列选择器（斜杠/块手柄菜单选「表格」时弹出，选 N×N 后插入） -->
    <teleport to="body">
      <div
        v-if="tablePickerVisible"
        class="rt-table-picker"
        :style="{ left: tablePickerPos.x + 'px', top: tablePickerPos.y + 'px' }"
        @mousedown.stop
      >
        <TableSizePicker :on-pick="onPickTableSize" />
      </div>
    </teleport>

    <!-- 表格右键菜单 -->
    <ContextMenu
      v-model:visible="tableContextMenuVisible"
      :x="tableContextMenuPos.x"
      :y="tableContextMenuPos.y"
    >
      <MenuPopoverItem @click="runTableCommand((e) => e.chain().focus().addColumnBefore().run())">
        左侧插入列
      </MenuPopoverItem>
      <MenuPopoverItem @click="runTableCommand((e) => e.chain().focus().addColumnAfter().run())">
        右侧插入列
      </MenuPopoverItem>
      <MenuPopoverItem @click="runTableCommand((e) => e.chain().focus().deleteColumn().run())">
        删除列
      </MenuPopoverItem>
      <div class="detail-panel__popup-divider" />
      <MenuPopoverItem @click="runTableCommand((e) => e.chain().focus().addRowBefore().run())">
        上方插入行
      </MenuPopoverItem>
      <MenuPopoverItem @click="runTableCommand((e) => e.chain().focus().addRowAfter().run())">
        下方插入行
      </MenuPopoverItem>
      <MenuPopoverItem @click="runTableCommand((e) => e.chain().focus().deleteRow().run())">
        删除行
      </MenuPopoverItem>
      <div class="detail-panel__popup-divider" />
      <MenuPopoverItem
        :disabled="!editor?.can().mergeCells()"
        @click="runTableCommand((e) => e.chain().focus().mergeCells().run())"
      >
        合并单元格
      </MenuPopoverItem>
      <MenuPopoverItem
        :disabled="!editor?.can().splitCell()"
        @click="runTableCommand((e) => e.chain().focus().splitCell().run())"
      >
        拆分单元格
      </MenuPopoverItem>
      <MenuPopoverItem @click="runTableCommand((e) => e.chain().focus().toggleHeaderRow().run())">
        切换表头行
      </MenuPopoverItem>
      <div class="detail-panel__popup-divider" />
      <MenuPopoverItem danger @click="runTableCommand((e) => e.chain().focus().deleteTable().run())">
        删除表格
      </MenuPopoverItem>
    </ContextMenu>

    <!-- 图片 hover 放大镜按钮（fixed 定位，teleport 到 body 脱离 Tiptap 生命周期）
         节点始终挂载（避免 v-if 显隐切换重建卡顿），用 visibility + opacity 过渡控制可见性。 -->
    <teleport to="body">
      <button
        v-show="zoomBtnMounted && hoverBtnPos"
        class="rich-text__image-zoom-btn"
        :class="{ 'is-visible': zoomBtnVisible && !isResizing }"
        :style="{
          position: 'fixed',
          top: (hoverBtnPos?.top ?? -9999) + 'px',
          right: (hoverBtnPos?.right ?? 0) + 'px',
        }"
        @mouseenter="onZoomBtnMouseEnter"
        @mouseleave="onZoomBtnMouseLeave"
        @click="onZoomBtnClick"
        title="预览图片"
        aria-label="预览图片"
        tabindex="-1"
      >
        <icon-search :size="16" />
      </button>
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
  position: relative; /* 锚定源码切换按钮的 absolute 定位 */
  padding: 10px 12px;
  min-height: 160px;
  max-height: none;
  overflow-y: visible;
}

/* 源码/预览切换按钮：右上角浮动 */
.rich-text__source-toggle {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 10;
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  opacity: 0.5;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}
.rich-text__source-toggle:hover {
  opacity: 1;
  color: var(--jt-text-primary);
  background: var(--jt-surface-hover);
}
/* 源码模式激活态：常显 + 主色 */
.rich-text__source-toggle--on {
  opacity: 1;
  color: var(--jt-primary);
  background: var(--jt-accent-soft);
}

/* 源码编辑模式 textarea：等宽字体，绝对定位覆盖编辑区（高度由 JS 同步） */
.rich-text__source {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: var(--jt-surface);
  color: var(--jt-text-primary);
  font-family: var(--font-mono, "JetBrains Mono", monospace);
  font-size: 13px;
  line-height: 1.6;
  padding: 10px 12px;
  box-sizing: border-box;
  z-index: 5;
  /* 过渡：opacity 平滑淡入淡出（配合 visibility 避免隐藏时仍可交互） */
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.15s ease, visibility 0.15s ease;
}
.rich-text__source--visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
/* 富文本编辑器隐藏态（切到源码时淡出，不用 display:none 避免 editor 失活） */
.rich-text__editor--hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.15s ease, visibility 0.15s ease;
}
.rich-text__editor {
  transition: opacity 0.15s ease, visibility 0.15s ease;
}

.rich-text--borderless .rich-text__editor-wrapper {
  /* 左侧留 24px 给块拖拽手柄（absolute 定位落在 padding 内） */
  padding: 0 0 0 24px;
  min-height: 0;
  /* 手柄 absolute 定位需锚定 */
  position: relative;
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

/* 标题 — Geist 显示气质：靠字号 + 字重 + 字间距区分层级。
   选择器基于 .heading-block--h{N} class（NodeViewContent 固定渲染 div，
   tag 选择器 h1-h6 已不命中，层级样式必须走 class） */
.rich-text__editor :deep(.rich-text__content .heading-block--h1 .heading-block__content) {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.025em;
  margin: 8px 0 4px;
  line-height: 1.3;
}
.rich-text__editor :deep(.rich-text__content .heading-block--h2 .heading-block__content) {
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 6px 0 4px;
  line-height: 1.3;
}
.rich-text__editor :deep(.rich-text__content .heading-block--h3 .heading-block__content) {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.015em;
  margin: 4px 0 2px;
  line-height: 1.3;
}
.rich-text__editor :deep(.rich-text__content .heading-block--h4 .heading-block__content) {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 4px 0 2px;
  line-height: 1.3;
}
.rich-text__editor :deep(.rich-text__content .heading-block--h5 .heading-block__content) {
  font-size: 13px;
  font-weight: 600;
  margin: 4px 0 2px;
  line-height: 1.4;
}
.rich-text__editor :deep(.rich-text__content .heading-block--h6 .heading-block__content) {
  font-size: 13px;
  font-weight: 500;
  color: var(--jt-text-secondary);
  margin: 4px 0 2px;
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
  /* checkbox 与首行文字视觉中心对齐（13px 字号实测校准）：
     行高 20.8px → 行中心 10.4px；字形 ink 视觉中心偏上约 0.7px
     → 对齐点 9.7px；checkbox 14px 半高 7px → margin-top ≈ 2.1px */
  margin-top: 2.1px;
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

/* 图片 —— 直接点图片不再预览，所以不再用 zoom-in 光标 */
.rich-text__editor :deep(.rich-text__content img) {
  border-radius: 6px;
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

/* 选中状态：线框紧贴图片（贴在图片本身外侧），不在 container 最外层。
   - wrapper 收敛成 img 大小（display:block + font-size:0 消除行盒间隙）
   - "线"画在 wrapper 上，恰好框住图片
   - img 本身保持原样（不加 border-radius，不影响图片内容）
   - 没有阴影、没有 halo、没有主题色贴边，参考「线框标注」范式
   - 同时覆盖 tiptap 在未选中时强加的内联 visibility/pointer-events */
.rich-text__editor :deep([data-resize-container].ProseMirror-selectednode),
.rich-text__editor :deep([data-resize-container].ProseMirror-selectednode[style*="visibility"]) {
  visibility: visible !important;
  pointer-events: auto !important;
}

/* 选中时 wrapper 收敛为 img 精确尺寸 + padding 让"线"在图片外、有 padding 撑出空间
   矩形外框线 = wrapper 的 border；
   手柄位于 wrapper 四角 absolute 0,0 = 圆点中心正好坐在矩形外侧角上 */
.rich-text__editor :deep([data-resize-container].ProseMirror-selectednode [data-resize-wrapper]) {
  display: block;
  font-size: 0;
  line-height: 0;
  padding: 3px;          /* 撑大 wrapper，让边框离图片有 7px 间距（圆点半径） */
  border: 1px solid #cbd5e1;
  border-radius: 0;
  background-clip: padding-box;
}

/* 选中时图片不加圆角（保持原始矩形）—— 圆角由外层 wrapper 的 border 接管 */

/* resize 手柄（四角）—— 默认隐藏，仅在图片被选中时显示。
   设计：白底包边 + 主题色实心圆，14px 直径（比图片线粗得多，醒目控制点）。
   用 box-shadow 而不是 border 模拟"白圈"，避免 border-box 影响尺寸计算。 */
.rich-text__editor :deep([data-resize-handle]) {
  width: 14px !important;
  height: 14px !important;
  background-color: var(--jt-primary) !important;
  border: none !important;
  border-radius: 50% !important;
  box-shadow:
    0 0 0 2px #fff,    /* 内层白圈，模拟"白色包边" */
    0 1px 3px rgba(0, 0, 0, 0.2);
  z-index: 20;
  /* 默认隐藏 */
  opacity: 0;
  pointer-events: none;
  /* 把圆点中心拉到 wrapper 角正中（即"骑在边框角上"）——
     tiptap 在 positionHandle 时只写 top/left/right/bottom=0，
     圆点 box 左上角 = 框角；这里反方向偏移自身一半（7px）让中心对齐框角。 */
  margin: -7px;
  transition: opacity 0.1s ease;
}

/* 选中图片时显示四角手柄 */
.rich-text__editor :deep([data-resize-container].ProseMirror-selectednode [data-resize-handle]) {
  opacity: 1;
  pointer-events: auto;
}

/* 四角对角线 cursor：按手柄在容器中的位置（top/bottom × left/right）匹配
   tiptap 实际写入的内联样式是 `top: 0` / `left: 0` 等
   （见 node_modules/@tiptap/core/src/lib/ResizableNodeView.ts:626-647）。 */
/* 左上、右下：↖↘ */
.rich-text__editor :deep([data-resize-handle][style*="top: 0"][style*="left: 0"]),
.rich-text__editor :deep([data-resize-handle][style*="bottom: 0"][style*="right: 0"]) {
  cursor: nwse-resize;
}
/* 右上、左下：↗↙ */
.rich-text__editor :deep([data-resize-handle][style*="top: 0"][style*="right: 0"]),
.rich-text__editor :deep([data-resize-handle][style*="bottom: 0"][style*="left: 0"]) {
  cursor: nesw-resize;
}

/* 边手柄 = 横 / 竖光标（用属性相等 + !important 压过角 cursor 选择器） */
.rich-text__editor :deep([data-resize-handle="top"]),
.rich-text__editor :deep([data-resize-handle="bottom"]) {
  cursor: ns-resize !important;
}
.rich-text__editor :deep([data-resize-handle="left"]),
.rich-text__editor :deep([data-resize-handle="right"]) {
  cursor: ew-resize !important;
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

/* 标题折叠：被 HeadingFold 的 Decoration 标记的块整体隐藏 */
.rich-text__editor :deep(.heading-fold-hidden) {
  display: none !important;
}

/* ─── 表格 ──────────────────────────────────── */
.rich-text__editor :deep(.rich-text__content table) {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  margin: 8px 0;
  overflow: hidden;
}
.rich-text__editor :deep(.rich-text__content td),
.rich-text__editor :deep(.rich-text__content th) {
  border: 1px solid var(--jt-border);
  padding: 6px 10px;
  vertical-align: top;
  box-sizing: border-box;
  position: relative;
  min-width: 60px;
}
.rich-text__editor :deep(.rich-text__content th) {
  background: var(--jt-surface-sunken);
  font-weight: 600;
  text-align: left;
}
.rich-text__editor :deep(.rich-text__content p) {
  margin: 0;
}
/* 选中单元格高亮（Tiptap 给选中 cell 加 .selectedCell） */
.rich-text__editor :deep(.rich-text__content .selectedCell::after) {
  content: "";
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--jt-primary) 12%, transparent);
  pointer-events: none;
}
/* 表头列/行切换态（Tiptap 加 .isHeader） */
.rich-text__editor :deep(.rich-text__content th.isHeader) {
  background: color-mix(in srgb, var(--jt-primary) 10%, var(--jt-surface-sunken));
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

/* 图片 hover 放大镜按钮 —— teleport 到 body，fixed 定位 + 圆角胶囊
   节点默认隐藏（visibility:hidden + opacity:0），不占用 GPU ；
   加 .is-visible 后开启过渡显示。 */
.rich-text__image-zoom-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--jt-border, #e5e7eb);
  border-radius: 9999px;     /* 胶囊圆角 */
  background: #fff !important;
  color: var(--jt-primary);
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
  z-index: 9999;
  /* 默认隐藏（透明 + 不可点击，避免拖拽时按钮"跳出来"误触发） */
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  will-change: opacity, transform, top, right;
  transition:
    opacity 0.12s ease,
    visibility 0.12s ease,
    background 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.12s ease;
}
.rich-text__image-zoom-btn.is-visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
.rich-text__image-zoom-btn.is-visible:hover {
  background: #fafafa !important;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
  transform: scale(1.05);
}
.rich-text__image-zoom-btn.is-visible:active {
  transform: scale(0.96);
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

/* 表格行列选择器浮层（斜杠/块手柄菜单触发） */
.rt-table-picker {
  position: fixed;
  z-index: 1200;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
}
</style>
