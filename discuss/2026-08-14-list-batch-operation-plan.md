# 清单 / 笔记本多选批量操作 实施计划

> 配套设计文档：`discuss/2026-08-14-list-batch-operation-design.md`
> 预计工作量：前端 5 个文件 / ~600 行；后端 0 改动

## 阶段总览

| 阶段 | 内容                                            | 验证方式                       |
| ---- | ----------------------------------------------- | ------------------------------ |
| P1   | list store 加批量状态字段 + 6 个 actions        | console 调 store 切换状态       |
| P2   | 新建 useListBatchSelect composable              | unit 调试行点击行为            |
| P3   | SidebarListNode 行点击转发 + checkbox 可视化    | 手动点击切换选中样式           |
| P4   | 新建 ListBatchContextMenu 组件                  | 手动右键弹菜单                 |
| P5   | TheSidebar 挂菜单 + subheader Cmd+A + Esc + 路由保护 | 端到端验收                |
| P6   | 批量拖拽（整组平移）                            | 拖拽验证                       |
| P7   | 集成测试 + bug 修复                             | 全场景回归                     |

---

## P1. list store 加批量状态

**目标文件**：`src/stores/list.ts`

**步骤 1.1**：在 store 顶部添加字段（紧跟 `expandedNodes` reactive 之后）

```ts
// === 多选状态（清单/笔记本批量操作；与 task.ts 的 batchSelectedIds 同构） ===
const batchSelectedIds = ref<Set<string>>(new Set());
const batchMode = ref(false);
const batchAnchorId = ref<string | null>(null);
```

**步骤 1.2**：新增 actions（参考 task.ts L863-L938）

```ts
function enterBatchMode(): void {
  batchMode.value = true;
  batchSelectedIds.value = new Set();
  batchAnchorId.value = null;
}

function exitBatchMode(): void {
  batchMode.value = false;
  batchSelectedIds.value = new Set();
  batchAnchorId.value = null;
}

function isBatchSelected(id: string): boolean {
  return batchSelectedIds.value.has(id);
}

/** 切换单条；首次自动进入多选态 */
function toggleBatchSelect(id: string): void {
  batchMode.value = true;
  const next = new Set(batchSelectedIds.value);
  if (next.has(id)) {
    next.delete(id);
    // 全清空时退出多选态
    if (next.size === 0) {
      exitBatchMode();
      return;
    }
  } else {
    next.add(id);
  }
  batchSelectedIds.value = next;
  batchAnchorId.value = id;
}

/** 范围选：以 batchAnchorId 为起点，flatIds 序列上的连续子集
 *  flatIds = 当前 subheader 可见 active 节点 DFS 序列（由 composable 传入） */
function rangeBatchSelect(flatIds: string[], id: string): void {
  batchMode.value = true;
  if (!batchAnchorId.value || flatIds.length === 0) {
    toggleBatchSelect(id);
    return;
  }
  const startIdx = flatIds.indexOf(batchAnchorId.value);
  const endIdx = flatIds.indexOf(id);
  if (startIdx < 0 || endIdx < 0) {
    toggleBatchSelect(id);
    return;
  }
  const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  const next = new Set(batchSelectedIds.value);
  for (let i = lo; i <= hi; i++) next.add(flatIds[i]);
  batchSelectedIds.value = next;
  batchAnchorId.value = id;
}

/** 全选当前 subheader 可见 active 节点（传入 flatIds） */
function selectAllBatch(flatIds: string[]): void {
  batchMode.value = true;
  batchSelectedIds.value = new Set(flatIds);
  batchAnchorId.value = flatIds[flatIds.length - 1] ?? null;
}

const batchSelectedIdsArr = computed(() => Array.from(batchSelectedIds.value));
```

**步骤 1.3**：在 `loadLists()` 末尾调 `exitBatchMode()`（旧 id 已无意义）

**步骤 1.4**：在 store return 中导出以上 7 个新增项

**⚠️ 验证**：

- 控制台调 `useListStore().toggleBatchSelect('inbox')` → `batchMode.value === true`
- 调 `exitBatchMode()` → 三字段全清
- `loadLists()` 后旧选中自动清空

---

## P2. useListBatchSelect composable

**新增文件**：`src/composables/useListBatchSelect.ts`

**结构**：与 `useBatchSelect.ts` 同构，转发到 `listStore` 而非 `taskStore`。

```ts
import { reactive, computed } from "vue";
import { useListStore } from "@/stores/list";

export interface ListBatchCtxMenu {
  visible: boolean;
  x: number;
  y: number;
}

/** 把 listTree/noteListNode 拍平成 DFS 序列（用于范围选与全选）。
 *  纯函数：只读入参 nodes，不修改。展开的子项按 tree DFS 顺序加入。 */
export function flattenActiveTree(nodes: ListTreeNode[]): string[] {
  const out: string[] = [];
  function dfs(arr: ListTreeNode[]) {
    for (const n of arr) {
      out.push(n.id);
      if (n.children.length > 0) dfs(n.children);
    }
  }
  dfs(nodes);
  return out;
}

export function useListBatchSelect(opts: {
  /** 当前 subheader 的扁平序列；Cmd+A / Shift+范围选需要 */
  flatIds: () => string[];
}) {
  const listStore = useListStore();

  const batchCtxMenu = reactive<ListBatchCtxMenu>({ visible: false, x: 0, y: 0 });

  /** 行点击转发（与 useBatchSelect.onTaskRowSelect 同构） */
  function onListNodeClick(id: string, e: MouseEvent): void {
    if (e.shiftKey) {
      listStore.rangeBatchSelect(opts.flatIds(), id);
    } else if (e.metaKey || e.ctrlKey) {
      listStore.toggleBatchSelect(id);
    } else if (listStore.batchMode) {
      listStore.toggleBatchSelect(id);
    } else {
      // 非多选态普通点击：单选 → 路由跳转（沿用 goToList 逻辑）
      // 不在 composable 处理，由 SidebarListNode 内部判断
    }
  }

  /** 容器级右键：多选态下捕获冒泡的 contextmenu */
  function onBatchContextMenu(e: MouseEvent): void {
    if (!listStore.batchMode || listStore.batchSelectedIdsArr.length === 0) return;
    e.preventDefault();
    batchCtxMenu.x = e.clientX;
    batchCtxMenu.y = e.clientY;
    batchCtxMenu.visible = true;
  }

  return { batchCtxMenu, onListNodeClick, onBatchContextMenu };
}
```

**⚠️ 验证**：

- 写一行临时 console.log 在 onListNodeClick，确认 e.metaKey 分支正确进入 toggleBatchSelect

---

## P3. SidebarListNode 行点击 + checkbox 可视化

**目标文件**：`src/components/SidebarListNode.vue`

**步骤 3.1**：新增 props（接收 onClick 回调，让 TheSidebar 统一控制）

```ts
const props = withDefaults(defineProps<{
  // ... 已有 props ...
  /** 多选态下点击行的回调（由 TheSidebar 注入） */
  onNodeClick?: (id: string, e: MouseEvent) => void;
  /** 当前节点是否处于多选选中态（由 TheSidebar 注入） */
  isBatchSelected?: boolean;
  /** 是否处于多选态（控制 checkbox 显隐） */
  batchMode?: boolean;
  /** 节点是否受保护（inbox/default-notebook）：批量操作置灰时用 */
  isProtected?: boolean;
}>(), { /* defaults */ });
```

**步骤 3.2**：改造行点击事件

```ts
function onRowClick(e: MouseEvent) {
  if (props.onNodeClick) {
    props.onNodeClick(props.node.id, e);
  } else if (!props.node.isFolder) {
    router.push(`${routePrefix.value}/${props.node.id}`);
  }
}
```

把模板中 `@click="goToList"` 改为 `@click="onRowClick($event)"`。

**步骤 3.3**：模板中色点位置之前加 checkbox（仅多选态显示）

```html
<span class="list-node__checkbox-wrapper">
  <a-checkbox
    v-if="batchMode"
    :model-value="isBatchSelected"
    :disabled="isProtected"
    @click.stop
    @change="onRowClick($event as any)"
  />
</span>
```

**步骤 3.4**：CSS 加 checkbox 样式

```css
.list-node__checkbox-wrapper {
  width: 14px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.list-node--batch-selected {
  background-color: var(--jt-accent-soft);
}
.list-node--batch-selected .list-node__title {
  color: var(--jt-primary);
  font-weight: 600;
}
```

**步骤 3.5**：emit 增加 `nodeClick` 事件，把行点击由父组件注入

```ts
const emit = defineEmits<{
  // ... 已有 events ...
  nodeClick: [id: string, e: MouseEvent];
}>();
```

递归渲染的子节点也要透传这个事件。

---

## P4. ListBatchContextMenu 组件

**新增文件**：`src/components/ListBatchContextMenu.vue`

**结构**：参照 `BatchContextMenu.vue`，但操作集换成清单/笔记本的批量操作。

**步骤 4.1**：props

```ts
const props = withDefaults(defineProps<{
  visible: boolean;
  x: number;
  y: number;
  /** 'home' 主页多选 | 'archive' 归档区多选 */
  scope: "home" | "archive";
  /** 'task' 清单 | 'note' 笔记本（决定文案：清单/任务 vs 笔记本/笔记） */
  kind: "task" | "note";
}>(), {});
```

**步骤 4.2**：5 个 action handler

| Action                  | 实现                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `applyMoveTo(parentId)` | 循环 `listStore.moveNode(id, parentId, endIndex)`；移动完成统一 `exitBatchMode()`                |
| `applyArchive()`        | 循环 `listStore.archiveTree(id)`；完成后 `exitBatchMode()`                                      |
| `applyUnarchive()`      | 循环 `listStore.unarchiveTree(id)`；完成后 `exitBatchMode()`                                    |
| `applyColor(color)`     | 循环 `listStore.setColor(id, color)`；**不退出多选**（用户常需连续改多份）                        |
| `applyDelete()`         | `listStore.requestBatchDelete([...ids])`；弹 ConfirmDialog 后由 store `confirmBatchDelete` 执行 |

**步骤 4.3**：移动至 / 改色两个级联子菜单

- 「移动至」复用 `ListCascadeMenu.vue`，`selectFolders=true`；目标树排除所有选中节点及后代
- 「改色」复用 `TeleportPopper` 第 7 套 8 色调色板

**步骤 4.4**：批量归档 / 删除的 inbox/default-notebook 灰禁

```ts
const containsProtected = computed(() =>
  listStore.batchSelectedIdsArr.some((id) => id === "inbox" || id === "default-notebook"),
);
```

`<MenuPopoverItem :disabled="containsProtected" ...>`

---

## P5. TheSidebar 集成

**目标文件**：`src/components/TheSidebar.vue`

**步骤 5.1**：useListBatchSelect

```ts
const listBatch = useListBatchSelect({
  flatIds: () => flattenActiveTree(
    activeRouteName.value === "notebook" ? listStore.noteListTree : listStore.listTree
  ),
});
```

**步骤 5.2**：SidebarListNode 的 props 传入

```html
<SidebarListNode
  :node="node"
  :batch-mode="listStore.batchMode"
  :is-batch-selected="listStore.isBatchSelected(node.id)"
  :is-protected="node.id === 'inbox' || node.id === 'default-notebook'"
  @node-click="listBatch.onListNodeClick"
  ...
/>
```

递归子节点同步透传。

**步骤 5.3**：挂 ListBatchContextMenu

```html
<ListBatchContextMenu
  v-bind="listBatch.batchCtxMenu"
  :scope="listStore.archivedLists.some((l) => batchIds.includes(l.id)) ? 'archive' : 'home'"
  :kind="activeRouteName === 'notebook' ? 'note' : 'task'"
  @update:visible="(v) => listBatch.batchCtxMenu.visible = v"
/>
```

**步骤 5.4**：右键非选中节点 → 第一项改为「多选」

```ts
function onCtxListNode(e: MouseEvent, n: ListTreeNode) {
  if (!listStore.batchMode) {
    // 在原菜单顶部加一个「多选」项；保留原菜单的所有项
    openCtxMenu(e, { kind: n.isFolder ? "folder" : "list", node: n });
    return;
  }
  // 多选态：contextmenu 已经在 SidebarListNode.stopPropagation，
  // 由 listBatch.onBatchContextMenu 容器级捕获
}
```

实际上把 SidebarListNode 的右键菜单逻辑改成：

```html
@contextmenu.stop="batchMode ? listBatch.onBatchContextMenu($event) : emit('contextmenu', $event, node)"
```

**步骤 5.5**：subheader Cmd+A 监听

```ts
function onSubheaderKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    listStore.selectAllBatch(listBatch.flatIds());
  }
}
```

模板：subheader 加 `@keydown="onSubheaderKeydown"`，并 `tabindex="0"` 让其可聚焦（仅多选态激活监听，避免污染其他快捷键）。

**步骤 5.6**：Esc 监听

```ts
function onEscForBatch(e: KeyboardEvent) {
  if (e.key === "Escape" && listStore.batchMode) {
    listStore.exitBatchMode();
  }
}
```

挂到 onMounted 的 window keydown 监听（与现有 onEscForCascade 共存）。

**步骤 5.7**：路由跳转保护

```ts
function redirectAwayIfAnyBatchActive() {
  for (const id of listStore.batchSelectedIdsArr) {
    const node = listStore.getById(id);
    if (node && activeListId.value === id) {
      router.push(node.kind === "note" ? "/notebook/default-notebook" : "/all");
      return;
    }
  }
}
```

在 batchArchive / batchDelete / batchUnarchive 内部执行跳转。

**步骤 5.8**：批量删除的 ConfirmDialog

```html
<ConfirmDialog
  :visible="!!listStore.pendingBatchDeleteIds"
  @update:visible="(v) => !v && listStore.cancelBatchDelete()"
  @confirm="listStore.confirmBatchDelete"
>
  <template #title>
    删除选中的 {{ listStore.pendingBatchDeleteIds?.length || 0 }} 个
    {{ kind === "note" ? "笔记本" : "清单" }}？
  </template>
  <!-- 子标题：累计任务数 / 笔记数将移动到 收件箱 / 默认笔记本 -->
</ConfirmDialog>
```

`listStore` 新增 `pendingBatchDeleteIds` ref + `requestBatchDelete(ids)` / `cancelBatchDelete()` / `confirmBatchDelete()`。

`confirmBatchDelete` 内：循环 `db.deleteList(id)`，完成后 `loadLists()` + `refreshCounts()` + `exitBatchMode()` + 跳走。

**步骤 5.9**：路由监听自动退出多选

```ts
watch(() => route.name, () => listStore.exitBatchMode());
```

---

## P6. 批量拖拽

**目标文件**：`src/components/SidebarListNode.vue`（dragstart）+ `TheSidebar.vue`（move handler）

**步骤 6.1**：SidebarListNode.onDragStart 改为批量感知

```ts
function onDragStart(e: DragEvent) {
  if (!canDrag.value) { e.preventDefault(); return; }
  // 多选态下拖动任一选中节点 → 整组都标记为被拖
  const ids = listStore.batchMode && listStore.isBatchSelected(props.node.id)
    ? listStore.batchSelectedIdsArr
    : [props.node.id];
  e.dataTransfer!.setData("text/plain", JSON.stringify(ids));
  e.dataTransfer!.effectAllowed = "move";
  isDragging.value = true;
}
```

把 `text/plain` 的格式从「单个 id」改为「JSON 数组」——**向后兼容**需要看现有所有读取方：

| 读取方                                              | 文件                                                                              | 处理                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `SidebarListNode.onDrop` 取 draggedId               | `SidebarListNode.vue:256`                                                          | `JSON.parse` 后取第一个；如果是单字符串兼容                  |
| `onListMove(draggedId, target, position)`           | `TheSidebar.vue:703`                                                              | 改为接收数组；循环 moveNode                                  |
| `parseTaskDrag`                                     | `@/utils/dnd`                                                                     | 不读 text/plain，走自定义 MIME，**不受影响**                  |
| `SidebarListNode.onDrop` 的 `taskDrop` 分支         | `SidebarListNode.vue:232`                                                        | 走的是 `parseTaskDrag(e)`，先于 text/plain，**不受影响**    |

兼容性：在 onDrop 取值处用 `try { JSON.parse(v) } catch { [v] }`。

**步骤 6.2**：onListMove 改批量

```ts
async function onListMove(draggedIds: string[], target: ListTreeNode, position: "before" | "after" | "inside") {
  // 1. 目标不在任何 draggedId 子树中（防循环）
  // 2. 按 position 升序，保持相对顺序
  const sorted = [...draggedIds].sort((a, b) => {
    const pa = listStore.getById(a)?.position ?? 0;
    const pb = listStore.getById(b)?.position ?? 0;
    return pa - pb;
  });
  // 3. 循环 moveNode，position=endIndex（依次追加末尾）
  // 4. 退出多选
}
```

**步骤 6.3**：循环防护在 onDragOver 阶段就拒绝

```ts
// 拖到目标节点自身或后代 → 拒绝（无高亮 + dropEffect="none"）
function isDescendantOfAny(nodeId: string, ids: string[]): boolean {
  let cur: string | null = nodeId;
  while (cur) {
    if (ids.includes(cur)) return true;
    cur = listStore.getById(cur)?.parentId ?? null;
  }
  return false;
}
```

---

## P7. 集成测试与 bug 修复

### P7.1 单测路径（tauri-mcp execute_js）

```js
// 1. 进入多选态
window.__pinia.state.value.list.batchMode  // 应为 false
useListStore().toggleBatchSelect('xxx-list-id')
// 2. 验证选中集合
useListStore().batchSelectedIdsArr
// 3. 退出多选
useListStore().exitBatchMode()
// 4. Cmd+A 全选
useListStore().selectAllBatch(flatIds)
```

### P7.2 端到端验证清单

按设计文档 §10 验收清单逐条验证。

### P7.3 已知风险点

| 风险                                                | 应对                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| HMR 不彻底导致新增 store action undefined            | 改 store 后**必须整页 reload**                                              |
| TheSidebar 把 ListBatchContextMenu 挂在归档区外可能误捕 | 在 sidebar__list-tree 上区分归档区子集，仅归档区子树挂 scope="archive" 菜单 |
| 批量拖拽的 JSON 解析与单节点兼容                     | onDrop 处 `try { JSON.parse(v) } catch { [v] }` 兜底                       |
| SidebarListNode 递归渲染时 props 透传漏掉            | 递归子组件同步加 4 个新 props（onNodeClick / isBatchSelected / batchMode）  |
| inbox / default-notebook 在多选选中 → 「批量归档」置灰 | batch context menu 计算 containsProtected computed 控制 :disabled         |

### P7.4 提交策略

按依赖顺序拆 3-4 个小 commit：

1. `feat: 清单/笔记本多选 store + composable + 行点击转发`
2. `feat: 多选态 checkbox 可视化 + 批量右键菜单`
3. `feat: 批量归档/取消归档/移动至/改色 + 批量拖拽`
4. `fix: (按实际 bug 修复单独提交)`

每个 commit 后**整页 reload** 验证（参考 [[hmr-state-pollution]]）。

### P7.5 真实数据保护

测试清单只用「日常」（参考 [[user-data-protection]]），绝不在「工作」「重要项目」等清单上做删除/归档/移动测试。
验证时确认「工作」清单数据**全程零写入**。

---

## 工作量估算

| 阶段  | 工时      |
| ----- | --------- |
| P1    | 0.5h      |
| P2    | 0.5h      |
| P3    | 1h        |
| P4    | 2h（含两个级联子菜单） |
| P5    | 1.5h      |
| P6    | 1h        |
| P7    | 1.5h（修 bug + 集成测试） |
| **总计** | **~8h**   |

## 依赖与约束

- 所有改 store 的提交后必须**整页 reload**测试
- 后端 0 改动（复用现有命令）
- 不破坏现有「移动至」（右键菜单）和现有「归档 / 取消归档 / 删除 / 改色」的单条右键路径
- 必须在已有 test-runner（tauri-mcp）下做端到端验证
- 「日常」清单用户数据零写入约束（[[user-data-protection]]）