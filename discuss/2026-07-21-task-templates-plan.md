# 任务模板功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页新增「模板」section，让用户维护一组任务预设（名称 + 标题 + 富文本备注），支持新建/编辑/重命名/删除/应用模板创建任务。

**Architecture:** 模板独立存 SQLite `templates` 表（与 tasks 表解耦），通过 4 个 Rust 命令暴露 CRUD。「应用模板」= `taskStore.createTask()` + `db.updateTask(newId, { note })` 两步（因为 `task_create` 不接受 note）。全局默认清单走 settings store 的 KV 表。

**Tech Stack:** Tauri 2.x / Rust（sqlx）/ Vue 3.5 `<script setup>` / Pinia / Arco Design Vue / Tiptap（已有 RichTextEditor）

**Spec:** `discuss/2026-07-21-task-templates-design.md`

**验证手段说明（重要）：** 本项目无自动化测试框架（Tauri 桌面应用）。每个任务的"验证"步骤用：
- Rust 改动 → `cd src-tauri && cargo check`（在 src-tauri 下执行）
- 前端改动 → `npx vue-tsc --noEmit`（在项目根）
- 联调验证 → `bash scripts/dev.sh` 启动应用手动测试（仅功能任务需要）

---

## 文件结构（实施前总览）

**新建文件：**

| 文件 | 职责 |
|---|---|
| `src-tauri/src/db/migrations/014_templates.sql` | 建表 + seed 4 个内置模板（幂等） |
| `src/stores/template.ts` | Pinia store：CRUD + applyTemplate |
| `src/components/TemplateSection.vue` | 设置页模板 section 容器（上下两块） |
| `src/components/TemplateCard.vue` | 单张模板卡片（极简卡） |
| `src/components/TemplateEditModal.vue` | 新建/编辑弹窗（分区式，富文本） |
| `src/components/TemplateRenameModal.vue` | 重命名弹窗 |

**修改文件：**

| 文件 | 改动点 |
|---|---|
| `src-tauri/src/db/mod.rs` | 注册 `run_migration_014`，读 SQL 文件执行 |
| `src-tauri/src/models.rs` | 追加 `Template` / `CreateTemplateInput` / `UpdateTemplateInput` |
| `src-tauri/src/commands.rs` | 追加 4 个 `template_*` 命令 + `row_to_template` 工具函数 |
| `src-tauri/src/lib.rs` | `generate_handler!` 列表登记 4 个新命令 |
| `src/types/index.ts` | 追加 `Template` / `TemplateForm` 接口 |
| `src/api/db.ts` | 追加 4 个 `template_*` 封装 + `mapTemplate` |
| `src/stores/settings.ts` | `SETTINGS_KEYS` 加 `templateDefaultListId`，state/persist/initialize 接入 |
| `src/views/SettingsView.vue` | nav 加「模板」项 + `<TemplateSection>` |
| `src/App.vue` 或 `src/main.ts` | 初始化时 `templateStore.loadTemplates()` |

---

## Task 1：Rust 数据模型 + Migration

**Files:**
- Create: `src-tauri/src/db/migrations/014_templates.sql`
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/models.rs`

- [ ] **Step 1.1：创建 migration SQL 文件**

创建 `src-tauri/src/db/migrations/014_templates.sql`：

```sql
-- 014: 任务模板表
-- 模板是"任务参数预设"，独立于 tasks 表。"应用模板"时由前端走
-- taskStore.createTask + db.updateTask(note) 两步落库。
-- 内置模板用固定 id（tpl-meeting 等），INSERT OR IGNORE 保证幂等：
-- 重复执行 migration 不报错、不覆盖用户改动。

CREATE TABLE IF NOT EXISTS templates (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    is_builtin   INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_position ON templates(position);

-- 内置模板 4 个（固定 id，position 从 1 开始递增便于将来插队）
-- note 用单引号包裹的 HTML；内部双引号用 &quot; 转义避免 SQL 字符串提前结束
INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-meeting',
 '会议纪要',
 '{{date}} 会议纪要',
 '<p><strong>会议：</strong>______</p><p><strong>时间：</strong>______</p><p><strong>参会：</strong>______</p><p><strong>议题：</strong></p><ul><li>议题一</li><li>议题二</li></ul><p><strong>结论 &amp; Action：</strong></p><ul><li>决定 1 —— 负责人 / 截止</li></ul>',
 1,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');

INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-weekly',
 '周报',
 '{{date}} 周报',
 '<p><strong>本周完成：</strong></p><ul><li></li></ul><p><strong>下周计划：</strong></p><ul><li></li></ul><p><strong>阻塞 / 风险：</strong></p><ul><li></li></ul>',
 2,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');

INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-codereview',
 '代码审查',
 '代码审查：{{title}}',
 '<p><strong>PR：</strong>______</p><p><strong>优点：</strong></p><ul><li></li></ul><p><strong>问题：</strong></p><ul><li></li></ul><p><strong>建议：</strong></p><ul><li></li></ul>',
 3,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');

INSERT OR IGNORE INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES
('tpl-reading',
 '读书笔记',
 '《{{book}}》读书笔记',
 '<p><strong>书名：</strong>______</p><p><strong>作者：</strong>______</p><p><strong>核心观点：</strong></p><ul><li></li></ul><p><strong>摘录：</strong></p><blockquote></blockquote><p><strong>启发 / 行动：</strong></p><ul><li></li></ul>',
 4,
 '2026-07-21T00:00:00',
 '2026-07-21T00:00:00');
```

- [ ] **Step 1.2：在 `db/mod.rs` 注册 migration**

修改 `src-tauri/src/db/mod.rs`：

(a) 在文件顶部常量区（`MIGRATIONS_002` 下方，第 9 行后）追加：

```rust
pub const MIGRATIONS_014: &str = include_str!("migrations/014_templates.sql");
```

(b) 在 `init_pool` 函数里，`run_migration_013(&pool).await?;` 之后、`Ok(pool)` 之前追加：

```rust
    // 014: 任务模板表 + 内置模板 seed
    // 纯 SQL（建表 + INSERT OR IGNORE），与 001/002 同模式（幂等）
    sqlx::query(MIGRATIONS_014)
        .execute(&pool)
        .await
        .map_err(|e| format!("执行迁移 014_templates 失败: {}", e))?;
```

> 注意：因为 014 是纯 SQL 幂等，**不需要写 `run_migration_014` Rust 函数**，直接在 init_pool 里 `sqlx::query(MIGRATIONS_014).execute()` 即可（与 001/002 一致）。

- [ ] **Step 1.3：在 `models.rs` 追加数据模型**

在 `src-tauri/src/models.rs` 文件末尾追加：

```rust
/// 任务模板 —— "任务参数预设"，独立于 tasks 表
/// 应用模板时由前端 taskStore.createTask + db.updateTask(note) 两步落库
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub title: String,
    /// HTML 富文本（RichTextEditor 输出）
    pub note: String,
    pub is_builtin: bool,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建模板的参数（id/时间戳由 Rust 端生成）
#[derive(Debug, Deserialize)]
pub struct CreateTemplateInput {
    pub name: String,
    pub title: String,
    pub note: String,
}

/// 更新模板的参数（所有字段可选；与 UpdateTaskInput 同模式）
#[derive(Debug, Deserialize)]
pub struct UpdateTemplateInput {
    pub name: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
}
```

- [ ] **Step 1.4：验证 Rust 编译**

Run（在 `src-tauri/` 目录下）:
```bash
cd src-tauri && cargo check
```
Expected: 无错误（可能有 unused warning，忽略）。若有错误，检查 SQL 文件路径是否正确、struct 字段是否拼写一致。

---

## Task 2：Rust 命令 + 注册

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 2.1：在 `commands.rs` 追加模板命令**

在 `src-tauri/src/commands.rs` 文件**末尾**追加（注意文件已 `use crate::models::*;`，无需新加 import）：

```rust
// ─── 模板操作 ────────────────────────────────────────────
// 模板是"任务参数预设"，独立于 tasks 表。
// 应用模板由前端编排：taskStore.createTask + db.updateTask(note)。

/// 从行数据提取 Template（is_builtin 是 0/1 整数）
fn row_to_template(row: &sqlx::sqlite::SqliteRow) -> Template {
    Template {
        id: row.get("id"),
        name: row.get("name"),
        title: row.get("title"),
        note: row.get("note"),
        is_builtin: row.get::<i32, _>("is_builtin") != 0,
        position: row.get("position"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

#[tauri::command]
pub async fn template_get_all(pool: State<'_, sqlx::SqlitePool>) -> CmdResult<Vec<Template>> {
    let rows = sqlx::query(
        "SELECT id, name, title, note, is_builtin, position, created_at, updated_at FROM templates ORDER BY position ASC, created_at ASC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("查询模板失败: {}", e))?;

    Ok(rows.iter().map(row_to_template).collect())
}

#[tauri::command]
pub async fn template_create(
    pool: State<'_, sqlx::SqlitePool>,
    input: CreateTemplateInput,
) -> CmdResult<Template> {
    let id = uuid();
    let ts = now();
    // position 取当前最大值 + 1000，保证新模板排在最后
    let max_pos: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position), 0) FROM templates")
        .fetch_one(pool.inner())
        .await
        .map_err(|e| format!("查询模板 position 失败: {}", e))?;
    let position = max_pos + 1000;

    sqlx::query(
        "INSERT INTO templates (id, name, title, note, is_builtin, position, created_at, updated_at) VALUES ($1, $2, $3, $4, 0, $5, $6, $7)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.title)
    .bind(&input.note)
    .bind(position)
    .bind(&ts)
    .bind(&ts)
    .execute(pool.inner())
    .await
    .map_err(|e| format!("创建模板失败: {}", e))?;

    Ok(Template {
        id,
        name: input.name,
        title: input.title,
        note: input.note,
        is_builtin: false,
        position,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

#[tauri::command]
pub async fn template_update(
    pool: State<'_, sqlx::SqlitePool>,
    id: String,
    input: UpdateTemplateInput,
) -> CmdResult<()> {
    let ts = now();

    // 逐字段更新（与 task_update 同模式；任一字段 Some 则更新该字段）
    if let Some(name) = &input.name {
        sqlx::query("UPDATE templates SET name = $1, updated_at = $2 WHERE id = $3")
            .bind(name)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新模板失败: {}", e))?;
    }
    if let Some(title) = &input.title {
        sqlx::query("UPDATE templates SET title = $1, updated_at = $2 WHERE id = $3")
            .bind(title)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新模板失败: {}", e))?;
    }
    if let Some(note) = &input.note {
        sqlx::query("UPDATE templates SET note = $1, updated_at = $2 WHERE id = $3")
            .bind(note)
            .bind(&ts)
            .bind(&id)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("更新模板失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn template_delete(pool: State<'_, sqlx::SqlitePool>, id: String) -> CmdResult<()> {
    sqlx::query("DELETE FROM templates WHERE id = $1")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| format!("删除模板失败: {}", e))?;
    Ok(())
}
```

- [ ] **Step 2.2：在 `lib.rs` 注册命令**

修改 `src-tauri/src/lib.rs`，在 `generate_handler![...]` 列表末尾（`commands::task_get_by_tag,` 之后、`]` 之前）追加：

```rust
            commands::task_get_by_tag,
            commands::template_get_all,
            commands::template_create,
            commands::template_update,
            commands::template_delete,
        ]);
```

- [ ] **Step 2.3：验证 Rust 编译**

Run（在 `src-tauri/` 目录下）:
```bash
cd src-tauri && cargo check
```
Expected: 无错误。

- [ ] **Step 2.4：Commit**

```bash
git add src-tauri/src/db/migrations/014_templates.sql src-tauri/src/db/mod.rs src-tauri/src/models.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(template): Rust 端模板表 + 4 个 CRUD 命令

- 新增 migration 014：templates 表 + 4 个内置模板 seed
- models.rs 追加 Template / Create/UpdateTemplateInput
- commands.rs 追加 template_get_all/create/update/delete
- lib.rs generate_handler 注册新命令"
```

---

## Task 3：前端类型 + IPC 封装

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/api/db.ts`

- [ ] **Step 3.1：在 `types/index.ts` 追加接口**

在 `src/types/index.ts` 文件**末尾**追加：

```ts
/** 任务模板 —— "任务参数预设"，独立于 tasks 表 */
export interface Template {
  id: string;
  name: string;
  /** 应用模板时作为新任务的 title */
  title: string;
  /** HTML 富文本（RichTextEditor 输出） */
  note: string;
  /** 是否内置预装（用户仍可改/删） */
  isBuiltin: boolean;
  /** 排序权重（MVP 不暴露 UI） */
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** 模板编辑表单（弹窗内 v-model 绑定用；id 为 null 表示新建模式） */
export interface TemplateForm {
  id: string | null;
  name: string;
  title: string;
  note: string;
}
```

- [ ] **Step 3.2：在 `db.ts` 追加封装**

在 `src/api/db.ts`：

(a) 在顶部 import 行（第 6 行）追加 `Template`：

```ts
import type { List, Task, Priority, RecurrenceFreq, ChecklistItem, Template } from "@/types";
```

(b) 在文件**末尾**追加（参考 `mapTask` 模式）：

```ts
// ─── 模板操作 ────────────────────────────────────────────

/** Rust 端返回的模板行（snake_case） */
interface RustTemplate {
  id: string;
  name: string;
  title: string;
  note: string;
  is_builtin: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Rust 行 → 前端 camelCase */
function mapTemplate(r: RustTemplate): Template {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    note: r.note,
    isBuiltin: r.is_builtin,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getTemplates(): Promise<Template[]> {
  const rows = await invoke<RustTemplate[]>("template_get_all");
  return rows.map(mapTemplate);
}

export async function createTemplate(params: {
  name: string;
  title: string;
  note: string;
}): Promise<Template> {
  const input = {
    name: params.name,
    title: params.title,
    note: params.note,
  };
  const r = await invoke<RustTemplate>("template_create", { input });
  return mapTemplate(r);
}

export async function updateTemplate(
  id: string,
  fields: { name?: string; title?: string; note?: string },
): Promise<void> {
  const input: Record<string, unknown> = {
    name: fields.name,
    title: fields.title,
    note: fields.note,
  };
  await invoke<void>("template_update", { id, input });
}

export async function deleteTemplate(id: string): Promise<void> {
  await invoke<void>("template_delete", { id });
}
```

- [ ] **Step 3.3：验证类型检查**

Run（在项目根）:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。若报 `Cannot find name 'Template'`，检查 import 路径。

- [ ] **Step 3.4：Commit**

```bash
git add src/types/index.ts src/api/db.ts
git commit -m "feat(template): 前端 Template 类型 + IPC 封装"
```

---

## Task 4：settings store 接入全局默认清单

**Files:**
- Modify: `src/stores/settings.ts`

- [ ] **Step 4.1：追加 SETTINGS_KEYS 与默认值常量**

修改 `src/stores/settings.ts`：

(a) 在 `SETTINGS_KEYS` 对象（第 16-23 行）末尾追加一项：

```ts
export const SETTINGS_KEYS = {
  themeMode: "theme_mode",
  accentColor: "accent_color",
  newTasksDueToday: "new_tasks_due_today",
  recurrenceCheckInterval: "recurrence_check_interval",
  startupView: "startup_view",
  zoomLevel: "zoom_level",
  templateDefaultListId: "template_default_list_id",
} as const;
```

(b) 在第 34 行 `DEFAULT_STARTUP_VIEW` 后追加默认值常量：

```ts
const DEFAULT_STARTUP_VIEW: StartupView = "today";

/** 模板应用时的默认目标清单 id（'inbox' 是预置不可删清单） */
const DEFAULT_TEMPLATE_LIST_ID = "inbox";
```

- [ ] **Step 4.2：追加 ref + 解析 + initialize 接入**

(a) 在 `parseStartupView` 函数（约第 70-75 行）下方追加解析函数：

```ts
/** 解析模板默认清单 id；空或不存在则回落到 inbox */
function parseTemplateListId(v: string | null): string {
  if (v && v.trim()) return v;
  return DEFAULT_TEMPLATE_LIST_ID;
}
```

(b) 在 store 内 state 区（`const startupView = ...` 与 `const zoomLevel = ...` 之间，约第 95-96 行）追加：

```ts
const templateDefaultListId = ref<string>(DEFAULT_TEMPLATE_LIST_ID);
```

(c) 修改 `initialize` 函数的 `Promise.all`（约第 139-146 行），追加一项读取：

```ts
      const [themeRaw, accentRaw, dueTodayRaw, intervalRaw, startupRaw, zoomRaw, tplListRaw] = await Promise.all([
        db.getSetting(SETTINGS_KEYS.themeMode).catch(() => null),
        db.getSetting(SETTINGS_KEYS.accentColor).catch(() => null),
        db.getSetting(SETTINGS_KEYS.newTasksDueToday).catch(() => null),
        db.getSetting(SETTINGS_KEYS.recurrenceCheckInterval).catch(() => null),
        db.getSetting(SETTINGS_KEYS.startupView).catch(() => null),
        db.getSetting(SETTINGS_KEYS.zoomLevel).catch(() => null),
        db.getSetting(SETTINGS_KEYS.templateDefaultListId).catch(() => null),
      ]);

      const mode = parseThemeMode(themeRaw);
      const accent = parseAccentColor(accentRaw);
      const dueToday = parseBoolean(dueTodayRaw, DEFAULT_NEW_TASKS_DUE_TODAY);
      const interval = parseIntervalMinutes(intervalRaw);
      const startup = parseStartupView(startupRaw);
      const zoom = parseZoomLevel(zoomRaw);
      const tplList = parseTemplateListId(tplListRaw);

      themeMode.value = mode;
      accentColor.value = accent;
      newTasksDueToday.value = dueToday;
      recurrenceCheckInterval.value = interval;
      startupView.value = startup;
      zoomLevel.value = zoom;
      templateDefaultListId.value = tplList;
```

(d) 在 `setStartupView` 函数（约第 235-243 行）后追加 setter：

```ts
/** 修改模板默认清单并持久化 */
async function setTemplateDefaultListId(v: string): Promise<void> {
  if (!v || !v.trim()) return;
  const prev = templateDefaultListId.value;
  templateDefaultListId.value = v;
  const ok = await persist(SETTINGS_KEYS.templateDefaultListId, v, prev);
  if (!ok) {
    templateDefaultListId.value = prev;
  }
}
```

(e) 在 store 的 return 对象（约第 314-337 行）追加暴露：

```ts
  return {
    // state
    themeMode,
    accentColor,
    newTasksDueToday,
    recurrenceCheckInterval,
    startupView,
    zoomLevel,
    templateDefaultListId,
    initialized,
    loading,
    error,
    // actions
    initialize,
    setThemeMode,
    setAccentColor,
    setNewTasksDueToday,
    setRecurrenceCheckInterval,
    setStartupView,
    setTemplateDefaultListId,
    cycleTheme,
    zoomIn,
    zoomOut,
    zoomReset,
    isSaving,
  };
```

- [ ] **Step 4.3：验证类型检查**

Run（在项目根）:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 4.4：Commit**

```bash
git add src/stores/settings.ts
git commit -m "feat(template): settings store 接入全局默认清单"
```

---

## Task 5：template store

**Files:**
- Create: `src/stores/template.ts`

- [ ] **Step 5.1：创建 store 文件**

创建 `src/stores/template.ts`：

```ts
// 模板 store —— 管理"任务参数预设"的 CRUD + applyTemplate 编排
// 模板独立存 templates 表；应用模板时由本 store 调用 taskStore + db 完成任务创建
// 遵循 AGENTS.md：store 作为唯一数据源，组件只读取不缓存

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { Template, TemplateForm, Task } from "@/types";
import * as db from "@/api/db";
import { useTaskStore } from "@/stores/task";
import { useSettingsStore } from "@/stores/settings";

export const useTemplateStore = defineStore("template", () => {
  const templates = ref<Template[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** 按 position 升序（与 Rust 端 ORDER BY 一致；computed 仅为保持引用稳定） */
  const sortedTemplates = computed(() =>
    [...templates.value].sort((a, b) => a.position - b.position),
  );

  /** 从 DB 加载全部模板（App 初始化时调用） */
  async function loadTemplates(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      templates.value = await db.getTemplates();
    } catch (e) {
      error.value = String(e);
      console.error("[templateStore] loadTemplates 失败:", e);
    } finally {
      loading.value = false;
    }
  }

  /** 新建模板 */
  async function createTemplate(params: {
    name: string;
    title: string;
    note: string;
  }): Promise<Template> {
    const tpl = await db.createTemplate(params);
    templates.value.push(tpl);
    return tpl;
  }

  /** 更新模板（partial fields；不传的字段不动） */
  async function updateTemplate(
    id: string,
    fields: { name?: string; title?: string; note?: string },
  ): Promise<void> {
    await db.updateTemplate(id, fields);
    // 同步本地
    const idx = templates.value.findIndex((t) => t.id === id);
    if (idx >= 0) {
      const cur = templates.value[idx];
      templates.value[idx] = {
        ...cur,
        name: fields.name ?? cur.name,
        title: fields.title ?? cur.title,
        note: fields.note ?? cur.note,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /** 重命名（封装 updateTemplate 仅传 name） */
  async function renameTemplate(id: string, name: string): Promise<void> {
    await updateTemplate(id, { name });
  }

  /** 删除 */
  async function deleteTemplate(id: string): Promise<void> {
    await db.deleteTemplate(id);
    templates.value = templates.value.filter((t) => t.id !== id);
  }

  /**
   * 应用模板：先保存表单 → 创建任务 → 写 note → 打开详情面板
   *
   * 入参 form.id === null 表示新建模式（先创建模板拿到 id）
   * 返回新建的 Task 对象，供调用方做后续 UI 反馈
   */
  async function applyTemplate(form: TemplateForm): Promise<Task> {
    if (!form.name.trim()) {
      throw new Error("模板名称不能为空");
    }

    // 1. 落库模板
    let templateId: string;
    if (form.id === null) {
      const tpl = await createTemplate({
        name: form.name,
        title: form.title,
        note: form.note,
      });
      templateId = tpl.id;
    } else {
      await updateTemplate(form.id, {
        name: form.name,
        title: form.title,
        note: form.note,
      });
      templateId = form.id;
    }

    // 2. 读取全局默认清单
    const settings = useSettingsStore();
    const listId = settings.templateDefaultListId || "inbox";

    // 3. 创建任务
    const taskStore = useTaskStore();
    const task = await taskStore.createTask({
      title: form.title || form.name,
      listId,
    });

    // 4. 写 note（task_create 不接受 note，必须二次 update）
    if (form.note) {
      await db.updateTask(task.id, { note: form.note });
    }

    // 5. 打开详情面板
    await taskStore.selectTask(task.id);

    return { ...task, note: form.note };
  }

  return {
    templates,
    sortedTemplates,
    loading,
    error,
    loadTemplates,
    createTemplate,
    updateTemplate,
    renameTemplate,
    deleteTemplate,
    applyTemplate,
  };
});
```

- [ ] **Step 5.2：验证类型检查**

Run:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 5.3：Commit**

```bash
git add src/stores/template.ts
git commit -m "feat(template): template Pinia store（CRUD + applyTemplate）"
```

---

## Task 6：启动加载模板

**Files:**
- Modify: `src/App.vue` 或 `src/main.ts`（取决于现有初始化位置）

- [ ] **Step 6.1：定位现有初始化入口**

Run:
```bash
grep -n "loadLists\|initialize\|loadHabits" src/App.vue src/main.ts
```
找到 `listStore.loadLists()` 的调用位置（大概率在 `App.vue` 的 `onMounted`）。以下假设在 `App.vue`，若在 `main.ts` 同理改。

- [ ] **Step 6.2：追加 templateStore.loadTemplates()**

在 `src/App.vue` 的 `<script setup>` 顶部 import 区追加：

```ts
import { useTemplateStore } from "@/stores/template";
```

在 store 实例化区（与 `useListStore()` 同区域）追加：

```ts
const templateStore = useTemplateStore();
```

在 `onMounted` 里 `listStore.loadLists()` 调用旁边追加：

```ts
templateStore.loadTemplates();
```

（与 `loadLists` 同批次，无需 await，后台并行加载即可）

- [ ] **Step 6.3：验证类型检查**

Run:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 6.4：Commit**

```bash
git add src/App.vue
git commit -m "feat(template): 启动时加载模板列表"
```

---

## Task 7：TemplateCard 组件

**Files:**
- Create: `src/components/TemplateCard.vue`

- [ ] **Step 7.1：创建卡片组件**

创建 `src/components/TemplateCard.vue`：

```vue
<script setup lang="ts">
// 模板卡片 —— 极简卡风格
// · 整卡 click → 打开编辑弹窗（emit 'edit'）
// · 右上「⋯」按钮 → 菜单（emit 'rename' / 'delete'）
// · 正文区显示 note 前 3 行纯文本预览（HTML → textContent 截断）
import { computed, ref } from "vue";
import type { Template } from "@/types";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = defineProps<{ template: Template }>();
const emit = defineEmits<{
  edit: [template: Template];
  rename: [template: Template];
  delete: [template: Template];
}>();

const menuOpen = ref(false);

/** 内置模板的 emoji 图标（按 id 匹配；其它一律 📄） */
const icon = computed<string>(() => {
  switch (props.template.id) {
    case "tpl-meeting":
      return "📝";
    case "tpl-weekly":
      return "📊";
    case "tpl-codereview":
      return "👀";
    case "tpl-reading":
      return "📖";
    default:
      return "📄";
  }
});

/** 把 HTML 转纯文本并截前 3 行 */
const previewText = computed<string>(() => {
  try {
    const doc = new DOMParser().parseFromString(props.template.note, "text/html");
    const text = doc.body.textContent ?? "";
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.slice(0, 3).join("\n");
  } catch {
    return "";
  }
});

function onEdit() {
  emit("edit", props.template);
}
function onRename() {
  menuOpen.value = false;
  emit("rename", props.template);
}
function onDelete() {
  menuOpen.value = false;
  emit("delete", props.template);
}
</script>

<template>
  <div class="tpl-card" @click="onEdit">
    <div class="tpl-card__header">
      <span class="tpl-card__icon">{{ icon }}</span>
      <span class="tpl-card__name" :title="template.name">{{ template.name }}</span>
      <MenuPopover v-model:visible="menuOpen" placement="bottom-right">
        <template #trigger>
          <button class="tpl-card__menu" title="更多操作" @click.stop>
            ⋯
          </button>
        </template>
        <MenuPopoverItem @click="onRename">重命名</MenuPopoverItem>
        <MenuPopoverItem danger @click="onDelete">删除</MenuPopoverItem>
      </MenuPopover>
    </div>
    <div v-if="previewText" class="tpl-card__preview">{{ previewText }}</div>
    <div v-else class="tpl-card__preview tpl-card__preview--empty">(空白模板)</div>
  </div>
</template>

<style scoped>
.tpl-card {
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 110px;
}
.tpl-card:hover {
  border-color: var(--jt-text-tertiary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.tpl-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tpl-card__icon {
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
}
.tpl-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tpl-card__menu {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
  transition: background-color 0.12s, color 0.12s;
}
.tpl-card__menu:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.tpl-card__preview {
  font-size: 12px;
  color: var(--jt-text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  border-top: 1px dashed var(--jt-border);
  padding-top: 8px;
}
.tpl-card__preview--empty {
  color: var(--jt-text-tertiary);
  font-style: italic;
}
</style>
```

- [ ] **Step 7.2：验证类型检查**

Run:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 7.3：Commit**

```bash
git add src/components/TemplateCard.vue
git commit -m "feat(template): TemplateCard 极简卡组件"
```

---

## Task 8：TemplateEditModal 组件

**Files:**
- Create: `src/components/TemplateEditModal.vue`

- [ ] **Step 8.1：创建编辑弹窗组件**

创建 `src/components/TemplateEditModal.vue`：

```vue
<script setup lang="ts">
// 模板编辑/新建弹窗 —— 分区式（头部 + 任务标题 + 富文本 + footer）
// · 编辑模式（template prop 非 null）：预填表单，footer「保存模板」走 updateTemplate
// · 新建模式（template prop 为 null）：空表单，footer「保存模板」走 createTemplate
// · 「应用模板」走 templateStore.applyTemplate（内部含保存逻辑）
// · 「取消」直接关弹窗（MVP 不做"放弃改动"二次确认）
import { ref, watch, computed } from "vue";
import { Message } from "@arco-design/web-vue";
import type { Template, TemplateForm } from "@/types";
import { useTemplateStore } from "@/stores/template";
import { useTaskStore } from "@/stores/task";
import RichTextEditor from "./RichTextEditor.vue";

const props = defineProps<{
  visible: boolean;
  /** 非 null = 编辑模式；null = 新建模式 */
  template: Template | null;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
  /** 创建/保存成功后通知父组件（用于刷新列表等） */
  saved: [];
  /** 应用模板成功后通知父组件关闭弹窗 */
  applied: [];
}>();

const templateStore = useTemplateStore();
const taskStore = useTaskStore();

const isEdit = computed(() => props.template !== null);

/** 表单状态：每次 visible 打开时根据 template 重置 */
const form = ref<TemplateForm>({ id: null, name: "", title: "", note: "" });
const applying = ref(false);
const saving = ref(false);

/** visible 由 false → true 时初始化表单 */
watch(
  () => props.visible,
  (open) => {
    if (open) {
      if (props.template) {
        form.value = {
          id: props.template.id,
          name: props.template.name,
          title: props.template.title,
          note: props.template.note,
        };
      } else {
        form.value = { id: null, name: "", title: "", note: "" };
      }
    }
  },
  { immediate: true },
);

function close() {
  emit("update:visible", false);
}

/** 校验表单：name 必填 */
function validate(): boolean {
  if (!form.value.name.trim()) {
    Message.error("请填写模板名称");
    return false;
  }
  return true;
}

/** 保存模板：新建走 createTemplate，编辑走 updateTemplate */
async function onSave() {
  if (!validate()) return;
  saving.value = true;
  try {
    if (form.value.id === null) {
      await templateStore.createTemplate({
        name: form.value.name,
        title: form.value.title,
        note: form.value.note,
      });
      Message.success("已创建模板");
    } else {
      await templateStore.updateTemplate(form.value.id, {
        name: form.value.name,
        title: form.value.title,
        note: form.value.note,
      });
      Message.success("已保存模板");
    }
    emit("saved");
    close();
  } catch (e) {
    Message.error("保存失败：" + String(e));
  } finally {
    saving.value = false;
  }
}

/** 应用模板：保存 + 创建任务 + 打开详情（由 store 编排） */
async function onApply() {
  if (!validate()) return;
  applying.value = true;
  try {
    await templateStore.applyTemplate(form.value);
    Message.success("已创建任务");
    emit("applied");
    close();
  } catch (e) {
    Message.error("应用模板失败：" + String(e));
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="640"
    :footer="false"
    :mask-closable="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="template-edit-modal"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div class="tpl-edit">
      <!-- 头部：模式标识 + 模板名 -->
      <header class="tpl-edit__header">
        <span class="tpl-edit__label">
          {{ isEdit ? "编辑模板" : "新建模板" }}
        </span>
        <input
          v-model="form.name"
          class="tpl-edit__name-input"
          placeholder="模板名称"
          maxlength="60"
        />
      </header>

      <!-- 任务标题分区 -->
      <section class="tpl-edit__field">
        <label class="tpl-edit__field-label">任务标题</label>
        <input
          v-model="form.title"
          class="tpl-edit__field-input"
          placeholder="应用模板时新任务的标题（可留空，默认用模板名）"
          maxlength="120"
        />
      </section>

      <!-- 富文本分区（主体） -->
      <section class="tpl-edit__field tpl-edit__field--rich">
        <label class="tpl-edit__field-label">备注（富文本）</label>
        <div class="tpl-edit__rich-wrap">
          <RichTextEditor v-model="form.note" placeholder="支持富文本、图片粘贴..." />
        </div>
      </section>

      <!-- footer -->
      <footer class="tpl-edit__footer">
        <a-button @click="close">取消</a-button>
        <a-button type="outline" :loading="saving" @click="onSave">保存模板</a-button>
        <a-button type="primary" :loading="applying" @click="onApply">应用模板</a-button>
      </footer>
    </div>
  </a-modal>
</template>

<style scoped>
.tpl-edit {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
}

.tpl-edit__header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tpl-edit__label {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tpl-edit__name-input {
  border: none;
  outline: none;
  background: transparent;
  font-size: 18px;
  font-weight: 600;
  color: var(--jt-text-primary);
  padding: 2px 0;
  font-family: var(--font-display);
}
.tpl-edit__name-input::placeholder {
  color: var(--jt-text-tertiary);
  font-weight: 500;
}

.tpl-edit__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tpl-edit__field-label {
  font-size: 11px;
  color: var(--jt-text-secondary);
  font-weight: 500;
}
.tpl-edit__field-input {
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--jt-text-primary);
  background: var(--jt-surface);
  outline: none;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.tpl-edit__field-input:focus {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}

.tpl-edit__field--rich {
  flex: 1;
}
.tpl-edit__rich-wrap {
  min-height: 240px;
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  overflow: hidden;
}
.tpl-edit__rich-wrap:focus-within {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}

.tpl-edit__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--jt-border);
  margin-top: 4px;
}
</style>

<style>
/* 弹窗 body 内边距（非 scoped，作用于 .arco-modal-body） */
.template-edit-modal .arco-modal-body {
  padding: 20px 24px 16px;
}
</style>
```

- [ ] **Step 8.2：验证类型检查**

Run:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 8.3：Commit**

```bash
git add src/components/TemplateEditModal.vue
git commit -m "feat(template): TemplateEditModal 新建/编辑弹窗（富文本）"
```

---

## Task 9：TemplateRenameModal 组件

**Files:**
- Create: `src/components/TemplateRenameModal.vue`

- [ ] **Step 9.1：创建重命名弹窗组件**

创建 `src/components/TemplateRenameModal.vue`：

```vue
<script setup lang="ts">
// 模板重命名弹窗 —— 单输入框，回车 = 确认
// 确认时校验非空 + 与原名不同（否则静默关闭）
import { ref, watch, nextTick } from "vue";
import { Message } from "@arco-design/web-vue";
import type { Template } from "@/types";
import { useTemplateStore } from "@/stores/template";

const props = defineProps<{
  visible: boolean;
  template: Template | null;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const templateStore = useTemplateStore();
const newName = ref("");
const inputRef = ref<HTMLInputElement | null>(null);
const confirming = ref(false);

/** visible → true 时回填原名并自动聚焦 */
watch(
  () => props.visible,
  async (open) => {
    if (open && props.template) {
      newName.value = props.template.name;
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    }
  },
);

function close() {
  emit("update:visible", false);
}

async function confirm() {
  if (!props.template) return;
  const trimmed = newName.value.trim();
  if (!trimmed) {
    Message.error("模板名称不能为空");
    return;
  }
  if (trimmed === props.template.name) {
    // 与原名相同，静默关闭
    close();
    return;
  }
  confirming.value = true;
  try {
    await templateStore.renameTemplate(props.template.id, trimmed);
    Message.success("已重命名");
    close();
  } catch (e) {
    Message.error("重命名失败：" + String(e));
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="400"
    :footer="false"
    :mask-closable="true"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="template-rename-modal"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div class="tpl-rename">
      <header class="tpl-rename__header">
        <span class="tpl-rename__label">重命名模板</span>
      </header>
      <input
        ref="inputRef"
        v-model="newName"
        class="tpl-rename__input"
        placeholder="模板名称"
        maxlength="60"
        @keydown.enter="confirm"
      />
      <footer class="tpl-rename__footer">
        <a-button @click="close">取消</a-button>
        <a-button type="primary" :loading="confirming" @click="confirm">确认</a-button>
      </footer>
    </div>
  </a-modal>
</template>

<style scoped>
.tpl-rename {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}
.tpl-rename__header {
  display: flex;
  flex-direction: column;
}
.tpl-rename__label {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tpl-rename__input {
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--jt-text-primary);
  background: var(--jt-surface);
  outline: none;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.tpl-rename__input:focus {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}
.tpl-rename__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

<style>
.template-rename-modal .arco-modal-body {
  padding: 20px 24px 16px;
}
</style>
```

- [ ] **Step 9.2：验证类型检查**

Run:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 9.3：Commit**

```bash
git add src/components/TemplateRenameModal.vue
git commit -m "feat(template): TemplateRenameModal 重命名弹窗"
```

---

## Task 10：TemplateSection 容器

**Files:**
- Create: `src/components/TemplateSection.vue`

- [ ] **Step 10.1：创建容器组件**

创建 `src/components/TemplateSection.vue`：

```vue
<script setup lang="ts">
// 模板设置 section 容器 —— 上下两块：
//   上：可折叠「默认设置」面板（全局默认清单选择器）
//   下：模板卡片网格（新建按钮 + TemplateCard 列表）
// 弹窗在本组件统一管理（编辑/重命名/删除确认），子组件只 emit 事件
import { ref, computed } from "vue";
import { Modal, Message } from "@arco-design/web-vue";
import type { Template } from "@/types";
import { useTemplateStore } from "@/stores/template";
import { useListStore } from "@/stores/list";
import { useSettingsStore } from "@/stores/settings";
import SelectPopover from "@/components/SelectPopover.vue";
import TemplateCard from "./TemplateCard.vue";
import TemplateEditModal from "./TemplateEditModal.vue";
import TemplateRenameModal from "./TemplateRenameModal.vue";

const templateStore = useTemplateStore();
const listStore = useListStore();
const settings = useSettingsStore();

/** 默认设置面板是否展开（本地状态，无需持久化） */
const settingsExpanded = ref(true);

/** 清单下拉选项：仅展示真实清单（非目录），按 position 排序 */
const listOptions = computed(() =>
  listStore.sortedLists
    .filter((l) => !l.isFolder)
    .map((l) => ({ value: l.id, label: l.name })),
);

function onListChange(v: string) {
  settings.setTemplateDefaultListId(v);
}

// ─── 编辑弹窗 ───
const editModalVisible = ref(false);
const editingTemplate = ref<Template | null>(null);

function openCreate() {
  editingTemplate.value = null;
  editModalVisible.value = true;
}
function openEdit(tpl: Template) {
  editingTemplate.value = tpl;
  editModalVisible.value = true;
}

// ─── 重命名弹窗 ───
const renameModalVisible = ref(false);
const renamingTemplate = ref<Template | null>(null);

function openRename(tpl: Template) {
  renamingTemplate.value = tpl;
  renameModalVisible.value = true;
}

// ─── 删除二次确认 ───
function confirmDelete(tpl: Template) {
  Modal.warning({
    title: "删除模板",
    content: `确定要删除模板「${tpl.name}」吗？此操作不可撤销。`,
    okText: "删除",
    cancelText: "取消",
    hideCancel: false,
    modalClass: "confirm-dialog-modal",
    maskStyle: { backgroundColor: "rgba(0,0,0,0.35)" },
    onOk: async () => {
      try {
        await templateStore.deleteTemplate(tpl.id);
        Message.success("已删除模板");
      } catch (e) {
        Message.error("删除失败：" + String(e));
      }
    },
  });
}
</script>

<template>
  <div class="tpl-section">
    <!-- 上：可折叠默认设置面板 -->
    <div class="tpl-section__settings-card">
      <button
        class="tpl-section__settings-header"
        :class="{ 'tpl-section__settings-header--expanded': settingsExpanded }"
        @click="settingsExpanded = !settingsExpanded"
      >
        <span class="tpl-section__settings-title">⚙️ 默认设置</span>
        <span class="tpl-section__settings-arrow">
          {{ settingsExpanded ? "▾" : "▸" }}
        </span>
      </button>
      <div v-if="settingsExpanded" class="tpl-section__settings-body">
        <div class="tpl-section__settings-row">
          <div>
            <div class="tpl-section__settings-label">应用模板时创建到</div>
            <div class="tpl-section__settings-hint">
              所有模板应用此默认清单（可在清单管理中新建更多）
            </div>
          </div>
          <SelectPopover
            :model-value="settings.templateDefaultListId"
            :options="listOptions"
            :width="160"
            @update:model-value="onListChange"
          />
        </div>
      </div>
    </div>

    <!-- 下：模板区标题栏 + 卡片网格 -->
    <div class="tpl-section__templates-header">
      <span class="tpl-section__templates-title">
        模板 · {{ templateStore.templates.length }}
      </span>
      <a-button type="text" size="small" @click="openCreate">
        <template #icon>+</template>
        新建
      </a-button>
    </div>

    <div v-if="templateStore.templates.length === 0" class="tpl-section__empty">
      暂无模板，点击右上「新建」创建一个
    </div>
    <div v-else class="tpl-section__grid">
      <TemplateCard
        v-for="tpl in templateStore.sortedTemplates"
        :key="tpl.id"
        :template="tpl"
        @edit="openEdit"
        @rename="openRename"
        @delete="confirmDelete"
      />
    </div>

    <!-- 弹窗（统一管理） -->
    <TemplateEditModal
      v-model:visible="editModalVisible"
      :template="editingTemplate"
    />
    <TemplateRenameModal
      v-model:visible="renameModalVisible"
      :template="renamingTemplate"
    />
  </div>
</template>

<style scoped>
.tpl-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 上：默认设置卡片 */
.tpl-section__settings-card {
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  overflow: hidden;
}
.tpl-section__settings-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  text-align: left;
}
.tpl-section__settings-header:hover {
  background: var(--jt-surface-hover);
}
.tpl-section__settings-arrow {
  font-size: 11px;
  color: var(--jt-text-tertiary);
}
.tpl-section__settings-body {
  padding: 4px 14px 12px;
  border-top: 1px solid var(--jt-border);
}
.tpl-section__settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0 4px;
}
.tpl-section__settings-label {
  font-size: 13px;
  color: var(--jt-text-primary);
}
.tpl-section__settings-hint {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  margin-top: 2px;
}

/* 下：模板网格 */
.tpl-section__templates-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}
.tpl-section__templates-title {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
}
.tpl-section__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.tpl-section__empty {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--jt-text-tertiary);
  border: 1px dashed var(--jt-border);
  border-radius: 8px;
}
</style>
```

- [ ] **Step 10.2：验证类型检查**

Run:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。若 SelectPopover 报 prop 类型不匹配，参考 `SettingsView.vue:134-138` 现有用法。

- [ ] **Step 10.3：Commit**

```bash
git add src/components/TemplateSection.vue
git commit -m "feat(template): TemplateSection 上下分区容器"
```

---

## Task 11：SettingsView 接入模板 section

**Files:**
- Modify: `src/views/SettingsView.vue`

- [ ] **Step 11.1：在 nav 列表追加「模板」项**

修改 `src/views/SettingsView.vue`：

(a) 在 import 区（约第 8-14 行）追加 Arco 图标 import：

```ts
import {
  IconSettings,
  IconSkin,
  IconBulb,
  IconStorage,
  IconInfoCircle,
  IconTemplate,
} from "@arco-design/web-vue/es/icon";
```

> 注意：若 `IconTemplate` 在当前 Arco 版本不存在，改用 `IconCopy` 或 `IconFile` 作为替代（先 `grep` 确认：`ls node_modules/@arco-design/web-vue/es/icon/icon-template` ）

(b) 在 import 区追加组件：

```ts
import TemplateSection from "@/components/TemplateSection.vue";
```

(c) 修改 `sections` 数组（约第 30-36 行），在 `shortcuts` 与 `data` 之间插入 `templates`：

```ts
const sections = [
  { id: "general", icon: IconSettings, label: "通用" },
  { id: "appearance", icon: IconSkin, label: "外观" },
  { id: "shortcuts", icon: IconBulb, label: "快捷键" },
  { id: "templates", icon: IconTemplate, label: "模板" },
  { id: "data", icon: IconStorage, label: "数据" },
  { id: "about", icon: IconInfoCircle, label: "关于" },
];
```

- [ ] **Step 11.2：在 template 区追加 section 内容**

在 `<div class="settings-view__content">` 内（"快捷键" section div 之后、"数据" section div 之前）插入：

```vue
        <!-- 模板 -->
        <div v-if="activeSection === 'templates'" class="settings-section">
          <h2 class="settings-section__title">模板</h2>
          <TemplateSection />
        </div>
```

- [ ] **Step 11.3：验证图标存在（关键）**

Run:
```bash
ls node_modules/@arco-design/web-vue/es/icon/ | grep -i template
```
Expected: 输出 `icon-template` 目录。若无，将 import 改为 `IconCopy` 并把 `sections` 数组里 `icon: IconTemplate` 同步改 `icon: IconCopy`。

- [ ] **Step 11.4：验证类型检查**

Run:
```bash
npx vue-tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 11.5：Commit**

```bash
git add src/views/SettingsView.vue
git commit -m "feat(template): SettingsView 接入模板 section"
```

---

## Task 12：联调验证（手动）

**Files:** 无（仅运行验证）

- [ ] **Step 12.1：启动应用**

Run:
```bash
bash scripts/dev.sh
```
Expected: Tauri 窗口正常启动，无控制台错误。

- [ ] **Step 12.2：逐项验证验收清单**

按 spec 第 7 节验收清单逐项手动验证：

- [ ] 进入设置页能看到「模板」section（nav 在快捷键与数据之间）
- [ ] 默认展开的「默认设置」面板里有默认清单选择器（默认值 inbox）
- [ ] 模板卡片网格展示 4 个内置模板（📝 会议纪要 / 📊 周报 / 👀 代码审查 / 📖 读书笔记）
- [ ] 卡片正文显示 note 前 3 行预览
- [ ] 点「+ 新建」打开空编辑弹窗，填写后点「保存模板」能创建（关闭弹窗 + toast）
- [ ] 新建的卡片出现在网格中
- [ ] 点卡片打开预填的编辑弹窗
- [ ] 编辑后点「保存模板」更新成功
- [ ] 编辑后点「应用模板」→ 任务被创建 → 弹窗关闭 → 任务详情面板打开
- [ ] 创建的任务进入「默认清单」选中的清单
- [ ] 创建的任务 note 已写入模板内容
- [ ] 卡片「⋯」→ 重命名 → 弹窗 → 回车确认 → 卡片名更新
- [ ] 卡片「⋯」→ 删除 → 二次确认 → 卡片消失
- [ ] 全局默认清单切换后，应用模板创建的任务进对应清单
- [ ] 深色模式下视觉正确（卡片/弹窗/输入框边框对比清晰）

- [ ] **Step 12.3：Rust 端 lint**

Run（在 `src-tauri/` 目录下）:
```bash
cd src-tauri && cargo clippy
```
Expected: 无 warning（或仅有与本次改动无关的既有 warning）。

- [ ] **Step 12.4：最终 Commit（如有手动测试中发现的小修复）**

若测试中发现问题并修复，提交修复；否则跳过本步。

```bash
git add -A
git commit -m "fix(template): 联调发现的问题修复"
```

---

## 完成后

- 所有 12 个 task 完成
- `cargo check` / `cargo clippy` / `vue-tsc --noEmit` 全部通过
- 手动验收清单全部通过
- 更新 `AGENTS.md` 的「当前状态」段，把模板功能加入已开发完成列表（可选）
