// 编辑器失焦后的 Cmd+Z 兜底转发 + 原生菜单撤销/重做统一分发
//
// 背景 1（失焦失效）：Tiptap 的 undo/redo 快捷键绑定在编辑器 DOM 上，焦点不在
// 编辑器内时 Cmd+Z 完全无效。而"粘贴/编辑后点了工具栏按钮、块手柄菜单、代码
// 块语言下拉"等交互都会把焦点带走 —— undo 栈明明完好，按键却到不了编辑器。
//
// 背景 2（两套 undo 栈不同步）：macOS 上 Cmd+Z 被原生菜单的预定义 Undo 项接管，
// 走 WKWebView 原生 undo 栈 —— 它只记录 WebKit 自己执行的编辑（输入法输入等）；
// 而 ProseMirror 的粘贴/命令走事务路径不进这个栈。两套栈不同步，表现为
// 「粘贴进代码块的内容 Cmd+Z 撤不掉」（WebKit 栈撤空后不再派发 beforeinput，
// PM 里的记录等不到按键）。因此菜单改为自定义项 emit 事件（menu-undo/redo），
// 由本模块按焦点位置统一分发。
import type { Editor } from "@tiptap/core";
import { listen } from "@tauri-apps/api/event";

/** 最近一个失焦的编辑器（焦点回归编辑器时清空，交还 Tiptap 自身 keymap） */
let lastBlurredEditor: Editor | null = null;

/** 已绑定编辑器的 DOM → 编辑器实例映射（用于从焦点元素反查编辑器） */
const boundEditors = new Map<HTMLElement, Editor>();

/** 原生输入类元素选择器：焦点在其中时撤销语义留给原生行为，不抢 */
const EDITABLE_TARGET_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

/** 判断是否为撤销键：Cmd/Ctrl + Z（无 Shift） */
function isUndoKey(e: KeyboardEvent): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    (e.key === "z" || e.key === "Z")
  );
}

/** 判断是否为重做键：Cmd/Ctrl + Shift + Z，或 Ctrl + Y */
function isRedoKey(e: KeyboardEvent): boolean {
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  const shiftZ =
    mod && e.shiftKey && (e.key === "z" || e.key === "Z");
  const ctrlY =
    e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "y" || e.key === "Y");
  return shiftZ || ctrlY;
}

/** 焦点是否落在原生输入类元素上（这些元素的撤销由原生行为负责） */
function focusInEditableTarget(): boolean {
  const ae = document.activeElement;
  return !!ae && ae !== document.body && !!ae.closest(EDITABLE_TARGET_SELECTOR);
}

/** 焦点元素所属的编辑器（焦点在某个已绑定的编辑器 DOM 内时返回它） */
function focusedEditor(): Editor | null {
  const ae = document.activeElement;
  if (!ae) return null;
  for (const [dom, ed] of boundEditors) {
    if (dom.contains(ae)) return ed;
  }
  return null;
}

/** 编辑器是否仍可见（详情面板/弹窗关闭后不再接管，避免撤销看不见的内容） */
function isEditorVisible(ed: Editor): boolean {
  const dom = ed.view.dom;
  return dom.isConnected && dom.offsetParent !== null;
}

/**
 * 统一的撤销/重做分发（菜单事件与本模块按键兜底共用）：
 * 1. 焦点在某编辑器内 → 该编辑器执行（与 Tiptap keymap 等价）
 * 2. 焦点在原生输入类元素 → execCommand 原生撤销（保留 input 的撤销语义）
 * 3. 其他（焦点丢失/在按钮上）→ 最近失焦且可见的编辑器执行
 */
function performUndoRedo(redo: boolean): void {
  const ed = focusedEditor();
  if (ed && !ed.isDestroyed) {
    if (redo) ed.commands.redo();
    else ed.commands.undo();
    return;
  }
  if (focusInEditableTarget()) {
    // 原生输入框（标题/检查项/搜索框等）的撤销
    document.execCommand(redo ? "redo" : "undo");
    return;
  }
  const fallback = lastBlurredEditor;
  if (fallback && !fallback.isDestroyed && isEditorVisible(fallback)) {
    if (redo) fallback.commands.redo();
    else fallback.commands.undo();
  }
}

/** window keydown 兜底：把撤销/重做转发给最近失焦且仍可见的编辑器 */
function handleUndoShortcut(e: KeyboardEvent): void {
  // 已被其他 handler（如编辑器内 Tiptap keymap）处理，跳过防重复撤销
  if (e.defaultPrevented) return;
  const undo = isUndoKey(e);
  if (!undo && !isRedoKey(e)) return;
  const ed = focusedEditor();
  if (ed && !ed.isDestroyed) return; // 焦点在编辑器内，Tiptap keymap 自己处理
  if (focusInEditableTarget()) return; // 原生输入框的撤销语义不抢
  const fallback = lastBlurredEditor;
  if (!fallback || fallback.isDestroyed || !isEditorVisible(fallback)) return;
  e.preventDefault();
  if (undo) fallback.commands.undo();
  else fallback.commands.redo();
}

// 原生菜单「编辑 → 撤销/重做」事件（menu.rs 自定义项 emit，替代预定义项的
// WebKit undo 栈路径 —— 两套栈不同步问题见文件头注释）
listen("menu-undo", () => performUndoRedo(false)).catch(() => {
  // 非 Tauri 环境（如纯浏览器调试）无事件通道，静默忽略
});
listen("menu-redo", () => performUndoRedo(true)).catch(() => {});

// window 监听引用计数：多个编辑器实例共享一个全局监听，归零时卸载
let bindCount = 0;

/**
 * 为编辑器启用失焦 undo 兜底（RichTextEditor 在 editor ready 后调用，
 * 只读实例不调用）。返回解绑函数（组件卸载 / editor 重建时调用）。
 */
export function bindEditorUndoFallback(ed: Editor): () => void {
  const onBlur = (): void => {
    // 只记录可编辑实例（只读编辑器的撤销无意义）
    if (ed.isEditable) lastBlurredEditor = ed;
  };
  const onFocus = (): void => {
    if (lastBlurredEditor === ed) lastBlurredEditor = null;
  };
  ed.on("blur", onBlur);
  ed.on("focus", onFocus);
  boundEditors.set(ed.view.dom, ed);
  if (bindCount === 0) window.addEventListener("keydown", handleUndoShortcut);
  bindCount += 1;
  return () => {
    ed.off("blur", onBlur);
    ed.off("focus", onFocus);
    boundEditors.delete(ed.view.dom);
    if (lastBlurredEditor === ed) lastBlurredEditor = null;
    bindCount -= 1;
    if (bindCount === 0) {
      window.removeEventListener("keydown", handleUndoShortcut);
    }
  };
}
