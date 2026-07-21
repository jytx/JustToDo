# 任务模板功能设计文档

> 状态：已确认（待用户最终审阅） · 日期：2026-07-21
> 作者：brainstorming session
> 关联需求：在设置页新增「模板」section，支持内置模板卡片 + 新建/编辑/删除/重命名/应用模板

## 1. 目标与范围

### 一句话定位
在设置页新增「模板」section，让用户维护一组"任务预设"（名称 + 任务标题 + 富文本备注），点模板卡片可在弹窗里编辑，或「应用模板」一键创建任务并打开详情。

### MVP 范围（已确认）

| 项 | 决定 |
|---|---|
| 应用粒度 | **单任务**（一个模板 = 一个任务预设，不嵌套子任务/checklist） |
| 模板字段 | **名称（自身属性）+ title + note（富文本 HTML）** |
| 顶部设置区 | **全局默认清单**（所有模板应用时都进这个清单，模板自身不带 listId） |
| 应用后行为 | **保存 → 创建任务 → 写 note → 打开任务详情面板** |
| 内置模板 | **预装 4 个**（会议纪要 / 周报 / 代码审查 / 读书笔记） |
| 入口位置 | **设置页新加「模板」section**（与通用/外观同级） |
| 卡片操作 | 新建 / 编辑 / 删除（二次确认） / 重命名（独立弹窗） |
| 编辑弹窗 | 富文本，footer 有「保存」「应用模板」两按钮 |
| 卡片点击 | 打开编辑弹窗 |

### 明确不做（YAGNI）
- 模板嵌套子任务 / checklist
- 模板预设 listId / priority / 标签 / 日期 / 重复规则 / 提醒
- 占位符自动替换（`{{date}}` 等只是字面文字，用户自己改）
- 模板排序拖拽（position 字段保留但 MVP 不暴露 UI）
- 模板分类 / 文件夹
- 模板导入导出
- 「放弃改动？」二次确认（编辑弹窗 mask-closable 直接关）

## 2. 架构与分层

### 新增文件清单

```
src/
├── views/SettingsView.vue                    # 改：新增 "模板" nav 项 + section
├── components/
│   ├── TemplateSection.vue                   # 新：模板 section 容器（上下两块）
│   ├── TemplateCard.vue                      # 新：单张模板卡片（极简卡）
│   ├── TemplateEditModal.vue                 # 新：新建/编辑弹窗（分区式）
│   └── TemplateRenameModal.vue               # 新：重命名弹窗
├── stores/
│   └── template.ts                           # 新：Pinia store（CRUD + applyTemplate）
├── types/
│   └── index.ts                              # 改：追加 Template 接口
└── api/
    └── db.ts                                 # 改：追加 template_* 封装

src-tauri/src/
├── commands.rs                               # 改：追加 4 个 #[tauri::command]
├── models.rs                                 # 改：追加 Template / TemplateRow 结构体
└── db/
    ├── mod.rs                                # 改：注册 run_migration_014
    └── migrations/
        └── 014_templates.sql                 # 新：建表 + seed 4 个内置模板
```

### 关键架构决策

1. **模板不写 task 表**：模板只是"参数预设"，独立存在 `templates` 表。"应用模板" = 走 `taskStore.createTask()` + 紧接着 `db.updateTask(newId, { note })` 两步。原因：项目既有约束——`task_create` 命令不接受 note 字段（强制写空串），note 必须通过 `task_update` 二次写入。

2. **全局默认清单走 settings store**：复用 `src/stores/settings.ts` 已有的 settings 持久化机制，加一项 `templateDefaultListId`，与"新任务自动设为今天"等设置同级。默认值 `'inbox'`。

3. **模板 store 与 list store 解耦**：`template.ts` 只管自己的 CRUD，应用时通过 `listStore.getById()` 读取默认清单，避免循环依赖。

4. **内置模板走 migration seed**：`014_templates.sql` 里 `INSERT OR IGNORE` 4 条记录，与 `002_habits.sql` 风格一致；migration 用 SQL 文件（因为纯建表+插数据，幂等容易）。

## 3. 数据模型与持久化

### `templates` 表（migration `014_templates.sql`）

```sql
CREATE TABLE IF NOT EXISTS templates (
    id           TEXT PRIMARY KEY,           -- uuid（内置用固定 id 如 'tpl-meeting'）
    name         TEXT NOT NULL,              -- 模板名称（"会议纪要"）
    title        TEXT NOT NULL DEFAULT '',   -- 任务标题预设
    note         TEXT NOT NULL DEFAULT '',   -- HTML 富文本字符串
    is_builtin   INTEGER NOT NULL DEFAULT 0, -- 1=内置预装（用户仍可改/删）
    position     INTEGER NOT NULL DEFAULT 0, -- 排序（MVP 不暴露 UI，保留扩展）
    created_at   TEXT NOT NULL,              -- ISO8601 时间戳
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_position ON templates(position);
```

### Seed 数据（同文件内，`INSERT OR IGNORE` 幂等）

固定 id，重复执行 migration 不报错、不覆盖用户改动：

| id（固定） | name | title | note 要点 |
|---|---|---|---|
| `tpl-meeting` | 会议纪要 | `{{date}} 会议纪要` | 会议/时间/参会/议题/结论 & Action |
| `tpl-weekly` | 周报 | `{{date}} 周报` | 本周完成/下周计划/阻塞/风险 |
| `tpl-codereview` | 代码审查 | `代码审查：{{title}}` | PR/优点/问题/建议 |
| `tpl-reading` | 读书笔记 | `《{{book}}》读书笔记` | 书名/作者/核心观点/摘录/启发 |

> `{{date}}` `{{title}}` `{{book}}` 是字面文字，MVP **不做自动替换**。

### TS 类型（`src/types/index.ts` 追加）

```ts
export interface Template {
  id: string;
  name: string;
  title: string;
  note: string;            // HTML 字符串（RichTextEditor 输出）
  isBuiltin: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}
```

### Settings 新增项（`src/stores/settings.ts`）

`SETTINGS_KEYS` 追加：
```ts
templateDefaultListId: 'template.defaultListId',
```
默认值 `'inbox'`。复用现有 settings 持久化机制（debounce 写 `app_settings` 表）。

## 4. IPC 层

### Rust 命令（`src-tauri/src/commands.rs` 追加 4 个）

命名风格 `实体_动词`（与项目既有 `task_create` / `list_create` 一致）：

```rust
#[tauri::command]
pub async fn template_get_all(pool: State<'_, SqlitePool>) -> Result<Vec<TemplateRow>, String>;

#[tauri::command]
pub async fn template_create(
    input: CreateTemplateInput,
    pool: State<'_, SqlitePool>,
) -> Result<TemplateRow, String>;

#[tauri::command]
pub async fn template_update(
    id: String,
    input: UpdateTemplateInput,
    pool: State<'_, SqlitePool>,
) -> Result<(), String>;

#[tauri::command]
pub async fn template_delete(id: String, pool: State<'_, SqlitePool>) -> Result<(), String>;
```

**重命名**走 `template_update`（只传 `name` 字段），不单独开命令，避免冗余。

### 输入结构体（`src-tauri/src/models.rs`）

```rust
#[derive(Deserialize)]
pub struct CreateTemplateInput {
    pub name: String,
    pub title: String,
    pub note: String,
}

#[derive(Deserialize)]
pub struct UpdateTemplateInput {
    pub name: Option<Option<String>>,
    pub title: Option<Option<String>>,
    pub note: Option<Option<String>>,
}
// 注：Option<Option<T>> 与 task_update 同模式 —— undefined 跳过，Some(None) 置空
```

id / 时间戳由 Rust 端生成（`Uuid::new_v4()` + `chrono::Utc`），与现有 `task_create` 一致。

### 命令注册（`src-tauri/src/lib.rs`）

`generate_handler!` 列表追加这 4 个命令，否则前端 invoke 报 "command not found"。

### 前端封装（`src/api/db.ts`）

仿 `mapTask` 模式（前端拿 camelCase，invoke 传 snake_case）：

```ts
export async function getTemplates(): Promise<Template[]>;
export async function createTemplate(params: {
  name: string; title: string; note: string;
}): Promise<Template>;
export async function updateTemplate(
  id: string,
  fields: { name?: string; title?: string; note?: string },
): Promise<void>;
export async function deleteTemplate(id: string): Promise<void>;
```

### Migration 注册（`src-tauri/src/db/mod.rs`）

`init_pool()` 末尾追加：
```rust
run_migration_014(&pool).await?;
```
对应函数读取 `include_str!("migrations/014_templates.sql")` 执行（与 `001`/`002` 同模式，纯 SQL 幂等）。

## 5. 前端交互流程

### Pinia store（`src/stores/template.ts`）

```ts
state: {
  templates: Ref<Template[]>;     // 按 position 升序
}
actions: {
  loadTemplates();                                         // 调 db.getTemplates
  createTemplate({ name, title, note }) → Template;
  updateTemplate(id, fields);
  renameTemplate(id, name);                                // 内部调 updateTemplate(id, { name })
  deleteTemplate(id);
  applyTemplate(form: TemplateForm) → Promise<Task>;       // 核心编排
}
```

### `applyTemplate` 完整流程

入参签名：`applyTemplate(form: TemplateForm) → Promise<Task>`，其中 `TemplateForm = { id: string | null; name: string; title: string; note: string }`。`id === null` 表示新建模式。

```
用户在编辑弹窗点「应用模板」
  ↓
1. 校验 form.name 非空，否则抛错
  ↓
2. 落库模板：
   - id === null → createTemplate(form) → 拿到新 id
   - id !== null 且 form 与原 template 有差异 → updateTemplate(id, form)
   - id !== null 且无差异 → 跳过
  ↓
3. 读取全局默认清单：settings.templateDefaultListId ?? 'inbox'
  ↓
4. taskStore.createTask({
     title: form.title || form.name,
     listId: 默认清单,
   }) → 返回新 Task
  ↓
5. 若 form.note 非空：db.updateTask(newId, { note: form.note })
  ↓
6. taskStore.selectTask(newId)  ← 打开详情面板
  ↓
7. 返回新 Task；调用方关闭弹窗 + Message.success("已创建任务")
```

> 第 1 步"自动保存改动"是按需求「应用模板按钮则先保存、再创建任务」实现。

### 各操作的弹窗映射

| 触发 | 打开 | 组件 |
|---|---|---|
| 模板 section「+ 新建」按钮 | 编辑弹窗（空表单） | `TemplateEditModal` |
| 点击模板卡片 | 编辑弹窗（预填） | `TemplateEditModal` |
| 卡片「⋯」菜单 → 重命名 | 重命名弹窗 | `TemplateRenameModal` |
| 卡片「⋯」菜单 → 删除 | 二次确认弹窗 | 复用 `confirm-dialog-modal`（项目既有风格） |
| 编辑弹窗 footer「保存模板」 | 仅保存，关弹窗 | — |
| 编辑弹窗 footer「应用模板」 | 保存 + 创建任务 + 开详情 | — |

### 编辑弹窗 footer 按钮逻辑

```
[取消]  [保存模板 outline]  [应用模板 primary]
```

- **取消** —— 直接关弹窗（MVP 不做"放弃改动"二次确认）
- **保存模板** —— 校验 `name` 非空；新建走 `createTemplate`，编辑走 `updateTemplate`；成功后关闭弹窗
- **应用模板** —— 校验 `name` 非空；调 `templateStore.applyTemplate(form)`；成功后关闭弹窗

### 启动加载

`App.vue` 或 `main.ts` 初始化里追加 `templateStore.loadTemplates()`，与 `listStore.loadLists()` 同批次。进入设置页「模板」section 时无需重新加载（store 已是数据源）。

## 6. UI 组件与样式

### `TemplateSection.vue`（设置页右侧主区）

```
┌─ 设置 → 模板 ────────────────────────────┐
│ ┌──────────────────────────────────────┐ │
│ │ ⚙️ 默认设置                      ▾  │ │  ← 上：可折叠设置面板
│ │ ──────────────────────────────────── │ │
│ │ 应用模板时创建到   [📋 工作 ▾]       │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ 模板 · 4                    [+ 新建]    │  ← 下：模板区标题栏
│ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│ │ 📝 会议  │ │ 📊 周报  │ │ 👀 代码  │  │  ← 卡片网格
│ │ 纪要  ⋯ │ │       ⋯ │ │ 审查  ⋯ │  │
│ │ ───────  │ │ ───────  │ │ ───────  │  │
│ │ note预览 │ │ note预览 │ │ note预览 │  │
│ └──────────┘ └──────────┘ └──────────┘  │
└──────────────────────────────────────────┘
```

- 默认设置面板**默认展开**，点击标题行折叠/展开（`ref<boolean>(true)` 本地状态，无需持久化）
- 默认清单下拉**复用 `SelectPopover`**（SettingsView 已在用），数据源 `listStore.sortedLists`，写回 `settings.templateDefaultListId`
- 模板区标题栏右侧「+ 新建」按钮（Arco `a-button type="text" size="mini"`，复用侧边栏「+」清单的新建按钮风格）
- 卡片网格 `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))`，间距 12px

### `TemplateCard.vue`（极简卡）

```vue
<template>
  <div class="tpl-card" @click="emit('edit')">
    <div class="tpl-card__header">
      <span class="tpl-card__icon">{{ icon }}</span>
      <span class="tpl-card__name">{{ template.name }}</span>
      <a-trigger trigger="click" position="br">
        <button class="tpl-card__menu" @click.stop>⋯</button>
        <template #content>
          <MenuPopover>
            <MenuPopoverItem @click="emit('rename')">重命名</MenuPopoverItem>
            <MenuPopoverItem @click="emit('delete')" danger>删除</MenuPopoverItem>
          </MenuPopover>
        </template>
      </a-trigger>
    </div>
    <div class="tpl-card__preview">{{ plainTextNote }}</div>
  </div>
</template>
```

- 整卡 click → `edit`（打开编辑弹窗）
- 右上「⋯」点击展开菜单（复用 `MenuPopover`，参考 TheSidebar 标签区用法）→ `rename` / `delete`
- note 预览：HTML 转纯文本截前 3 行（`DOMParser` 解析后取 `textContent`，不引第三方库）
- 图标：内置 4 个用 emoji（📝 会议 / 📊 周报 / 👀 代码审查 / 📖 读书笔记），用户自建用默认 📄（按 id 或 name 匹配内置的用 emoji，其余 📄）

### `TemplateEditModal.vue`（分区式，新建/编辑共用）

```vue
<a-modal :width="640" :footer="false" modal-class="template-edit-modal">
  <!-- 头部：模式标识 + 模板名 -->
  <header>
    <span class="label">{{ isEdit ? '编辑模板' : '新建模板' }}</span>
    <input v-model="form.name" placeholder="模板名称" />
  </header>

  <!-- 任务标题分区 -->
  <section>
    <label>任务标题</label>
    <input v-model="form.title" placeholder="应用模板时新任务的标题" />
  </section>

  <!-- 富文本分区（主体） -->
  <section>
    <label>备注（富文本）</label>
    <RichTextEditor v-model="form.note" placeholder="支持富文本、图片粘贴..." />
  </section>

  <!-- footer -->
  <footer>
    <a-button @click="close">取消</a-button>
    <a-button type="outline" @click="onSave">保存模板</a-button>
    <a-button type="primary" @click="onApply">应用模板</a-button>
  </footer>
</a-modal>
```

- 弹窗宽度 640px（富文本需要空间），高度自适应内容（富文本区 `min-height: 240px`）
- 表单初始值：编辑模式 = 浅拷贝 template 字段；新建模式 = `{ name: '', title: '', note: '' }`
- `onSave` / `onApply` 均校验 `name` 非空，否则 `Message.error("请填写模板名称")` 并 return

### `TemplateRenameModal.vue`

```vue
<a-modal :width="400" :footer="false" modal-class="template-rename-modal">
  <header><span class="label">重命名模板</span></header>
  <input v-model="newName" placeholder="模板名称" @keydown.enter="confirm" />
  <footer>
    <a-button @click="close">取消</a-button>
    <a-button type="primary" @click="confirm">确认</a-button>
  </footer>
</a-modal>
```

- 单输入框，回车 = 确认
- 确认时校验非空 + 与原名不同（否则静默关闭）

### `SettingsView.vue` 改动

```ts
const sections = [
  { id: 'general', icon: IconSettings, label: '通用' },
  { id: 'appearance', icon: IconSkin, label: '外观' },
  { id: 'shortcuts', icon: IconIconBulb, label: '快捷键' },
  { id: 'templates', icon: IconTemplate, label: '模板' },  // ← 新增（在快捷键与数据之间）
  { id: 'data', icon: IconStorage, label: '数据' },
  { id: 'about', icon: IconInfoCircle, label: '关于' },
];
```

模板 section 内容直接 `<TemplateSection v-if="activeSection === 'templates'" />`，把这块的复杂度从 SettingsView 隔离出去。

### 样式 token

全部复用现有 `--jt-*` 与 Arco CSS 变量，不新增 token。卡片样式参考 `TaskListItem.vue` 的边框/hover 风格保持视觉一致。

## 7. 验收清单

实现完成后需满足：

- [ ] 进入设置页能看到「模板」section
- [ ] 默认展开的「默认设置」面板里有默认清单选择器
- [ ] 模板卡片网格展示 4 个内置模板（带 emoji 图标）
- [ ] 点「+ 新建」打开空编辑弹窗，填写后点「保存模板」能创建
- [ ] 点卡片打开预填的编辑弹窗
- [ ] 编辑后点「保存模板」更新、点「应用模板」创建任务并打开详情
- [ ] 卡片「⋯」→ 重命名弹窗，回车确认
- [ ] 卡片「⋯」→ 删除二次确认
- [ ] 全局默认清单切换后，应用模板创建的任务进对应清单
- [ ] 深色模式下视觉正确
- [ ] `cargo check` / `cargo clippy` 通过
- [ ] `npx vue-tsc --noEmit` 通过

## 8. 风险与开放问题

- **图片粘贴在模板里的行为**：模板 note 含图片时，图片走现有 `save_image` IPC 落本地附件目录。若用户删除模板，图片文件不会清理（MVP 接受这个孤儿文件，与任务删除现状一致）。
- **占位符替换**：MVP 不做，未来如需可加 `{{date}}` `{{week}}` 等替换规则，独立迭代。
- **模板排序**：position 字段保留但 MVP 不暴露 UI，未来如需拖拽排序可独立加。
