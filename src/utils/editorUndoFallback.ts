// 编辑器失焦后的 Cmd+Z 兜底转发
//
// 背景：Tiptap 的 undo/redo 快捷键绑定在编辑器 DOM 上，焦点不在编辑器内时
// Cmd+Z 完全无效。而"粘贴/编辑后点了工具栏按钮、块手柄菜单、代码块语言
// 下拉"等交互都会把焦点带走 —— undo 栈明明完好，按键却到不了编辑器，
// 表现为 Cmd+Z 撤销失灵（实测：栈内事件完好、undo() 功能正常、仅失焦）。
//
// 方案：记录最近一个失焦的编辑器（模块级单例，多实例时最后失焦者胜），
// 在 window 层兜底：焦点不在任何输入类元素（input/textarea/select/
// contenteditable）时，把撤销/重做按键转发给该编辑器。
import type { Editor } from "@tiptap/core";

/** 最近一个失焦的编辑器（焦点回归编辑器时清空，交还 Tiptap 自身 keymap） */
let lastBlurredEditor: Editor | null = null;

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

/** 编辑器是否仍可见（详情面板/弹窗关闭后不再接管，避免撤销看不见的内容） */
function isEditorVisible(ed: Editor): boolean {
  const dom = ed.view.dom;
  return dom.isConnected && dom.offsetParent !== null;
}

/** window keydown 兜底：把撤销/重做转发给最近失焦且仍可见的编辑器 */
function handleUndoShortcut(e: KeyboardEvent): void {
  // 已被其他 handler（如编辑器内 Tiptap keymap）处理，跳过防重复撤销
  if (e.defaultPrevented) return;
  const ed = lastBlurredEditor;
  if (!ed || ed.isDestroyed || !isEditorVisible(ed)) return;
  // 焦点在本编辑器内时由 Tiptap 自身 keymap 处理
  if (ed.view.dom.contains(document.activeElement)) return;
  if (focusInEditableTarget()) return;
  const undo = isUndoKey(e);
  if (!undo && !isRedoKey(e)) return;
  e.preventDefault();
  if (undo) ed.commands.undo();
  else ed.commands.redo();
}

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
  if (bindCount === 0) window.addEventListener("keydown", handleUndoShortcut);
  bindCount += 1;
  return () => {
    ed.off("blur", onBlur);
    ed.off("focus", onFocus);
    if (lastBlurredEditor === ed) lastBlurredEditor = null;
    bindCount -= 1;
    if (bindCount === 0) {
      window.removeEventListener("keydown", handleUndoShortcut);
    }
  };
}
