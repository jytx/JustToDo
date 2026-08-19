// Tab 转无序列表扩展 —— 选中多行文字后按 Tab，把选中的行整体转为无序列表。
//
// 行为约定（Notion 风格）：
//   - 选区非空、且选区覆盖的块全部是普通文本块（段落/标题）时，
//     按 Tab 将这些行整体转成无序列表；
//   - 选区在列表/代码块/表格/引用等结构内时不接管，保留 Tab 原有语义
//     （列表内 Tab=缩进 sinkListItem、代码块内 Tab=插入缩进）；
//   - 斜杠命令菜单打开时 Tab 是菜单导航键（见 SlashCommandMenu），跳过转换；
//   - Shift+Tab 不处理（列表内默认为提升层级 liftListItem）。
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

/** 允许被 Tab 转成列表的块类型：普通段落 + 标题 */
const CONVERTIBLE_BLOCK_NAMES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
]);

/**
 * 判断选区覆盖的块是否全部为可转换的普通文本块。
 *
 * nodesBetween 会遍历选区内所有层级的节点（含祖先容器），因此选区若
 * 在列表/表格/引用内，收集结果必然混入 listItem/bulletList 等容器类型，
 * 据此返回 false 让 Tab 走默认行为，避免破坏缩进等原生语义。
 */
function isSelectionAllConvertible(
  from: number,
  to: number,
  doc: PMNode,
): boolean {
  const blockNames = new Set<string>();
  doc.nodesBetween(from, to, (node: PMNode) => {
    // doc 根节点与任意选区都相交，但它不是内容块，跳过
    if (node.isBlock && node.type.name !== "doc") {
      blockNames.add(node.type.name);
    }
    return true;
  });
  if (blockNames.size === 0) return false;
  for (const name of blockNames) {
    if (!CONVERTIBLE_BLOCK_NAMES.has(name)) return false;
  }
  return true;
}

/** 「多选文字按 Tab 转无序列表」扩展（无选项、无状态，纯按键绑定） */
export const TabToList = Extension.create({
  name: "tabToList",

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const { editor } = this;
        // 斜杠命令菜单打开时，Tab 归菜单导航使用，不接管转换。
        // Suggestion 插件是后注册的，其 onKeyDown 排在本扩展之后，
        // 所以必须在这里主动让路，否则菜单内 Tab 选项会失效。
        if (document.querySelector('[data-slash-menu="1"]')) return false;

        const { state } = editor.view;
        const { from, to, empty } = state.selection;
        // 未选中文字（光标 collapsed）时不接管
        if (empty) return false;

        if (!isSelectionAllConvertible(from, to, state.doc)) return false;

        // 走到这里选区必不在列表中，toggleBulletList 只会走 wrap 路径：
        // 选区覆盖的每个段落/标题各成一个列表项，包进同一个无序列表
        return editor.chain().focus().toggleBulletList().run();
      },
    };
  },
});
