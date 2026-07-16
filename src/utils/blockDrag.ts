// 富文本"块拖拽"纯函数 —— 仅依赖 ProseMirror/Tiptap 类型，不持有状态。
// 与 useBlockDrag.ts（状态机）和 BlockDragHandle.vue（UI）配套。
//
// 这里的"块"特指 doc 的顶层子节点（段落/标题/代码块/引用/列表/图片等），
// 不处理列表项（li）等嵌套块的内部重排。

import type { EditorView } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";

/** 落点：插到第 blockIndex 个顶层块之前（insertBefore=true）或之后 */
export interface DropTarget {
  /** 目标顶层块在 doc 中的索引 */
  blockIndex: number;
  /** true=插到该块前面，false=插到该块后面（即下一个块前面） */
  insertBefore: boolean;
}

/** 顶层块的位置区间 [start, end)（end = start + nodeSize） */
export interface BlockRange {
  index: number;
  start: number;
  end: number;
  /** 该块的 DOM 节点（可能为 null，如 NodeView 透明节点） */
  dom: Node | null;
}

/**
 * 计算第 index 个顶层块的起始 pos（doc 内容坐标，从 0 起）。
 * 等价于 doc.resolve(0).posAtIndex(index)，用累加 nodeSize 更直观。
 */
export function posOfTopChild(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) {
    pos += doc.child(i).nodeSize;
  }
  return pos;
}

/**
 * 根据 pos 找到它所属的顶层块索引。
 * - pos 落在某块内 → 返回该块索引
 * - pos 落在块间隙（resolve 后 depth=0）→ 返回 nodeAfter 的索引（缝隙后那个块）
 * - pos 在文档最末尾的缝隙 → 返回最后一个块索引
 */
export function topChildIndexAtPos(doc: PmNode, pos: number): number {
  const $pos = doc.resolve(pos);
  if ($pos.depth >= 1) {
    return $pos.index(0);
  }
  // depth === 0：处于顶层缝隙，nodeAfter 即缝隙后的块
  // index(0) 在缝隙位置正好是"下一个块"的索引
  return $pos.index(0);
}

/**
 * 收集当前 doc 所有顶层块的区间 + DOM。
 * 用于命中测试（鼠标出编辑器时的兜底定位）。
 */
export function collectTopBlocks(view: EditorView): BlockRange[] {
  const doc = view.state.doc;
  const blocks: BlockRange[] = [];
  let pos = 0;
  doc.forEach((node, _offset, index) => {
    blocks.push({
      index,
      start: pos,
      end: pos + node.nodeSize,
      dom: view.nodeDOM(pos),
    });
    pos += node.nodeSize;
  });
  return blocks;
}

/**
 * 根据鼠标坐标计算落点（按块上下半判定）。
 *
 * 双路径：
 *  1. 优先 view.posAtCoords（鼠标在编辑器内时精准）
 *  2. 兜底：鼠标出编辑器时，遍历顶层块用 coordsAtPos 拿矩形做 Y 命中测试
 *
 * 返回 null 表示文档为空或无法定位。
 */
export function findDropTarget(
  view: EditorView,
  clientX: number,
  clientY: number,
): DropTarget | null {
  const doc = view.state.doc;
  if (doc.childCount === 0) return null;

  // 路径 1：posAtCoords（编辑器内精准定位）
  const coords = view.posAtCoords({ left: clientX, top: clientY });
  if (coords) {
    const idx = topChildIndexAtPos(doc, coords.pos);
    // 边界：pos 落在最后一个块之后
    const safeIdx = Math.min(idx, doc.childCount - 1);
    const blockStart = posOfTopChild(doc, safeIdx);
    const dom = view.nodeDOM(blockStart);
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      // 鼠标在块上半 → 插它前面；下半 → 插它后面
      return { blockIndex: safeIdx, insertBefore: clientY < midY };
    }
    // DOM 拿不到（NodeView 透明等），退化为插该块前面
    return { blockIndex: safeIdx, insertBefore: true };
  }

  // 路径 2：鼠标出编辑器，遍历块矩形做 Y 命中测试
  return findDropTargetByRects(view, clientY);
}

/**
 * 兜底命中测试：遍历顶层块矩形，按 clientY 定位落点。
 * 鼠标在编辑器外（上下垂直拖动）也能正确判定。
 */
function findDropTargetByRects(
  view: EditorView,
  clientY: number,
): DropTarget | null {
  const doc = view.state.doc;
  const blocks = collectTopBlocks(view);

  for (const block of blocks) {
    const dom = view.nodeDOM(block.start);
    if (!(dom instanceof HTMLElement)) continue;
    const rect = dom.getBoundingClientRect();

    // 鼠标在该块上方 → 插它前面
    if (clientY < rect.top) {
      return { blockIndex: block.index, insertBefore: true };
    }
    // 鼠标在该块内 → 按中线判定前后
    if (clientY <= rect.bottom) {
      const midY = rect.top + rect.height / 2;
      return { blockIndex: block.index, insertBefore: clientY < midY };
    }
  }

  // 鼠标在所有块下方 → 插到末尾（最后一个块后面）
  return { blockIndex: doc.childCount - 1, insertBefore: false };
}

/**
 * 执行顶层块移动：把 fromIndex 的块移到目标位置。
 *
 * 位置偏移处理：用 tr.mapping.map() 把"删除前坐标系"的目标 pos 映射到
 * "删除后坐标系"，避免手算偏移出错。
 *
 * 返回构建好的 transaction（不 dispatch，由调用方决定何时派发）。
 */
export function buildMoveTransaction(
  state: EditorState,
  fromIndex: number,
  target: DropTarget,
): Transaction {
  const doc = state.doc;
  const tr = state.tr;

  const node = doc.child(fromIndex);
  const fromPos = posOfTopChild(doc, fromIndex);

  // 计算目标 pos（删除前的坐标系）
  // insertBefore=true  → 目标块的开头；insertBefore=false → 目标块的结尾
  const targetBlockIdx = Math.min(target.blockIndex, doc.childCount - 1);
  const targetBlockStart = posOfTopChild(doc, targetBlockIdx);
  const targetBlockNode = doc.child(targetBlockIdx);
  const targetPos = target.insertBefore
    ? targetBlockStart
    : targetBlockStart + targetBlockNode.nodeSize;

  // 删除源块
  tr.delete(fromPos, fromPos + node.nodeSize);

  // 把删除前的目标 pos 映射到删除后的新坐标系
  // 若源块在目标之前，删除会让目标前移，mapping.map 自动处理
  const mappedTarget = tr.mapping.map(targetPos);

  // 插入（在删除后的文档坐标系）
  tr.insert(mappedTarget, node);
  tr.scrollIntoView();

  return tr;
}

/**
 * 判断两个落点是否等价（避免相同落点重复 dispatch 无意义事务）。
 */
export function sameDropTarget(a: DropTarget, b: DropTarget): boolean {
  return a.blockIndex === b.blockIndex && a.insertBefore === b.insertBefore;
}
