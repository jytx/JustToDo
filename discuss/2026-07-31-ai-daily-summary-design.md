# AI 每日小结 / 周报功能设计（2026-07-31）

> 用途：评审「每日小结 + 周报」AI 功能的方案。
> 基于 [[ai-provider-abstraction]] 抽象层，纯读数据 + AI 生成文本。
> 关联：`discuss/2026-07-30-future-features-roadmap.md`（P1：AI 助手）

---

## 一、功能目标

用户一键生成「今日小结」或「本周周报」：
- 汇总今天/本周完成的任务、今天截止/逾期的待办
- AI 用鼓励的语气生成结构化 Markdown 小结
- 可一键保存为笔记，留存历史

---

## 二、已确认决策

| 决策点 | 选择 |
|--------|------|
| 范围 | 每日小结（今天）+ 周报（本周）双模式 |
| 入口 | 顶栏按钮 + 快捷键 Cmd+Shift+D |
| 展示 | 弹窗展示 Markdown，可一键保存为笔记 |
| 流式输出 | 不做，一次性返回 |
| 自动定时 | 不做，第一版手动触发 |
| tools | 不用，纯文本生成 |

---

## 三、数据来源

核心缺口：后端无「按 completed_at 查已完成任务」的查询，需新增。

### 新增查询：`task_get_completed_in_range(start, end)`

```sql
SELECT * FROM tasks
WHERE done = 1 AND parent_id IS NULL AND kind='task'
  AND completed_at IS NOT NULL
  AND datetime(replace(completed_at,'T',' '),'localtime') >= datetime($1,'localtime')
  AND datetime(replace(completed_at,'T',' '),'localtime') <  datetime($2,'localtime')
ORDER BY completed_at DESC
```

### 时间范围计算

- **每日**：今天 00:00 ~ 明天 00:00
- **周报**：本周一 00:00 ~ 下周一 00:00（周一为一周开始）

### 数据组装（传给 AI）

| 分类 | 数据来源 | 每日 | 周报 |
|------|----------|------|------|
| 已完成 | `task_get_completed_in_range` | 今天完成 | 本周完成 |
| 待办（今天截止/逾期） | `task_get_smart_view("today")` 逻辑 | ✓ | ✓ |
| 本周剩余 | `task_get_smart_view("upcoming")` 逻辑 | ✗ | ✓ |

---

## 四、AI 调用

```rust
let provider = build_from_settings(pool).await?;  // 含 enabled/key 校验
let req = ChatRequest {
    messages: vec![
        ChatMessage::system { content: SYSTEM_PROMPT },
        ChatMessage::user { content: serde_json::to_string(&payload)? },
    ],
    ..Default::default()  // 不用 tools
};
let resp = provider.chat(&req).await?;
// resp.content 就是 Markdown 小结
```

### System Prompt 要点
- 角色：任务总结助手
- 输出：简洁 Markdown（## 今日完成 / ## 待办提醒 / ## 小结）
- 语气：鼓励、肯定成绩
- 语言：简体中文

---

## 五、改动文件清单

### 后端（src-tauri/）
- `commands.rs`：新增 `task_get_completed_in_range` + `ai_summary`
- `lib.rs`：注册两个命令

### 前端
- `api/db.ts`：加 `getCompletedTasksInRange`
- `api/ai.ts`（新增）：`generateSummary(mode)`
- `components/DailySummaryModal.vue`（新增）：弹窗组件
- `layouts/AppLayout.vue`：顶栏按钮 + 挂载弹窗
- `composables/useShortcuts.ts`：加 Cmd+Shift+D

---

## 六、存为笔记

用项目已有的 `marked` 库把 Markdown 转 HTML：
```ts
const html = marked(content);
const note = await createTask({ title: `每日小结 ${today}`, listId: 'default-notebook', kind: 'note' });
await updateTask(note.id, { note: html });
```
