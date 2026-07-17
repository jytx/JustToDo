# TaskList 子项拖拽 —— 方案讨论

## 背景

富文本块拖拽（`a0fc401` 起的提交链）目前只支持**顶层块**重排：每个 doc 的直接子节点
（段落/标题/代码块/列表/图片）作为一个可拖拽单位。

**问题**：当 hover 在 `<ul data-type="taskList">` 内部的 `<li data-type="taskItem">` 上时，
hover 索引被算成 `taskList` 这个**父 ul** 的顶层索引——拖动手柄是 ul 整体的，
整个 ul 一起被搬走，里面的 todo 项不能单独重排。

## 目标

让 `<li>`（taskItem）作为**细粒度**的拖拽单位：

1. 鼠标 hover 在某个 taskItem 内部时，手柄显示、hover 索引指向**该 taskItem**
2. 拖动该 taskItem：在**它所属的 taskList 内部**重排（上下换位）
3. 拖动整个 taskList 仍然支持（保持现状，向后兼容）
4. 不做"把 taskItem 拖出 taskList 变成顶层块"——这超出当前需求范围

## 现状分析

当前实现的"以顶层块为中心"贯穿三个文件：

- `src/utils/blockDrag.ts`：`posOfTopChild` / `topChildIndexAtPos` / `collectTopBlocks` /
  `buildMoveTransaction` 全部假设 `doc.child(i)` 层级
- `src/composables/useBlockDrag.ts`：`hoverIndex: number`（顶层索引）、
  `currentTarget: { blockIndex: number; insertBefore: boolean }`、
  `resetHandleToHoverBlock` 用 `view.nodeDOM(posOfTopChild(...))` 拿块 DOM
- `src/components/BlockDragHandle.vue`：无逻辑，只渲染

**核心数据结构扩展**：

```ts
// 当前
interface DropTarget { blockIndex: number; insertBefore: boolean; }

// 扩展后
interface DropTarget {
  /** 顶层块索引（taskList 整体重排时使用） */
  topIndex: number;
  /** 嵌套深度：0=顶层块；1=taskItem（在某个 taskList 内） */
  depth: 0 | 1;
  /** 当 depth=1 时：所在 taskList 的 li 索引（在该 taskList 内） */
  innerIndex?: number;
  insertBefore: boolean;
}
```

## 实现方案

### Step 1: `blockDrag.ts` 扩展

**新增** `topLevelBlockInfo(doc, pos)`：

- `doc.resolve(pos)` 拿 `$pos`
- 如果 `depth >= 2` 且路径上能匹配 taskList/taskItem 节点 → 返回
  `{ topIndex, depth: 1, innerIndex }`
- 否则 → 返回 `{ topIndex: $pos.index(0), depth: 0 }`

**新增** `moveTaskItemInList(state, fromTop, fromInner, toTop, toInner, insertBefore)`：

- 在 fromTop 顶层块的 taskList 内，找到 fromInner 位置的 li
- 把它删掉、插入到目标位置
- 用 `tr.mapping.map` 处理位置偏移

**保留** `buildMoveTransaction` 走"顶层块重排"路径，向后兼容

### Step 2: `useBlockDrag.ts` 适配

- `hoverIndex` 类型改为 `TopLevelInfo`（上面那个结构），或保留 `hoverIndex: number` +
  新增 `hoverInnerIndex: number | null`
- `updateHandleOnHover` / `resetHandleToHoverBlock`：根据 `depth` 决定拿哪个 DOM
  算 rect（depth=0 拿顶层块；depth=1 拿那个 li）
- `updateDragState` 调用扩展的 `findDropTarget` 拿到 `DropTarget`
- `onDragMouseUp` 把 `currentTarget` 按 `depth` 路由到 `buildMoveTransaction` 或
  `moveTaskItemInList`
- `isNoOp` 校验要按新结构改写

### Step 3: 横线指示

`updateDragState` 算横线位置时：

- depth=0：现有逻辑（顶层块边界）
- depth=1：拿目标 li 的 `getBoundingClientRect()` 算 top/bottom

### Step 4: 测试 / 验收

- 新建一个任务，添加 taskList，至少 2 个 taskItem
- hover 第一个 taskItem，拖到第二个 taskItem 后面
- 验证：顺序交换，整个 ul 不动
- hover taskList 边缘（不是 li 内部），拖动
- 验证：整个 ul 移动
- 混合场景：拖一个 taskItem 到 ul 外（顶层块之间）——**当前阶段不支持**，
  mouseup 落点在 ul 外时退化为"整个 ul 移动到目标顶层位置"

## 风险 / 取舍

- **行为兼容性**：现有 taskList 整体拖动功能**保持不变**——是新增 depth=1 维度，
  depth=0 路径不动
- **复杂度**：代码量预计 +80~120 行（blockDrag.ts + useBlockDrag.ts）
- **schema 假设**：依赖 `@tiptap/extension-task-list` / `task-item` 节点的
  `type.name === 'taskList' / 'taskItem'`。如果以后改扩展需要重审
- **嵌套 taskList（taskItem.nested=true）**：hover 在嵌套 taskList 内的 li 时，
  depth 应该是多少？目前设计只支持 depth=1（**直接**子 taskList 的 li）；
  嵌套 li 走 depth=0 还是抛错待定。**保守做法**：嵌套 li hover 时按 depth=0
  走（hover 在外层 taskList），让用户拖外层整个 ul 重新组织——简单可控

## 不在范围内

- 把 taskItem 拖出 taskList 变成顶层块（需要节点类型转换 + 可能的 mark 保留）
- 跨 taskList 移动单个 taskItem（从一个 ul 拖到另一个 ul）——同上
- 在 ul 内部拖动时把 li 嵌套到另一个 li 下（树形重排）

这些等基础功能稳定后再考虑。

## 建议

先按本方案实施基础功能（Step 1-3），用现有 taskList 数据测试（需要先准备一个
带 taskList 的测试任务）。如果体验 OK，再考虑扩展范围。
