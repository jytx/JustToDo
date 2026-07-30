// 右键菜单（contextmenu）相关工具
//
// 背景：应用内大量区域挂了「自定义右键菜单」（任务项 / 侧边栏 / 面板空白区），
// 它们各自用 @contextmenu.prevent 拦截了原生右键。但仍有不少区域（设置页、习惯页、
// 日历页、按钮、图标等）没挂自定义右键，会弹出 webview 原生右键（Reload / Inspect
// Element / Save As 等），体验割裂。
//
// 本模块提供「是否放行原生右键」的统一判定 + 全局兜底拦截，两处逻辑共享同一份规则（DRY）。

/**
 * 判定右键目标是否应放行系统原生菜单。
 *
 * 仅在以下可编辑元素上放行（保留复制 / 粘贴 / 拼写检查 / 粘贴图片等系统能力）：
 *   - <input>、<textarea>
 *   - contentEditable 元素（Tiptap 富文本编辑器即属此类）
 *
 * 其余元素一律拦截原生右键，交给各区域的自定义菜单或直接吞掉。
 * 纯函数：仅读 target 属性，不修改任何状态。
 */
export function shouldReserveNativeMenu(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}

/**
 * 全局 contextmenu 事件兜底处理器：拦截所有非可编辑区域的原生右键菜单。
 *
 * 在 main.ts 注册：window.addEventListener("contextmenu", disableNativeContextMenu)。
 * 不阻止冒泡（不调用 stopPropagation），已挂自定义右键的元素（任务项等）通过
 * 自身的 @contextmenu.prevent 完成拦截，此兜底只在事件未被处理时生效，
 * 不会与现有自定义右键产生冲突。
 */
export function disableNativeContextMenu(e: MouseEvent): void {
  if (shouldReserveNativeMenu(e.target)) return;
  e.preventDefault();
}
