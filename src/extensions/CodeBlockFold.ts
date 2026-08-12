// 代码块扩展 —— 继承 CodeBlockLowlight，新增：
//   1. folded 布尔 attribute（持久化折叠状态到文档 HTML）
//   2. 自定义 NodeView（CodeBlockView：语言切换 + 复制 + 折叠按钮）
//   3. 重写 lowlight plugin：language 为 null 时跳过 highlightAuto，
//      避免大代码块（8K+字符）每次输入都跑全语言匹配导致严重卡顿。
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { VueNodeViewRenderer } from "@tiptap/vue-3";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findChildren } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import CodeBlockView from "@/components/CodeBlockView.vue";
import { lowlight } from "./lowlight";

const CODEBLOCK_NAME = "codeBlock";

/** lowlight 返回的 HAST 节点（简化类型） */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  className?: string;
  children?: HastNode[];
}

/**
 * 递归遍历 lowlight HAST 树，扁平化成 { text, classes } 列表。
 * （与 CodeBlockLowlight 内置 parseNodes 逻辑等价）
 */
function parseNodes(
  nodes: HastNode[],
  classes: string[] = [],
): { text: string; classes: string[] }[] {
  const result: { text: string; classes: string[] }[] = [];
  for (const node of nodes) {
    const nodeClasses = node.className ? [...classes, node.className] : classes;
    if (node.children && node.children.length > 0) {
      result.push(...parseNodes(node.children, nodeClasses));
    } else if (node.value) {
      result.push({ text: node.value, classes: nodeClasses });
    }
  }
  return result;
}

/**
 * 计算代码块的高亮 decorations。
 * 与上游 getDecorations 的关键区别：language 为 null 时**跳过高亮**，
 * 避免对大块纯文本跑 highlightAuto（尝试 35 种语言，8K 字符约 500ms）。
 */
function getDecorationsFor(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  findChildren(doc, (node) => node.type.name === CODEBLOCK_NAME).forEach((block) => {
    const language = block.node.attrs.language as string | null;
    if (!language) return; // 无语言跳过高亮
    const from = block.pos + 1;
    const result = lowlight.highlight(language, block.node.textContent);
    const parsed = parseNodes((result.children as HastNode[]) || []);
    let pos = from;
    for (const node of parsed) {
      const to = pos + node.text.length;
      if (node.classes.length) {
        decorations.push(
          Decoration.inline(pos, to, { class: node.classes.join(" ") }),
        );
      }
      pos = to;
    }
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * 判断 transaction 是否需要重新计算高亮（复用上游 LowlightPlugin 的条件）。
 */
function shouldRecompute(
  tr: { docChanged: boolean; steps: { getMap(): number[] }[]; mapping: unknown },
  oldState: EditorState,
  newState: EditorState,
): boolean {
  const oldNodeName = oldState.selection.$head.parent.type.name;
  const newNodeName = newState.selection.$head.parent.type.name;
  const oldNodes = findChildren(oldState.doc, (n) => n.type.name === CODEBLOCK_NAME);
  const newNodes = findChildren(newState.doc, (n) => n.type.name === CODEBLOCK_NAME);
  if (!tr.docChanged) return false;
  if ([oldNodeName, newNodeName].includes(CODEBLOCK_NAME)) return true;
  if (newNodes.length !== oldNodes.length) return true;
  return tr.steps.some((step: { getMap(): number[] }) => {
    // step.getMap() 返回 [oldFrom, oldTo, newFrom, newTo] 数组
    const map = step.getMap();
    const from = map[0];
    const to = map[1];
    return newNodes.some(
      (node) => node.pos >= from && node.pos + node.node.nodeSize <= to,
    );
  });
}

/**
 * 优化的 lowlight plugin：跳过无语言代码块的高亮。
 */
function OptimizedLowlightPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("lowlight-optimized"),
    state: {
      init: (_config, state: EditorState) => getDecorationsFor(state.doc),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apply: (tr: any, oldSet: DecorationSet, oldState: EditorState, newState: EditorState) => {
        if (shouldRecompute(tr, oldState, newState)) {
          return getDecorationsFor(newState.doc);
        }
        return oldSet.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state: EditorState) {
        return this.getState(state);
      },
    },
  });
}

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

  // 重写 lowlight plugin：用优化版替换 CodeBlockLowlight 内置的 LowlightPlugin。
  // 内置版在 language=null 时跑 highlightAuto，对大代码块（8K+字符）导致每次
  // 输入卡顿 500ms+。优化版跳过无语言代码块的高亮。
  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() || [];
    // 过滤掉父类的内置 LowlightPlugin（key 以 "lowlight" 开头）
    const filtered = parentPlugins.filter(
      (p) => !(p as unknown as { key?: { key?: string } }).key?.key?.startsWith("lowlight"),
    );
    return [...filtered, OptimizedLowlightPlugin()];
  },

  addNodeView() {
    const editor = this.editor;
    return VueNodeViewRenderer(CodeBlockView, {
      // IME composition（中文输入法）期间跳过 Vue 组件重渲染。
      update: ({ updateProps }): boolean => {
        if (editor.view.composing) {
          return true;
        }
        updateProps();
        return true;
      },
    });
  },
}).configure({
  lowlight,
  // 关闭「连续 3 次回车自动退出代码块」——CodeBlock 的默认行为（exitOnTripleEnter:true）
  // 在长代码块里容易误触（输入空行时意外跳出），关闭后只能用方向键/Cmd+Enter 退出。
  exitOnTripleEnter: false,
});

export default CodeBlockFold;
