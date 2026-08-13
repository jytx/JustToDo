# 任务跨清单拖拽设计

> 状态：已实现（2026-08-13）
> 需求：任务从当前清单拖到侧边栏其他清单 → 移动任务；拖到目录（文件夹）→ 自动新建清单后移入

## 需求

1. 从清单 A 拖住任务 A1，拖到侧边栏的清单 B → 任务（含其**整棵子任务树**）移入 B
2. 拖到目录（文件夹）节点 → 自动在该目录下新建清单，任务移入
3. 笔记（note）天然复用同一机制（拖到笔记本树）；跨 kind（任务 ↔ 笔记本）拖拽禁止

## 现状与问题

| 现状 | 问题 |
| --- | --- |
| 任务拖拽用 `text/plain` = 任务 id（TaskListItem.vue） | 与侧边栏清单拖拽（`text/plain` = 清单 id）**MIME 冲突**：任务拖到侧边栏会被当成清单 id 处理 |
| 移动任务走 `task_update` 传 `list_id`（只改单条） | 子任务不跟着走，留在原清单形成**孤儿** |
| 无「移动任务到清单」专用命令 | 需要事务内子树迁移 |
| 侧边栏有清单自身拖拽（SidebarListNode.vue） | 可作为任务 drop 目标复用，需 MIME 区分 |

## 方案

### 1. MIME 隔离（关键正确性）

任务/笔记拖拽 `dragstart` 新增自定义 MIME：

```
application/x-task-drag = JSON.stringify({ id: 任务id, kind: 'task' | 'note' })
```

（保留 `text/plain` = id 兼容现有逻辑）。常量与解析函数集中在
`src/utils/dnd.ts`（`TASK_DRAG_MIME` / `hasTaskDrag` / `parseTaskDrag`）。

- **侧边栏** `onDragOver`/`onDrop` 优先解析 `application/x-task-drag` → 任务拖拽模式；
  否则走现有清单拖拽逻辑
- **任务列表** `onDragOver`：不含该 MIME（清单拖过）→ `dropEffect="none"` 禁止光标、不参与高亮

### 2. 新 Rust 命令 `task_move_to_list`（事务内子树迁移）

```
task_move_to_list(task_id, target_list_id)
```

校验链：
1. 任务存在（取 `list_id` + `kind`）
2. 目标清单存在、`is_folder = 0`、`kind` 与任务一致
3. 目标 ≠ 当前清单 → no-op 直接返回

迁移（**事务**，任一步失败回滚）：
1. `WITH RECURSIVE` 收集整棵子树（任务自身 + 所有后代）
2. 子树 `UPDATE SET list_id = 目标, group_id = 目标||'-default', updated_at`（全部回退默认分组，
   避免跨清单 group_id 孤儿）
3. 被拖任务 `sort_order` = 目标清单根任务末尾（`MAX(sort_order) + 1000`），子任务保持相对顺序

### 3. 前端链路

- `db.ts`：`moveTaskToList(taskId, targetListId)` → `invoke("task_move_to_list")`
- `task.ts`：`moveTaskToList` action —— 成功后 `reload()` + `refreshCounts()` + `notifyTaskChanged()`；
  失败 `console.error` 返回 `false`（拖拽 drop 是 fire-and-forget，未捕获 rejection 用户无感知）
- `TaskListItem.vue`：「移动到清单」菜单统一改走 `moveTaskToList`（顺带修复子任务孤儿 bug）

### 4. 侧边栏拖放目标

`SidebarListNode.vue`（递归组件，清单树 + 笔记本树共用）：

| drop 目标 | 任务拖拽行为 | 高亮 |
| --- | --- | --- |
| 清单节点（含 inbox） | `emit("taskDrop")` → 移动到该清单 | 整行 outline（复用 drag-over） |
| 目录节点 | `emit("taskDropToFolder")` → 新建清单后移入 | inset 阴影（复用 drag-inside，语义「将新建清单」） |
| 跨 kind 节点 | 拒绝（`dropEffect="none"`） | 无 |

`TheSidebar.vue`：
- `onTaskDrop` → `taskStore.moveTaskToList`；失败 `Message.error`
- `onTaskDropToFolder` → 计算自动清单名 → `listStore.createList` → `moveTaskToList`

**自动清单名**（用户拍板：固定名 + 序号）：「新清单 N」/「新笔记本 N」
（N = 现有同名清单最大序号 + 1，无则从 1 起）。默认色沿用新建清单弹窗 `#10B981`。

### 5. dragend 竞态防护（重要）

时序：侧边栏 `drop`（异步移动）→ 浏览器同步触发 `dragend` → `onTaskDragEnd`
会用旧清单顺序 `persistTaskOrder`。若 `task_reorder` IPC 晚于 `task_move_to_list` 完成，
会把已移走任务的 `sort_order` 覆盖为旧清单位置值。

防护：drop 的同步阶段（SidebarListNode.onDrop）调用 `taskStore.markTaskDragMoved(taskId)`
设置标志；`onTaskDragEnd` 检测到标志命中 → **跳过本次持久化**；`moveTaskToList` 的
`finally` 清除标志。

## 边界情况

- 拖到当前清单节点 / inbox 自身 → 命令内 list_id 相同检测，no-op
- 智能视图 / 标签视图 / 分组视图拖拽自动生效（同一组件 + MIME）
- 侧边栏收起（rail 模式）无树节点，自然无 drop 目标
- 移动失败：任务留在原清单（localOrder 由 watch 恢复），错误提示
- 拖到目录但新建清单成功后移动失败 → 留一个空清单（可接受，用户可删）

## 不做（YAGNI）

- 拖到目录时「+ 新清单：任务标题」气泡提示
- 拖到侧边栏空白区/智能视图区域新建清单
- 子任务拖拽（保持 depth === 0 限制）

## 验证

- `cargo check` / `cargo clippy` / `vue-tsc --noEmit`
- GUI（tauri-mcp）：仅用「日常」清单测试；execute_js 合成 DragEvent 验证（鼠标模拟
  无法触发 HTML5 DnD）；真实拖拽由用户确认
