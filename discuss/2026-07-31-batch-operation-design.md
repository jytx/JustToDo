# 批量操作功能设计（2026-07-31）

> 用途：评审「任务批量操作」功能的交互方案、数据流、改动范围。
> 确认后再开 `-plan.md` 实现计划。
>
> 关联：`discuss/2026-07-30-future-features-roadmap.md`（P0 优先级功能）

---

## 一、功能目标

用户能对**多个任务**一次性完成：标记完成/取消完成、移到清单、加标签、
改优先级、改截止日期、删除。避免逐个点击修改的低效。

---

## 二、交互方案：两种入口 + 统一的右键批量菜单

核心思路：**「进入多选」只是触发器的区别，进入后行为完全一致**——
都是「右键弹出批量编辑菜单」。底层共用一套多选状态与批量菜单，
两种入口的增量成本很低，能覆盖新老用户。

### 入口 A：Shift / Cmd 多选（主入口，高效）

桌面通用范式（Finder / 文件管理器标准），老用户零学习成本：

- **Shift + 点击**：范围选。从上一个选中的任务到当前点击任务之间的所有任务全部选中。
- **Cmd / Ctrl + 点击**：单点增减选。点一个切一个。
- 选中 ≥ 1 个后，**右键任意任务** → 弹出批量编辑菜单。
- 普通点击（无修饰键）：清空多选，恢复单选语义（打开详情面板）。

### 入口 B：右键菜单「多选」（辅助入口，发现性好）

给不熟悉快捷键的用户一个看得见的入口：

- 任意任务**右键** → 现有右键菜单底部新增「多选」项。
- 点击「多选」→ 进入多选模式：任务项左侧出现复选框，逐个勾选。
- 勾选 ≥ 1 个后，**右键** → 弹出批量编辑菜单。

### 统一的批量编辑菜单（两种入口共用）

右键已选中任务时弹出，包含第一批确认的 6 项操作：

```
┌─────────────────────────────┐
│  ✓  标记完成 / 取消完成      │  ← 按当前多数态智能显示
│  📂 移到清单 ▸              │  ← 子菜单：清单树（含色点）
│  🏷  加标签 ▸               │  ← 子菜单：标签列表 + 新建
│  🔥 改优先级 ▸              │  ← 子菜单：无/低/中/高
│  📅 改截止日期 ▸            │  ← 子菜单：今天/明天/下周/清除/自定义
│  ─────────────────────────  │
│  🗑  删除（N）              │  ← 红色，显示选中数量
└─────────────────────────────┘
```

**菜单标题**：顶部可显示「已选 N 个任务」，让用户清楚批量范围。
**Esc / 点空白**：退出多选模式。

### 为什么不用「底部浮动操作栏」

考虑过 VS Code / 邮件客户端那种底部批量栏，但：
- 桌面任务 App 用**右键菜单**更符合桌面习惯（Finder/Things 都用右键）。
- 复用现有 `ContextMenu` 组件，不用新建浮动栏（省去 z-index/定位/响应式问题）。
- 右键菜单天然就近鼠标，操作路径短。

---

## 三、关键交互细节

### Shift 范围选的实现

- 记录「锚点任务」（最近一次选中/取消的任务）。
- Shift+点击时，以锚点和当前点击任务为两端，选中两任务之间（含）
  在**当前列表可见未完成任务数组**中的所有任务。
- 范围选基于 `openTasks`（当前视图未完成任务），不跨已完成区。

### 与现有点击/右键行为的兼容

现状（`TaskListItem.vue:268`）：
- 根 div `@click` → emit `select` → 视图调 `selectTask`（打开详情面板）
- 根 div `@contextmenu` → 打开单任务右键菜单

改造后：
- `@click` handler 先判断修饰键：
  - 有 Shift / Cmd → 走多选逻辑，**不**打开详情面板
  - 无修饰键 → 清空多选，走原 select 逻辑
- `@contextmenu` handler 判断当前是否多选模式：
  - 多选模式 + 右键的任务在选中集合内 → 弹**批量菜单**
  - 否则 → 弹现有**单任务菜单**（并追加「多选」入口项）

### 选中态视觉

- 被选中的任务行：`background-color: var(--jt-accent-soft)`（复用现有选中色）
- 左侧出现一个小复选框 / 勾选标记（仅多选模式下显示）
- 已有 `--selected` class 用 `--jt-accent-soft`，可复用同一变量

### Esc 的协调

现状 `AppLayout.vue:155`：Esc 关详情面板/浮层。
多选模式下：Esc **优先退出多选**，不关详情面板。
（在 AppLayout 的 Esc handler 顶部加判断：多选激活时先清多选）

---

## 四、数据流与改动范围

### Store 层（`src/stores/task.ts`）

新增多选状态与批量 action：

```ts
// 新增 state
const selectedIds = ref<Set<string>>(new Set());   // 批量选中的任务 id
const selectionMode = ref(false);                   // 是否处于多选模式
const anchorId = ref<string | null>(null);          // Shift 范围选锚点

// 新增 action
function toggleSelect(id): void                     // Cmd 单点增减
function rangeSelect(id): void                      // Shift 范围选（基于 openTasks）
function selectAll(): void                          // Cmd+A 全选当前视图
function clearSelection(): void                     // 退出多选模式
function enterSelectionMode(): void                 // 从右键菜单进入多选

async function batchUpdate(ids: string[], fields): Promise<void>  // 批量改字段
async function batchDelete(ids: string[]): Promise<void>          // 批量删除
async function batchAddTags(ids: string[], tagIds: string[]): Promise<void>
async function batchToggleDone(ids: string[], done: boolean): Promise<void>
```

**批量更新的实现策略**（重要决策点）：

两种方案——

**方案 1（推荐）：前端循环调现有 `db.updateTask`**
- 优点：零后端改动，复用现有钳制/同步逻辑。
- 缺点：N 次 IPC 往返，非事务（中途失败部分更新）。
- 适用：批量操作通常选中数 ≤ 几十个，性能可接受。

**方案 2：后端新增批量命令**
- 优点：一次 IPC、一个事务、原子性。
- 缺点：要改 Rust（commands.rs + models.rs），UpdateTaskInput 要支持批量。
- 适用：追求严谨，或预判用户常选上百个。

**建议先用方案 1**（YAGNI），若实测有性能问题再升级方案 2。
每个 `batchXxx` 内部循环调 store 现有的 `updateTask` / `deleteTask`，
它们已封装好本地 state 同步（currentTasks/subtasks/subtaskCache）。

### TaskListItem 层（`src/components/TaskListItem.vue`）

- 新增 prop：`selectionMode: boolean`、`selected: boolean`
- `@click` 改为 emit `click-with-modifiers`，带出 `shiftKey` / `metaKey`
- 多选模式下左侧渲染勾选标记
- 选中行加 `--batch-selected` class

### 各视图层（ListView / SmartView / TagView）

- 把 TaskListItem 的 click 事件改为接收修饰键信息，转发给 store 的多选 action
- 传入 `selectionMode` / `selected` prop
- TaskListItem 的 `@select`（打开详情）仅在非多选且无修饰键时触发

### 右键菜单

- **单任务右键菜单**（TaskListItem 现有 ContextMenu）：追加「多选」项
- **批量右键菜单**（新增）：在视图层或新建 `BatchContextMenu.vue` 渲染，
  复用 `ContextMenu` 容器 + `MenuPopoverItem`。
  - 「移到清单 / 加标签 / 改优先级 / 改截止日期」的子选项：
    复用 TaskDetailPanel 的清单树（listOptions）、TagSelectPopover、
    优先级色点、DueDateChip 的逻辑（可能需抽成独立组件或直接内联）。

### 子菜单的呈现

现有 `ContextMenu` 是单层平面菜单。批量菜单的子项（清单/标签/优先级/日期）
需要二级菜单。两种做法：

- **A. hover 展开子菜单**（级联菜单）：需扩展 ContextMenu 支持子菜单。
- **B. 点击进入二级面板**：点「移到清单」后，当前菜单替换为清单列表，
  顶部有返回箭头。实现简单，类似移动端。

建议 **B 方案**（点击进入二级面板），改动最小，符合现有 ContextMenu 结构。

---

## 五、不做的事（第一版边界）

明确排除，避免范围蔓延：

1. **任务级归档**：tasks 表无 archived 字段（只有 lists 清单表有），
   「批量归档任务」需 DB 改造 + 全链路过滤，工作量大。第一版不做。
   （若需要"归档"语义，可引导用户「移到某个归档清单」，但归档清单目前也被过滤。）
2. **跨视图多选**：多选仅在当前视图（清单/标签/智能视图）的可见列表内生效，
   不跨视图、不跨已完成/未完成区。
3. **拖拽多选**：不做鼠标框选（lasso），不做拖拽移动多个任务。
4. **批量改标题/备注**：文本类字段批量改无意义，排除。
5. **后端批量命令**：第一版用前端循环，不做 Rust 批量命令（YAGNI）。

---

## 六、改动文件清单（预估）

| 文件 | 改动 |
|------|------|
| `src/stores/task.ts` | 加多选 state + batch actions（核心） |
| `src/components/TaskListItem.vue` | 加 selectionMode/selected prop、修饰键 click、勾选 UI |
| `src/views/ListView.vue` | 接多选事件转发、传 prop |
| `src/views/SmartView.vue` | 同上 |
| `src/views/TagView.vue` | 同上 |
| `src/components/BatchContextMenu.vue` | **新增**：批量右键菜单（含二级面板） |
| `src/components/TaskListItem.vue` | 单任务右键菜单追加「多选」项 |
| `src/layouts/AppLayout.vue` | Esc 优先退多选；Cmd+A 全选 |

预估总工作量：1.5–2 天。

---

## 七、待确认 / 风险点

1. **子菜单呈现**：用「点击进入二级面板」（推荐）还是「hover 级联」？
2. **批量更新策略**：前端循环（推荐，YAGNI）还是后端批量命令？
3. **「标记完成」的智能文案**：选中里有完成也有未完成时，菜单显示「标记完成」
   还是「取消完成」？建议：按多数态显示，或直接显示「标记完成」
   （完成是不可逆性更强的操作，优先呈现）。

以上 3 点在实现计划里会给出默认选择，如无异议则按默认推进。
