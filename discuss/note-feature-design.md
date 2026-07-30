# 笔记 / 便签功能设计

> 状态：已实现并验证（migration 023 + 全链路改动）
> 日期：2026-07-30
> 负责人：李群 + ZCode

## 一、背景与目标

### 1.1 用户诉求

新增一种「笔记 / 便签」类型，用于日常轻量记录——密码、链接、文章摘录等。

**核心区别**：与待办清单功能完全一致（CRUD、富文本、标签、子项嵌套、附件、拖拽排序、归档），
但**不需要**起止时间、完成动作、重复、提醒。

### 1.2 已确认的架构决策

| 决策项 | 选择 | 理由 |
| --- | --- | --- |
| 存储方式 | **复用 `tasks` 表**，加 `kind` 字段 | 最大化复用现有基础设施，符合 DRY |
| 容器组织 | **「笔记本」独立成区**，类似清单 | 与清单机制对称，便于分类管理 |
| 标签 | **全局共用** | 一个标签可同时关联任务和笔记 |
| 全局搜索 | **全局共用** | 搜索同时返回任务和笔记 |
| 目录树 | **两棵独立树** | 清单树与笔记本树互不混淆 |
| 笔记优先级 | **保留** | 与待办完全对称 |
| 笔记排序 | **手动排序** | 复用 sort_order，与待办对称 |
| 图标 | **Arco IconFile / IconBook** | 与现有侧边栏图标风格统一 |
| 默认容器 | **预置「默认笔记本」**（id='default-notebook'） | 与 inbox 对称，删除笔记本时笔记迁移目标 |

---

## 二、数据模型设计

### 2.1 tasks 表新增 `kind` 字段

```sql
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
-- 取值：'task'（待办，默认）| 'note'（笔记）
```

笔记记录的语义约束（由应用层保证，非数据库约束）：
- `due_start_at` / `due_end_at` 恒为 NULL
- `done` 恒为 0，`completed_at` 恒为 NULL
- `recurrence_*` 恒为默认值（不重复）
- `remind_offset_minutes` / `notified_at` 恒为 NULL

> **为何用 `kind` 而非 `is_note` 布尔位**：`kind` 是开放枚举，未来若需扩展
> （如「日记」「长文」）不会破坏语义；且 `kind='task'` 作为默认值对存量数据
> 天然兼容，回填 UPDATE 天然幂等。

### 2.2 lists 表新增 `kind` 字段

```sql
ALTER TABLE lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
-- 取值：'task'（清单/目录，默认）| 'note'（笔记本/笔记本目录）
```

`inbox`（收件箱）保持 `kind='task'`，预置「默认笔记本」`kind='note'`。

### 2.3 两棵独立树的实现

清单和笔记本**共用 `lists` 表**，靠 `kind` 字段隔离：

```
侧边栏：
├─ 智能视图（今天/未来7天/全部）—— 仅 kind='task'
├─ 清单         （lists WHERE kind='task'）
├─ 笔记本       （lists WHERE kind='note'）  ← 新增区
├─ 归档         （lists WHERE archived=1，按 kind 分组展示）
└─ 标签         （全局共用）
```

**两棵树独立的保证**（前端 list store 的 moveNode / ensureFolderPath 拦截跨 kind 移动）：
- 笔记本目录（`kind='note'` 且 `is_folder=1`）的 parent 只能指向笔记本目录
- 清单目录（`kind='task'` 且 `is_folder=1`）的 parent 只能指向清单目录
- 数据库层不强制（避免 migration 复杂度）

---

## 三、后端改动（Rust）

### 3.1 Migration 023（`src-tauri/src/db/mod.rs`）

新增 `run_migration_023`，沿用 `run_migration_020` / `run_migration_022` 的成熟范式：

```rust
async fn run_migration_023(pool: &SqlitePool) -> Result<(), String> {
    add_column_if_missing(pool, "tasks", "kind", "TEXT NOT NULL DEFAULT 'task'").await?;
    add_column_if_missing(pool, "lists", "kind", "TEXT NOT NULL DEFAULT 'task'").await?;
    // 预置默认笔记本（与 inbox 同源同逻辑）
    sqlx::query(
        "INSERT OR IGNORE INTO lists (id, name, color, position, created_at, kind) \
         VALUES ('default-notebook', '默认笔记本', '#6B7280', 0, '2026-07-10T00:00:00Z', 'note')",
    ).execute(pool).await?;
    Ok(())
}
```

在 `init_pool` 末尾（022 之后）注册调用。存量数据无需回填（DEFAULT 'task' 自动生效）。

### 3.2 models.rs

- `Task` 结构体加 `pub kind: String`
- `TaskList` 结构体加 `#[serde(default)] pub kind: String`（serde default 兼容旧前端）
- `CreateTaskInput` 加 `pub kind: Option<String>`（不传默认 'task'）
- `list_create` 散参数加 `kind: Option<String>`

### 3.3 commands.rs — 必须按 kind 过滤的查询（关键）

| 命令 | 处理 |
| --- | --- |
| `task_count_smart_view` 的 all 分支 | 加 `AND kind = 'task'` |
| `task_count_by_tag` | 加 `AND kind = 'task'`（标签角标只统计待办） |
| `task_get_smart_view` 的 all 分支 | 加 `AND kind = 'task'` |
| today/upcoming 分支 / `task_get_by_due_range` / 提醒扫描 | **不改**（依赖 due_end_at 非空，笔记天然不命中） |
| `task_get_by_tag` / `search_tasks` | **不改**（全局共用） |
| `task_get_by_list` | **不改**（已按 list_id 隔离） |

### 3.4 commands.rs — INSERT/SELECT 同步

- `task_create`：INSERT 加 kind 列 + 占位符，返回的 Task 填 kind
- `row_to_task`：读取 kind 列（用 try_get 容错旧库）
- `list_get_all`：SELECT 加 kind，映射
- `list_create`：参数加 kind，INSERT 加列，返回填 kind
- `list_delete`：禁止删 default-notebook；删除笔记本时笔记迁移到 default-notebook

### 3.5 新增命令 note_count_by_list

笔记本条目计数（不区分 done，笔记无完成概念）：

```sql
SELECT list_id, COUNT(*) as cnt
FROM tasks
WHERE parent_id IS NULL AND kind = 'note'
  AND list_id NOT IN (SELECT id FROM lists WHERE archived = 1)
GROUP BY list_id
```

### 3.6 lib.rs

`generate_handler!` 注册 `note_count_by_list`。

---

## 四、前端改动（Vue3 + TS）

### 4.1 类型定义（src/types/index.ts）

- `export type TaskKind = "task" | "note"`
- `Task` 接口加 `kind: TaskKind`
- `List` 接口加 `kind?: TaskKind`
- `TaskRow` / `ListRow` / `mapTaskRow` / `mapListRow` 同步加 kind

### 4.2 db.ts

- 内部 `RustTask` / `TaskList` 加 kind
- `CreateTaskInput` 加 `kind?: TaskKind`
- `mapTask` / `getLists` / `createList` 映射加 kind
- `createList` params 加 `kind?: TaskKind`
- 新增 `getNoteCountsByList()` → invoke `note_count_by_list`

### 4.3 stores/task.ts

- `createTask` params 加 `kind?: TaskKind`，默认 'task'
- **笔记（kind='note'）跳过「今天日期兜底」**（笔记无日期）
- 新增 state `noteCounts: Ref<Record<string, number>>`
- `refreshCounts` 追加 `db.getNoteCountsByList()` 调用

### 4.4 stores/list.ts（前端重点 — 两棵独立树）

新增按 kind 过滤的 computed：
- `taskLists`（kind!=='note'）、`noteLists`（kind==='note'）
- `noteListTree`（仅 kind='note' 的未归档项构建树）
- `archivedTaskLists`、`archivedNoteLists`

`listTree` 改为只渲染 taskLists（不混入笔记本）。
`createList` params 加 kind；`moveNode` 加跨 kind 防护；`ensureFolderPath` 加 kind 参数。

### 4.5 路由（router/index.ts）

新增 `/notebook/:id` 路由（name='notebook'，NoteView，props:true）。

### 4.6 NoteView.vue（新建，复用 ListView 结构）

复用 TaskListItem / useTaskDragReorder / ContextMenu。差异：
- 副标题「X 个笔记」
- AddTaskBar 传 kind='note'
- **无「已完成」折叠面板**（笔记 done 恒 0）
- 创建笔记传 kind='note'，不传日期

### 4.7 组件按 kind 条件渲染

**TaskListItem.vue**（笔记时隐藏）：复选框、截止日期、重复图标、task-item--done 样式
**TaskDetailPanel.vue**（笔记时隐藏）：复选框、DueDateChip、ReminderPopover、RecurrencePopover；
「添加子任务」改「添加子笔记」
**AddTaskBar.vue**：加 kind prop，笔记模式 placeholder「添加笔记」、隐藏日期、emit 不含日期

### 4.8 侧边栏（TheSidebar.vue）

- 新增「笔记本」section（位于清单与归档之间），用 noteListTree + 复用 SidebarListNode 渲染
- 收起态 rail 图标列加笔记本圆点（IconBook）+ 分隔线
- 新建笔记本弹窗（复用 sidebar-create 样式，kind='note'）
- 归档区按 kind 分两组

### 4.9 TagView.vue / SearchPalette.vue

笔记项加 IconFile 徽章标识（任务和笔记全局共用，靠图标区分）。

---

## 五、风险与权衡

- **tasks 表语义变杂**：靠所有跨实体查询显式按 kind 过滤 + 注释缓解，是复用方案的固有代价。
- **「全部」智能视图**：加 kind='task' 过滤后只显示待办，符合预期。
- **跨 kind 移动**：前端 moveNode 拦截并提示，数据库不强制。
- **默认笔记本**：与 inbox 对称，删除笔记本时笔记迁移目标。

## 六、不做的事（MVP 范围外）

- 不做笔记专用智能视图（如「全部笔记」）
- 不做默认笔记本的可配置化（先硬编码 default-notebook）
- 不改动重复任务/提醒调度逻辑（笔记天然不触发）
