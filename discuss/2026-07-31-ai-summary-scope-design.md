# AI 总结功能完整方案（每日/周报 + 清单/目录 + 多选）

> 配套设计：`discuss/2026-07-31-ai-daily-summary-design.md`（每日/周报，已实现）
> 复用 [[ai-provider-abstraction]] 抽象层。

---

## 一、功能目标

把 AI 总结扩展到三个入口，覆盖任意数据范围：
1. **顶栏每日/周报**（已实现）—— 按时间范围
2. **侧边栏清单/目录/笔记本/笔记本目录** —— 按清单或目录（目录递归子清单）
3. **多选任务** —— 按选中的任务 id

---

## 二、已确认决策

| 入口 | 数据来源 | prompt 类型 |
|------|----------|------------|
| 每日/周报（已实现） | 时间范围 | 任务总结 |
| 清单/目录（任务） | 按 list_id 或 folder 递归 | 任务总结 |
| 笔记本/笔记本目录（笔记） | 同上但 kind=note | 笔记摘要 |
| 多选任务 | 选中任务的 id 数组 | 任务总结 |

- 多选范围：总结选中的任务（不含子任务）
- 结果处理：统一弹窗展示 + 可存笔记（复用 DailySummaryModal）
- 大目录/大量任务：默认全量；超阈值弹确认是否智能裁剪；阈值做成设置项（默认 50）

---

## 三、核心设计：统一后端命令 + 复用弹窗

三个入口的 AI 调用逻辑完全一致（查任务→prompt→chat→markdown），只是数据来源不同。
设计成一个通用命令 + 一个弹窗。

### 后端：通用命令 `ai_summary_scope`

```rust
// scope JSON 对象（前端传）
// { "type": "list",   "id": "xxx" }        // 清单/笔记本
// { "type": "folder", "id": "xxx" }        // 目录/笔记本目录（递归子清单）
// { "type": "tasks",  "ids": ["a","b"] }   // 多选任务
```

参数：`scope: serde_json::Value`、`truncate: Option<bool>`

流程：
1. `build_from_settings` 拿 provider
2. 按 scope.type 查数据（见下）
3. 判断 kind（list/folder 从 lists 表查 kind；tasks 从任务 kind 字段）
4. truncate=true 时裁剪（未完成+高优先级优先，取前 N，N=设置阈值）
5. 按 kind 选 prompt（task 总结 / note 摘要）
6. 返回 `{ ok, content, count, kind, truncated }`

### 数据查询

- **list**：`tasks WHERE list_id=$id AND parent_id IS NULL`
- **folder**：递归 CTE 找子树，只取 isFolder=0 的清单 id，再查任务：
  ```sql
  WITH RECURSIVE subtree(id, is_folder) AS (
    SELECT id, is_folder FROM lists WHERE id=$1
    UNION ALL SELECT l.id, l.is_folder FROM lists l JOIN subtree s ON l.parent_id=s.id
  )
  SELECT t.* FROM tasks t WHERE t.parent_id IS NULL
    AND t.list_id IN (SELECT id FROM subtree WHERE is_folder = 0)
  ```
- **tasks**：`tasks WHERE id IN ($ids)`

### prompt 区分

- **task 总结**：完成情况、待办、优先级、小结（鼓励语气）
- **note 摘要**：笔记主题、内容要点、关键词

---

## 四、前端

### DailySummaryModal 扩展

加 `scope` prop：
```ts
type SummaryScope =
  | { type: "list" | "folder"; id: string; name: string; kind: "task" | "note" }
  | { type: "tasks"; ids: string[] };
```
- 不传 scope = smart 模式（兼容顶栏每日/周报现状）
- 按 scope.type 调 generateScopeSummary
- 标题动态：「XXX 清单总结」/「选中 N 项总结」/「每日小结」/「周报」
- 超阈值（count > 设置阈值）：调一次拿 count → 弹确认「共 N 项，是否裁剪？」→ 确认后带 truncate=true 重调
- smart 模式保留每日/周报 radio；其他模式隐藏 radio

### 跨组件 scope 传递

taskStore 加临时 `pendingSummaryScope` ref。侧边栏/批量菜单设置它 + 打开弹窗，DailySummaryModal 读取它。

### 三个入口

1. **TheSidebar**：清单+目录右键菜单加「AI 总结」（仅 aiEnabled 显示）
2. **BatchContextMenu**：批量菜单加「AI 总结」（删除之前）
3. **AppLayout**：DailySummaryModal 接 scope prop

---

## 五、改动文件

### 后端
- `commands.rs`：新增 `ai_summary_scope`
- `lib.rs`：注册

### 前端
- `api/ai.ts`：加 generateScopeSummary + SummaryScope 类型
- `stores/settings.ts`：加 aiSummaryTruncateThreshold
- `stores/task.ts`：加 pendingSummaryScope
- `components/DailySummaryModal.vue`：扩展 scope
- `components/TheSidebar.vue`：右键菜单加项
- `components/BatchContextMenu.vue`：批量菜单加项
- `layouts/AppLayout.vue`：传 scope
- `views/SettingsView.vue`：裁剪阈值输入框

---

## 六、不做的事
- 流式输出 / 总结历史归档
- 多选含子任务
- 迁移每日/周报到新命令（保持现状）
- 标签总结（未要求）
