# 清单 / 笔记本多选批量操作设计

> JustToDo 侧边栏「清单」与「笔记本」两棵独立树的多选、批量归档 / 删除 / 改色 / 移动至目录 / 批量拖拽。
> 评审时间：2026-08-14

## 1. 目标与背景

任务侧已在 2026-07-31 实现成熟的批量多选体系（详见 `discuss/2026-07-31-batch-operation-design.md`），
但**操作对象**只有任务/笔记。用户希望把这个能力向上延伸到**清单/笔记本自身**：

- 批量归档多份清单 / 笔记本（避免逐条右键）
- 批量删除多份清单 / 笔记本（避免逐条确认）
- 批量改色（多份清单统一换成同一颜色）
- 批量移动至指定目录（复用现有「移动至」级联菜单的批量版）
- 批量拖拽（整组平移保持相对顺序，类似 Finder 多选拖拽）

复用现有架构（list store、SidebarListNode、ContextMenu 级联子菜单），不引入新的 IPC 命令，
仅在前端组合调用现有 `list_archive_tree` / `list_unarchive_tree` / `delete_list` /
`list_set_color` / `list_move`，因为这些命令本身就是按 id 操作的，可直接循环调用。

## 2. 与任务批量操作的对称性

| 维度            | 任务 / 笔记批量                                  | 清单 / 笔记本批量                              |
| --------------- | ------------------------------------------------ | ---------------------------------------------- |
| 状态位置        | `task.ts`：`batchSelectedIds`、`batchMode`       | `list.ts`：`batchSelectedIds`、`batchMode`     |
| 组合式钩子      | `useBatchSelect`（已有）                          | `useListBatchSelect`（新增，复用模板）          |
| 多选入口        | Cmd/Ctrl + 点击、Shift + 点击、右键「多选」       | **完全一致**（4 种入口全开）                     |
| Cmd+A 范围      | `currentTasks`（当前视图根任务）                  | 当前 subheader（清单/笔记本）下可见 active 节点 |
| 右键菜单组件    | `BatchContextMenu.vue`（已有，支持 kind 切换）    | **复用 + 新增 `kind="list"`/`"folder"` 选项** |
| 多选可视化      | 任务行加 checkbox 叠在复选框前                    | 行首色点位置叠加 checkbox（仅多选态可见）       |
| 退出多选        | Esc、操作完成自动退出                             | **一致**                                      |

任务侧的 6 项操作（完成 / 移清单 / 加标签 / 改优先级 / 改日期 / 删除）天然不适用于清单侧：
- 完成 / 优先级 / 日期 —— 清单无此概念
- 加标签 —— 清单不打标签（标签是任务的）
- 移清单 —— 移到清单等于「移动至目录」

所以清单侧只暴露：**批量归档 / 取消归档 / 删除 / 改色 / 移动至目录**，最简不堆砌。

## 3. Store 设计

**新增字段**（`src/stores/list.ts`）：

```ts
// 多选是当前 subheader（清单/笔记本）的临时状态，切换视图必须清空
// 否则 batchSelectedIds 里的旧 id 残留，右键批量菜单会误操作到已不可见节点。
const batchSelectedIds = ref<Set<string>>(new Set());
const batchMode = ref(false);
const batchAnchorId = ref<string | null>(null);
```

**新增 actions**（与 `task.ts` 同构）：

| Action                     | 行为                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `enterBatchMode()`         | 进入多选态，清空选中集合与锚点                                                                                     |
| `exitBatchMode()`          | 退出多选态                                                                                                        |
| `toggleBatchSelect(id)`    | 增减单条；首次自动进入多选态                                                                                       |
| `rangeBatchSelect(id)`     | 从锚点到当前节点范围选（在扁平 active 节点序列上的连续范围）                                                       |
| `selectAllBatchInTree()`   | 全选当前 subheader 下可见 active 节点（按 `listTree`/`noteListTree` DFS 展开顺序）                                  |
| `isBatchSelected(id)`      | 谓词                                                                                                              |
| `batchSelectedIdsArr`      | computed：`Array.from(batchSelectedIds)`                                                                          |

**Reset 时机**（与 `task.ts` 一致）：

- 视图切换（route.name 变化：list ↔ notebook ↔ tag ↔ smart）—— 监听 `route.name` 调 `exitBatchMode`
- `loadLists()` 后 —— 整树重建，旧 id 已无意义
- 操作完成（归档 / 删除 / 移动）后 —— 与任务批量对齐

## 4. 交互细节

### 4.1 多选入口（4 种全开）

1. **Cmd/Ctrl + 点击**：切换单条选中；首次自动进入多选态
2. **Shift + 点击**：范围选
   - 锚点 = 上一次 toggle/range 操作的最后一个 id（`batchAnchorId`）
   - 范围 = 锚点到当前节点在「当前 subheader 可见 active 节点 DFS 序列」中的连续子集
   - 已部分选中的范围 → 取并集（覆盖式）
3. **右键菜单「多选」入口**：非多选态下右键菜单首项改为「多选」（图标 `IconSelectAll`），点击后将该节点加入选中、进入多选态
4. **Cmd/Ctrl + A**：全选当前 subheader 下可见 active 节点（按 tree DFS 展开顺序）
   - 仅作用于当前 subheader（清单或笔记本），与视图范围一致
   - 不递归未展开的子项（保持「可见即所选」的可预测语义）

### 4.2 选中可视化

- 多选态下，**每行色点位置之前**叠加 Arco `a-checkbox` 图标
  - 未选中：checkbox 透明/浅灰，hover 时变深
  - 选中：checkbox 实心 + 高亮色（`var(--jt-primary)`）
- 选中行的背景使用 `--jt-accent-soft`（与路由激活态颜色一致），通过更深的色号或左侧 2px 色条区别于路由激活
- **非多选态下彻底隐藏 checkbox**，不污染原有视觉

### 4.3 批量拖拽（整组平移）

HTML5 drag 一并触发多节点移动。拖动任一选中节点，整组都跟着移动：

- 拖动源 = `batchSelectedIds` 中第一个节点；浏览器自动以整个拖拽元素作 drag image（沿用现有做法）
- 落点判定复用现有 onDragOver 几何（上 1/3 / 中 1/3 / 下 1/3 → before / inside / after）
- **整组平移保持相对顺序**：把 `batchSelectedIds` 按 `position` 排序后，从前往后依次 moveNode 到目标位置
- 父级保护：拖到任意选中节点自身或后代上 → 拒绝（与单节点拖拽一致）
- 跨 kind 防护：复用 `moveNode` 内已有的拒绝逻辑

### 4.4 右键批量菜单

新建 `src/components/ListBatchContextMenu.vue`（或扩展现有 `BatchContextMenu.vue` 加 `kind` 维度的 list/folder/note-list/note-folder 四种）。

**主页多选菜单项**：

| 图标                  | 文案                | 行为                                                                                  |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| IconSelectAll         | 全选当前可见 (N)    | 同 Cmd+A，可视化反馈                                                                  |
| IconFolder            | 移动至 ▸            | hover 弹右侧级联子菜单（根目录 + 仅目录树，复用现有 `ListCascadeMenu`）               |
| IconArchive           | 归档 (N)            | 循环调 `listStore.archiveTree(id)`；inbox/default-notebook 时该项灰禁                  |
| IconBgColors          | 改色 ▸              | hover 弹行内色板（复用现有 `TeleportPopper` 第 7 套色板）                              |
| — (divider)           | —                   | —                                                                                      |
| IconDelete (danger)   | 删除 (N)            | 弹 `ConfirmDialog`「删除选中的 N 个清单？含 X 个任务…」逐项确认后逐项 `deleteList`     |

**归档区多选菜单项**（仅归档区右键）：

| 图标            | 文案                  | 行为                                            |
| --------------- | --------------------- | ----------------------------------------------- |
| IconRestore     | 取消归档 (N)          | 循环调 `listStore.unarchiveTree(id)`            |
| IconDelete      | 删除 (N)              | 同上                                            |

**注意**：清单是叶子节点，「批量移清单到清单下」目前在 UI 上不渲染（侧边栏只有目录可点开子项）。
所以「移动至」的目标树是**仅目录**（与现有「移动至」菜单完全一致），不需要新增 `selectFolders=true`。

### 4.5 操作完成自动退出

执行「归档 / 取消归档 / 删除 / 改色 / 移动至」任一项后，**统一在 store 内 action 末尾**调 `exitBatchMode()`，
确保：
- 选中的节点可能已不存在（删除 / 归档到归档区），UI 不残留选中样式
- 防止用户继续右键触发二次操作
- 改色虽不改变可见性，但也**统一退出**（用户 2026-08-14 反馈：所有操作执行后都应退出，行为可预测）

### 4.6 Esc / 操作外取消

- **Esc**：监听 window keydown，已在批量操作模式下按 Esc 调 `exitBatchMode()`
- **点击空白处**：不退出（与任务批量对齐，避免误触清空）

### 4.7 批量删除的确认弹窗

复用 `ConfirmDialog.vue`，store 内新增：

```ts
const pendingBatchDeleteIds = ref<string[] | null>(null);
function requestBatchDelete(ids: string[]): void { pendingBatchDeleteIds.value = ids; }
function cancelBatchDelete(): void { pendingBatchDeleteIds.value = null; }
async function confirmBatchDelete(): Promise<void> { /* 循环删 + refreshCounts */ }
```

文案：

```
删除选中的 N 个清单/笔记本？
清单下的 X 个任务将移动到「收件箱」/「默认笔记本」。
```

（X 是所有选中清单下任务总数，**循环查**后累加；不可省略，避免用户误删大量数据）

## 5. 子菜单复用与新增

- **「移动至」级联子菜单**：直接复用 `ListCascadeMenu.vue` 的 `selectFolders=true` 模式（b3ee73e 已实现）。
  仅目录可选的过滤在目标树层完成（filterFolderTree 已存在），新代码只需喂入排除 id 集合（所有选中节点 + 它们的后代）。
- **「改色」色板**：复用 `TeleportPopper` + 第 7 套 8 色调色板（list-dot-color-feature 已实现）。
  选中节点的颜色原地更新；inbox/default-notebook 也可换色（与单条一致）。

## 6. 数据完整性保护

### 6.1 inbox / default-notebook 保护

- 「批量归档」菜单项在包含 inbox / default-notebook 时**置灰禁用**（不可批量归档系统节点）
- 「批量删除」同样置灰（不可批量删除系统节点）
- 这与单条右键「删除 / 归档」对该类节点的拦截一致

### 6.2 范围选算法

DFS 当前 subheader 的 active 树（`listTree`/`noteListTree`）生成扁平序列，锚点与当前点都在该序列中，
取连续子集。若锚点已不在当前视图（例如切换了 subheader），退化为 toggle 单点。

### 6.3 批量拖拽的循环防护

拖到任一选中节点自身或其后代上 → 拒绝（与单节点一致）。批量时只需把目标 id 与所有选中 id 比对一次即可。

### 6.4 路由跳转保护：批量操作不主动跳走

任务批量操作执行后可能自动跳走（删除当前选中任务）。清单侧更微妙：

- 批量删除选中清单时，若当前路由正位于被删清单 → 跳到「全部」智能视图
- 批量归档选中清单时，同上
- 跳走时机：store action 末尾、循环调 IPC 之前

## 7. 关键 bug 防范（参考 [[batch-operation-design]] 8 条）

| 历史教训                                         | 本功能对应处理                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1. 移动目标含目录导致任务丢失                     | 「移动至」复用 `filterFolderTree`，只可选目录                                    |
| 2. applyXxx 关菜单顺序导致待应用数据被清空         | 「批量移动 / 改色」先快照选中 id，再关菜单，最后用快照执行                       |
| 3. 跨 IPC 边界 nullable 字段反序列化错             | 改色 / 移动不涉及 nullable 字段；可空字段仅任务侧的 date 需要                    |
| 4. Teleport 子菜单点击被 onDocumentClick 误关     | ListBatchContextMenu 复用 `.batch-submenu` 类名与豁免逻辑                       |
| 5. store HMR 不彻底导致新增 action undefined      | list.ts 是已稳定的 store；新增 action 后**必须整页 reload**测试                 |
| 6. 子菜单首次打开定位错误                         | 直接复用 BatchContextMenu 已修好的 nextTick + rAF 测量                           |
| 7. 加标签体验：保持多选 + toggle                  | 改色是单选语义（点选即应用，不支持 toggle「取消」）                              |
| 8. 批量删除弹 ConfirmDialog                       | 复用现有 ConfirmDialog，新增 `pendingBatchDeleteIds` 字段                         |

## 8. 文件改动清单（预估）

| 文件                                              | 改动                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/stores/list.ts`                              | 新增 `batchSelectedIds/Mode/AnchorId`、6 个 batch actions、Cmd+A 全选 computed    |
| `src/composables/useListBatchSelect.ts`           | 新增（复用 useBatchSelect 模板，转发到 listStore）                                 |
| `src/components/SidebarListNode.vue`              | 行点击转发到 composable；多选态显示 checkbox；批量拖拽支持                          |
| `src/components/TheSidebar.vue`                   | 挂 ListBatchContextMenu；subheader Cmd+A 监听；Esc 监听；路由跳转保护              |
| `src/components/ListBatchContextMenu.vue`         | 新增（结构对齐 BatchContextMenu，操作集换成归档/取消归档/改色/移动至/删除）        |
| `src/components/ConfirmDialog.vue`                | 无改动（复用）                                                                    |
| `src/types/list.ts`（如需）                        | 无新增（`Set<string>` 就够）                                                       |

预估代码增量：**前端 ~600 行**（含 ListBatchContextMenu 完整实现 + composable）。
**后端 0 改动**（复用现有命令）。

## 9. 不在本期范围

- ❌ 标签侧多选 —— 标签是任务的，清单多选与标签无关
- ❌ 智能视图 / 习惯 / 模板多选 —— 不同语义、不同命令
- ❌ 跨清单移动任务时的多选 —— 任务多选已覆盖
- ❌ 批量改清单名称 —— 名字应逐个改，批量改色已能满足「视觉分组」需求
- ❌ 批量改清单 icon —— 当前清单只有色点，没有 icon 概念

## 10. 验收清单

- [ ] Cmd/Ctrl + 点击清单/笔记本行 → 选中状态正确切换
- [ ] Shift + 点击 → 范围选连续区段
- [ ] 非多选态下右键菜单首项是「多选」 → 点击后该行选中、进入多选态
- [ ] 多选态下右键 → 弹 ListBatchContextMenu，含 6 项菜单（含 divider）
- [ ] 归档区多选 → 弹含「取消归档」的菜单
- [ ] 选中 inbox / default-notebook 后，「批量归档」「批量删除」置灰
- [ ] Cmd/Ctrl + A → 全选当前 subheader 可见 active 节点（递归已展开后代）
- [ ] Esc → 退出多选
- [ ] 操作完成后自动退出多选（含改色）
- [ ] 改色后色点已生效
- [ ] 「移动至」子菜单可选目录自动排除所有选中节点及后代
- [ ] 批量删除弹 ConfirmDialog，文案「删除选中的 N 个清单」+ 任务迁移说明
- [ ] 批量拖拽整组平移保持相对顺序
- [ ] 拖到任意选中节点自身 / 后代 → 拒绝（无视觉反馈 / 静默失败均可）
- [ ] 路由切换（list ↔ notebook ↔ tag ↔ smart）→ 自动清空多选态
- [ ] reload 后所有功能正常（HMR 不污染状态）
- [ ] 「日常」清单的用户数据**全程零写入**（见 [[user-data-protection]]）