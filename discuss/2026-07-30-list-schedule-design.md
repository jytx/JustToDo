# 清单生成计划（ListSchedule）设计文档

> 日期：2026-07-30
> 状态：设计已评审确认，待实现

## 一、背景与目标

用户把 JustToDo 用作每日工作待办，目前手动维护一套结构：

- **月目录**：每月初手动新建，命名如 `2026-08`。
- **日清单**：每天早上手动新建，命名如 `2026-08-01`，挂在当月目录下。

本功能把这套工作流**自动化**，让"当月目录"和"当日清单"按规则自动生成，并把规则做成**可配置、可多套**的"清单生成计划"，以适配未来更灵活的场景（如周计划、项目独立规则等）。

## 二、核心决策汇总

| 决策点 | 结论 | 说明 |
| --- | --- | --- |
| 触发时机 | A+B 结合 | 每分钟后台循环 + 启动补发，复用 `lib.rs:59` 现有循环 |
| 计划模型 | 可配置多套 `ListSchedule` | 每套独立：频率 + 路径模板 + 颜色 |
| 目标定位 | 路径模板方案 | 复用 `ensureFolderPath` 逐级创建思路 |
| 频率范围 | daily/weekly/monthly/yearly + 工作日 | 对齐 Task 的 `recurrence_freq`，外加工作日 |
| 工作日语义 | 完整法定工作日 | 周一~周五且非放假，或周末调休补班 |
| 节假日数据 | 启动检查当年+明年缓存 | 本地缓存，断网降级为纯周末判断 |
| 异常处理 | 通知 + 设置页状态提示 | 不阻塞流程 |
| 补发策略 | 只补"今天" + 月/年兜底 | 过去的日清单不回溯；月/年目录若不存在则补建当期 |

## 三、整体架构

新增独立 Rust 模块 `src-tauri/src/list_schedule/`，与现有"重复任务生成"并列，但走自己的表与逻辑。分层如下：

```
list_schedule/
├── mod.rs       # 模块入口 + ListSchedule 调度主循环（list_schedule_tick）
├── models.rs    # ListSchedule / Holiday 结构体
├── generate.rs  # 路径模板渲染 + 逐级生成逻辑（纯函数为主）
└── holiday.rs   # 节假日获取/缓存/工作日判断
```

设计原则：纯函数优先（渲染、工作日判断、路径拆分均为纯函数，仅修改返回值），可变操作（建清单、写缓存）封装在薄薄一层 command/调度入口里，便于测试与复用。

## 四、数据模型

### 4.1 两张新表（migration，幂等）

```sql
-- 清单生成计划
CREATE TABLE IF NOT EXISTS list_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- "每日工作清单"
  path_template TEXT NOT NULL,     -- "工作/日志/{{YYYY}}/{{MM}}/{{YYYY-MM-DD}}"
  freq TEXT NOT NULL,              -- daily/weekly/monthly/yearly/workday
  color TEXT NOT NULL,             -- 清单颜色，缺省创建时随机一个
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 节假日缓存（按年批量）
CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,           -- "2026-01-01"
  year INTEGER NOT NULL,
  is_off_day INTEGER NOT NULL,     -- 1=放假 0=调休补班
  name TEXT                        -- "元旦"
);
CREATE INDEX IF NOT EXISTS idx_holidays_year ON holidays(year);
```

### 4.2 TS / Rust 类型

TS 接口放 `src/types/`，Rust 结构体放 `src-tauri/src/list_schedule/models.rs`，两侧手动保持同步（遵循项目既有约定）。

字段 camelCase / snake_case 对应：`pathTemplate / parentId / isFolder` 等。

## 五、路径模板与渲染

### 5.1 支持的占位符

| 占位符 | 含义 | 示例（2026-08-01）|
| --- | --- | --- |
| `{{YYYY}}` | 4 位年 | `2026` |
| `{{YY}}` | 2 位年 | `26` |
| `{{MM}}` | 2 位月（补零）| `08` |
| `{{M}}` | 月不补零 | `8` |
| `{{DD}}` | 2 位日（补零）| `01` |
| `{{D}}` | 日不补零 | `1` |
| `{{YYYY-MM-DD}}` | 完整日期 | `2026-08-01` |
| `{{YYYY-MM}}` | 年月 | `2026-08` |

### 5.2 渲染规则

纯函数 `render_path_template(template: string, date: NaiveDate) -> String`：

- 按占位符**长度降序**逐个替换，避免短占位符误伤长占位符（先替换 `{{YYYY-MM-DD}}` 再替换 `{{YYYY}}`）。
- 路径分隔符统一用 `/`，渲染后形如 `工作/日志/2026/08/2026-08-01`。
- 入参只读，仅返回新字符串，便于单测。

### 5.3 逐级创建与最后一段类型判定

渲染后的路径按 `/` 切分为多段，语义不同：

- **中间路径段** → 创建为目录（`is_folder = true`），如 `工作`、`日志`、`2026`、`08`。
- **最后一段** → 按 `freq` 决定类型：
  - `monthly` / `yearly` → 目录（当月/当年目录本身是目录）
  - `daily` / `weekly` / `workday` → 清单（`is_folder = false`）

### 5.4 逐级查找/创建函数

Rust 侧写 `ensure_scheduled_path(path, leaf_is_folder, color) -> list_id`：

- 复用前端 `ensureFolderPath`（`list.ts:108`）的逐级 `SELECT by (parent_id, name)` 思路。
- 找到则复用现有记录、没找到则 `list_create`。
- 最后一段按 `leaf_is_folder` 决定类型与颜色。

### 5.5 示例：两条计划

| 计划 | path_template | freq | 产出（2026-08-01）|
| --- | --- | --- | --- |
| 月目录 | `工作/日志/{{YYYY}}/{{YYYY-MM}}` | monthly | `工作/日志/2026/2026-08`（目录）|
| 日清单 | `工作/日志/{{YYYY}}/{{YYYY-MM}}/{{YYYY-MM-DD}}` | daily | `工作/日志/2026/2026-08/2026-08-01`（清单）|

## 六、节假日数据获取与缓存

独立成纯逻辑模块 `holiday.rs`，职责：给定日期，回答"是否法定工作日"。

### 6.1 获取流程（启动时触发）

1. 启动时检查**今年 + 明年**数据是否已缓存（`SELECT COUNT(*) FROM holidays WHERE year IN (今年, 明年)`）。
2. 缺失年份 → 请求 `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{年份}.json`。
3. 解析 `days` 数组，逐条 `INSERT OR REPLACE INTO holidays(date, year, is_off_day, name)`。
4. 跨年兜底：明确覆盖"当年 + 下一年"，保证元旦附近判断不缺数据。

### 6.2 工作日判断（纯函数，A 语义）

`is_workday(date, holidays_cache) -> bool`：

```
查询当天在 holidays 表的记录：
- 无记录（普通日子）：
    周一~周五 → 工作日（true）
    周六、周日 → 非工作日（false）
- 有记录且 is_off_day=true（放假）→ 非工作日（false）
- 有记录且 is_off_day=false（调休补班）→ 工作日（true）
```

### 6.3 降级策略

- 请求失败 / 明年数据未发布（404）→ **不阻塞启动**，工作日判断临时降级为纯周末判断（周一~周五）。
- 触发**消息提醒**（复用项目已有通知能力）+ 设置页状态提示，告知"节假日数据未更新，已按普通工作日处理"。
- 核心原则：**永远不因网络问题卡住清单生成**，宁可当天用降级判断，也不静默失败。

### 6.4 数据时效

节假日数据由国务院每年发布（通常前一年 11 月公布次年安排），"当年 + 明年"覆盖足够；不需要定期刷新，启动检查即可。

## 七、生成调度核心逻辑

复用 `lib.rs:59` 的每分钟后台循环，每轮加一步 `list_schedule_tick()`。

### 7.1 每轮 tick 流程

```
对每条 enabled 的 ListSchedule：
  根据 freq 判断"今天(本地日期)"是否命中：
    - daily      → 每天命中
    - weekly     → 今天是周一命中
    - monthly    → 今天是 1 号命中
    - yearly     → 今天是 1 月 1 日命中
    - workday    → is_workday(今天) 命中
  若命中：
    渲染路径  render_path_template(模板, 今天)
    逐级 ensure_scheduled_path(路径, leaf_is_folder, color)
    （已存在则跳过）
```

### 7.2 幂等性：靠"路径已存在检查"，不靠时间戳

这是相比 Task 重复生成最大的简化。Task 需要 `recurrence_origin_id` 关联实例防重；清单按路径生成，**同一路径只可能存在一份**。`ensure_scheduled_path` 内部逐级 `SELECT by (parent_id, name)`，找到复用、没找到才建。

所以 tick 每分钟跑、补发跑多次，同一天也只会生成一个 `2026-08-01` 清单。**不需要 `last_run_at` 字段，不需要去重表**。

### 7.3 启动补发：只补"今天"

应用启动时 tick 立即跑一轮。**补发只补当天，不回溯历史**。

理由：8 月 3 日出差一周，8 月 10 日回来打开，若回溯会补建 `08-04`~`08-09` 五个"过去的空清单"，无意义且占列表。只补今天符合真实工作流。

### 7.4 月/年兜底

低频计划漏了月初那天（如 1 号没开软件），当月就永远没目录。兜底规则：

- 若今天已过当月 1 号、但当月目录不存在 → 补建当月目录。
- 但若用户**手动新建过**（目录已存在）→ 尊重用户，跳过。

这天然由 `ensure_scheduled_path` 的"已存在则跳过"实现，无需额外判断分支。

实现要点：`monthly`/`yearly` 计划在 tick 里除"命中日生成"外，再加一步"当期目录是否存在"检查；daily/weekly/workday 不做此兜底（日清单过去了就不补）。

## 八、UI 入口与交互

### 8.1 入口

设置页 `SettingsView.vue` 的 `sections` 数组新增一项：

```ts
{ id: "schedule", icon: IconCalendar, label: "清单生成计划" }
```

右侧用 `v-if="activeSection === 'schedule'"` 渲染，内部嵌独立组件 `<ListScheduleSection />`（仿 `TemplateSection.vue` 先例）。

### 8.2 界面结构

沿用设置页 `.settings-section` + `.settings-section__item` 横向行风格：

- 顶部一行说明文字 +「新建计划」按钮。
- 计划列表：每条一行卡片，显示名称、频率、路径模板预览，右侧开关（启用/停用）+ 编辑/删除。

### 8.3 新建/编辑计划弹窗

沿用 `sidebar-create-modal` 风格（宽 440），字段：

- 名称（input）
- 频率（下拉：每天/每周/每月/每年/工作日）
- 路径模板（input）
- 颜色（8 色板，缺省随机）

### 8.4 路径模板输入框旁的说明图标

用 `<a-tooltip position="bottom">` 包一个 `<IconInfoCircle :size="14" />`，悬浮显示占位符说明表（第 5.1 节）。风格对齐 `TaskDetailPanel.vue` 的说明性 tooltip 用法。

### 8.5 颜色

复用 `LIST_COLORS`（`TheSidebar.vue:324`，8 色）保持与清单配色一致；缺省时 `LIST_COLORS[Math.floor(Math.random() * 8)]` 随机一个，创建后存入计划的 `color` 字段。

### 8.6 异常提醒

降级时走原生通知（复用项目已有通知能力），不阻塞 UI；设置页本区块顶部顺带显示一行小字状态提示。

## 九、实现要点（实施时遵循）

1. **复用优先**：日期推算可参考 `next_recurrence_date`（`commands.rs:1778`）；调度入口挂 `lib.rs:59` 现有循环；建清单走 `list_create`（`commands.rs:111`）。
2. **纯函数优先**：`render_path_template`、`is_workday`、路径拆分等保持纯函数，可单测。
3. **Migration 幂等**：两张表均 `CREATE TABLE IF NOT EXISTS`；`holidays` 用 `INSERT OR REPLACE`。
4. **文件行数硬性指标**：Rust 文件不超 400 行，单层目录文件不超 8 个（本设计已按模块拆分 `list_schedule/` 子目录）。
5. **类型同步**：TS 接口与 Rust struct 手动保持一致。
6. **命令封装**：前端 `api/db.ts` 加 `getListSchedules / createListSchedule / updateListSchedule / deleteListSchedule`，store 放 `stores/listSchedule.ts`。
7. **中文注释**：所有代码注释用中文，详细便于维护。

## 十、不在本期范围（YAGNI）

- interval（每 N 天/周/月）与"指定星期几"的自定义频率。
- 多套计划间依赖/触发关系。
- 历史日期清单回溯补建。
- 节假日数据定期自动刷新（启动检查已足够）。
