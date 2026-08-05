// 代码块扩展 —— 继承 CodeBlockLowlight，新增：
//   1. folded 布尔 attribute（持久化折叠状态到文档 HTML）
//   2. 自定义 NodeView（CodeBlockView：语言切换 + 复制 + 折叠按钮）
//
// 高亮由 CodeBlockLowlight 内置的 LowlightPlugin 通过 Decoration.inline 注入，
// 不依赖 NodeView，所以自定义 NodeView 保留 pre>code 结构即可不丢失高亮。
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { VueNodeViewRenderer } from "@tiptap/vue-3";
import CodeBlockView from "@/components/CodeBlockView.vue";
import { lowlight } from "./lowlight";

export const CodeBlockFold = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // 折叠状态：持久化到 HTML（data-folded 属性），刷新后保持
      folded: {
        default: false,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-folded") === "true",
        renderHTML: (attrs) => (attrs.folded ? { "data-folded": "true" } : {}),
      },
    };
  },

  addNodeView() {
    return VueNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight });

export default CodeBlockFold;
