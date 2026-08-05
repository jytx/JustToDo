// 标题折叠扩展 —— 给 Heading 加：
//   1. folded 布尔 attribute（持久化到 HTML）
//   2. 自定义 NodeView（HeadingView：左侧折叠三角按钮）
//   3. ProseMirror Plugin：当标题 folded=true 时，用 Decoration 给
//      「该标题之后、直到下一个同级或更高级标题之前」的所有块加
//      .heading-fold-hidden class（CSS 隐藏），不修改文档结构。
//
// 折叠区间算法：遍历顶层块，对每个 folded 的 heading(level=L)，
// 找到其后第一个 level<=L 的 heading，二者之间的顶层块全部隐藏。
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { VueNodeViewRenderer } from "@tiptap/vue-3";
import { Heading } from "@tiptap/extension-heading";
import HeadingView from "@/components/HeadingView.vue";

/** 折叠 Decoration 的 pluginKey（独立于其他插件） */
const foldPluginKey = new PluginKey<DecorationSet>("headingFold");

/** 计算需要隐藏的块区间：返回 Decoration 数组（每个隐藏块一条 node decoration） */
function buildFoldDecorations(doc: any): Decoration[] {
  const decorations: Decoration[] = [];
  // 顶层块收集（带各自在 doc 中的绝对 pos）
  const topBlocks: { node: any; pos: number }[] = [];
  let offset = 0;
  doc.forEach((child: any) => {
    topBlocks.push({ node: child, pos: offset });
    offset += child.nodeSize;
  });

  // 对每个 folded 的 heading，确定其折叠区间并给其中各块加隐藏 class
  for (let i = 0; i < topBlocks.length; i++) {
    const { node } = topBlocks[i];
    if (node.type.name !== "heading" || !node.attrs.folded) continue;
    const level = node.attrs.level as number;

    // 找下一个同级或更高级（level 更小）的 heading 作为区间终点
    let endIdx = topBlocks.length;
    for (let j = i + 1; j < topBlocks.length; j++) {
      const next = topBlocks[j].node;
      if (
        next.type.name === "heading" &&
        (next.attrs.level as number) <= level
      ) {
        endIdx = j;
        break;
      }
    }
    // 给 (i, endIdx) 区间内的顶层块整块加隐藏 decoration
    for (let k = i + 1; k < endIdx; k++) {
      const b = topBlocks[k];
      decorations.push(
        Decoration.node(b.pos, b.pos + b.node.nodeSize, {
          class: "heading-fold-hidden",
        }),
      );
    }
  }
  return decorations;
}

export const HeadingFold = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // 折叠状态：持久化到 HTML（data-folded），刷新后保持
      folded: {
        default: false,
        parseHTML: (el) =>
          (el as HTMLElement).getAttribute("data-folded") === "true",
        renderHTML: (attrs) => (attrs.folded ? { "data-folded": "true" } : {}),
      },
    };
  },

  addNodeView() {
    return VueNodeViewRenderer(HeadingView);
  },

  addProseMirrorPlugins() {
    const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
      key: foldPluginKey,
      state: {
        init: (_config, { doc }) =>
          DecorationSet.create(doc, buildFoldDecorations(doc)),
        apply: (transaction, oldDecorations) => {
          // 文档变化（含 folded attribute 切换）时重建；否则随 mapping 平移
          if (transaction.docChanged) {
            return DecorationSet.create(
              transaction.doc,
              buildFoldDecorations(transaction.doc),
            );
          }
          return oldDecorations.map(transaction.mapping, transaction.doc);
        },
      },
      props: {
        decorations: (state: any) => foldPluginKey.getState(state),
      },
    });
    return [plugin];
  },
});

export default HeadingFold;

