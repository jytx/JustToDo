# 清单 / 目录归档功能 —— 设计文档

日期：2026-07-29
状态：已批准，进入实施

## 1. 目标

在侧边栏增加「归档」折叠区（同清单/标签同级），把目录或清单归档为整棵子树。归档后：

- 仍可在归档区点击进入对应清单（只读模式：不可新建，但可勾选/编辑/删除任务）。
- 归档区与"清单/标签"区域形态保持一致（折叠菜单 + 行展开 + 颜色圆点 + 右键菜单）。
- 归档可逆：右键「取消归档」恢复整棵子树。
- 数据写入 SQLite 新增 `lists.archived` 列（Rust migration 020）。

## 2. 核心数据模型

1. `lists` 表新增 `archived INTEGER NOT NULL DEFAULT 0`，migration 编号 **020**。
2. 归档 = `archived = 1`，无独立归档表。
3. 任务本身**不动**（`list_id` 不变），仅因 `lists.archived = 1` 在主页默认隐藏。
4. 目录归档 = 级联：整棵子树 `archived = 1`。
5. 取消归档 = 反向级联。

## 3. 后端改动

### 3.1 `src-tauri/src/db/mod.rs`
新增 `run_migration_020`：在 `init_pool` 第 156 行 `run_migration_019` 之后注册。

```rust
add_column_if_missing(pool, "lists", "archived", "INTEGER NOT NULL DEFAULT 0").await?;
```

### 3.2 `src-tauri/src/models.rs`
`TaskList` 加 `pub archived: bool`。

### 3.3 `src-tauri/src/commands.rs`
- 新增 `list_archive_tree(pool, id, archived)`：inbox 硬保护，WITH RECURSIVE 批量级联。
- `list_get_all` 加 SELECT `archived`。
- `task_count_by_list` 加 `AND list_id NOT IN (SELECT id FROM lists WHERE archived = 1)`。

### 3.4 `src-tauri/src/lib.rs`
`generate_handler!` 追加 `list_archive_tree`。

## 4. 前端改动

- `types/index.ts` — `List.archived?: boolean`。
- `api/db.ts` — mapping + `setListArchived(id, archived)` wrapper。
- `stores/list.ts` — `archivedLists` / `activeLists` / `archiveListTree` computed + `archiveTree` / `unarchiveTree` actions + `getDescendantIds`。
- `components/TheSidebar.vue` — IconArchive import、sectionCollapsed.archive、归档 subheader、rail 归档图标、右键菜单归档/取消归档分支。
- `components/SidebarListNode.vue` — `readonly` prop（行内 + 号、+ 子目录隐藏；右键只保留取消归档）。
- `views/ListView.vue` — AddTaskBar 条件 + 已归档角标。

## 5. 行为细节

| 情况 | 行为 |
| --- | --- |
| 归档清单（含任务） | 整清单 + 任务原地不动；主页隐藏；主页角标不计；归档区可见；右键"取消归档" |
| 归档目录 | WITH RECURSIVE 整树 archived=1 |
| 取消归档目录 | 反向级联 |
| 归档 inbox | 错误"收件箱不能归档" |
| 归档清单右键 | 仅"取消归档" |
| 归档折叠区默认 | 收起 |

## 6. 验证

1. `cargo check` & `cargo clippy`。
2. `npx vue-tsc --noEmit`。
3. GUI：`tauri dev` + 手动验证。
