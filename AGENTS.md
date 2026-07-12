# AGENTS.md

ZCode agent 在 **JustToDo** 项目中的工作指引。

## 项目简介

JustToDo 是一个跨平台**待办 / 任务管理桌面应用**。桌面客户端基于
**Tauri 2.x**（Rust 后端）+ **Vue 3** 前端实现，UI 使用
**Arco Design Vue** 组件库。

> 本文件是项目约定的唯一事实来源。修改敏感区域（IPC 层、持久化、状态、
> 构建配置）前请先阅读本文件。

## 技术栈

| 层级     | 技术                                                                        |
| -------- | -------------------------------------------------------------------------- |
| 桌面外壳 | **Tauri 2.x**（Rust）— `src-tauri/`                                        |
| 前端     | **Vue 3.5**（`<script setup>` SFC）+ **Vue Router** + **Pinia**            |
| UI 库    | **Arco Design Vue**（`@arco-design/web-vue`）                              |
| 富文本   | **Tiptap 3.x**（StarterKit + CodeBlockLowlight + Image resize）            |
| 构建工具 | **Vite 6**                                                                  |
| 语言     | 前端 **TypeScript**；原生 / 后端 **Rust**                                  |
| 持久化   | **SQLite**（sqlx 直接操作，非 plugin-sql）— `src-tauri/src/db/`            |
| 代码高亮 | **lowlight**（common 语言集）                                              |
| GUI 测试 | **tauri-plugin-mcp**（MCP 协议驱动截图 / 交互）                            |

## 目录结构

```
JustToDo/
├── src/                      # Vue 3 前端（在 webview 中渲染）
│   ├── assets/               # 静态资源（图标、图片、字体）
│   ├── components/           # 可复用组件
│   │   ├── TheSidebar.vue    # 侧边栏（智能视图/清单/标签/习惯，可收起）
│   │   ├── TaskDetailPanel.vue # 任务详情面板（可拖拽宽度、ESC关闭）
│   │   ├── TaskListItem.vue  # 任务列表项（树形递归、展开/收起子任务）
│   │   ├── TaskCheckbox.vue  # 圆形复选框
│   │   ├── PriorityDot.vue   # 优先级色点（无=空心圈）
│   │   ├── AddTaskBar.vue    # 底部快速添加栏（flex-wrap 自适应）
│   │   ├── RichTextEditor.vue # Tiptap 富文本编辑器（图片粘贴/缩放/预览）
│   │   ├── SearchPalette.vue # Cmd+K 全局搜索
│   │   └── QuickAddDialog.vue # Cmd+Shift+A 快速添加
│   ├── views/                # 路由级页面
│   │   ├── ListView.vue      # 清单视图
│   │   ├── SmartView.vue     # 智能视图（今天/未来7天/全部）
│   │   ├── TagView.vue       # 标签视图
│   │   ├── HabitView.vue     # 习惯打卡
│   │   └── SettingsView.vue  # 设置（主题/附件路径）
│   ├── stores/               # Pinia store
│   │   ├── task.ts           # 任务（CRUD + 子任务缓存 + 选中态）
│   │   ├── list.ts           # 清单
│   │   ├── tag.ts            # 标签
│   │   ├── search.ts         # 搜索（debounce）
│   │   └── habit.ts          # 习惯
│   ├── composables/          # 组合式钩子
│   │   ├── useTheme.ts       # 深色模式（body[arco-theme="dark"]）
│   │   └── useShortcuts.ts   # 全局快捷键
│   ├── api/
│   │   └── db.ts             # IPC 封装（invoke → Rust commands）
│   ├── router/               # Vue Router（hash 模式）
│   ├── types/                # 共享 TS 类型
│   ├── utils/                # 工具函数（date.ts 等）
│   ├── styles/
│   │   ├── theme.css         # Arco CSS 变量 + 自定义 --jt-* token
│   │   └── typography.css    # 字体（Fraunces + Geist + JetBrains Mono）
│   ├── layouts/
│   │   └── AppLayout.vue     # 三栏布局（侧边栏 + 主区 + 详情面板）
│   └── main.ts               # 入口（注册 Arco + 图标 + MCP）
├── src-tauri/                # Tauri / Rust 后端
│   ├── src/
│   │   ├── commands.rs       # #[tauri::command] 处理器
│   │   ├── models.rs         # 数据模型（Task/List/Tag/Habit）
│   │   ├── db/
│   │   │   ├── mod.rs        # 连接池 + migration（含幂等 ALTER TABLE）
│   │   │   └── migrations/
│   │   │       ├── 001_init.sql
│   │   │       ├── 002_habits.sql
│   │   │       └── 003_due_range.sql
│   │   └── lib.rs            # App 入口（插件注册 + invoke_handler）
│   ├── capabilities/         # Tauri 2 权限配置
│   ├── tauri.conf.json       # 构建/窗口/安全配置（assetProtocol 已启用）
│   └── Cargo.toml
├── package.json
├── vite.config.ts
├── tsconfig.json
└── AGENTS.md
```

## 架构与分层规则

- **前端 ↔ 后端边界**：所有与 Rust 的交互通过类型化的
  `#[tauri::command]` 处理器，前端用 `@tauri-apps/api` 的 `invoke()` 调用。
  前端**禁止**直接调用原生文件系统 / 进程 API。
- **持久化**：SQLite 通过 **sqlx** 直接操作（Rust 端），**不是** plugin-sql。
  连接池以 `State<'_, sqlx::SqlitePool>` 注入到每个 command。
- **Migration**：`001`/`002` 用 SQL 文件（幂等 `IF NOT EXISTS`）；
  `003` 用 Rust 代码处理（SQLite 不支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，
  需先用 `PRAGMA table_info` 检查列是否存在）。新增 migration 需遵循幂等原则。
- **状态管理**：前端以 **Pinia** store 作为唯一数据源。
  - `task.ts` 维护三组数据：`currentTasks`（当前视图根任务）、
    `subtasks`（详情面板子任务）、`subtaskCache`（树形列表懒加载缓存）。
  - `selectedTaskObj` 是独立 `ref<Task | null>`，不依赖任何数组（避免层级切换时丢失）。
  - `toggleTask` / `updateTask` 用 `updateTaskInArray()` 创建新数组引用触发响应式，
    需同时更新 `currentTasks` / `subtasks` / `subtaskCache` / `selectedTaskObj`。
- **Arco 组件**：优先使用 Arco Design Vue 组件。图标用
  `@arco-design/web-vue/es/icon`（Arco 自带 SVG 图标，非 mdi）。
- **数据模型**：TS 接口在 `src/types/`，Rust 结构体在 `src-tauri/src/models.rs`。
  需手动保持两侧同步。
- **图片附件**：通过 Rust `save_image` 保存到本地，前端用
  `convertFileSrc()` 转换路径（Tauri 2 webview 禁止 `file://`）。
  `tauri.conf.json` 已启用 `assetProtocol: { enable: true, scope: ["**"] }`。

## 数据模型要点

- **任务截止日期**是日期范围：`due_start_at` + `due_end_at`（两个独立字段），
  而非单个 `due_at`。智能视图按 `due_end_at` 过滤。
- **优先级**：0 无 / 1 低 / 2 中 / 3 高。`PriorityDot` 组件对"无"渲染空心圈。
- **子任务**：`parent_id` 自引用，支持多级嵌套。树形列表（TaskListItem）递归渲染。

## 命令

```bash
# 安装前端依赖
npm install

# 开发模式 — 启动 Tauri 窗口，前端热更新 + Rust
npm run tauri dev

# 仅前端开发服务器（不启动原生窗口）
npm run dev

# 前端类型检查
npx vue-tsc --noEmit

# 前端构建
npx vite build

# Rust 检查（在 src-tauri/ 下执行）
cargo check
cargo clippy
cargo fmt
```

## 编码规范

### 前端（Vue 3 + TS）
- 统一使用 **`<script setup lang="ts">`** SFC 风格。
- 使用 **Composition API**，**禁止**使用 Options API。
- 命名：组件用 **PascalCase**，组合式函数用 **camelCase**（`useXxx`），
  CSS 类名用 **kebab-case**。
- 导入路径：使用 **`@/`** 路径别名。
- CSS 变量：使用 `--jt-*` 自定义 token（定义在 `src/styles/theme.css`）。
- **避免 `as any`**：除非 Arco 组件类型不兼容（如 `format-label` 返回 VNode）。

### Rust（src-tauri）
- 遵循 `cargo fmt` + `cargo clippy` 的输出。
- `#[tauri::command]` 函数保持精简：校验输入 → 委托 → 返回可序列化类型。
- 返回值使用 `Result<T, String>`。
- **Migration 幂等**：`ALTER TABLE` 必须先检查列是否存在。

## Tauri 2.x 注意事项

- **图片加载**：webview 禁止 `file://`，必须用 `convertFileSrc()` 转换为
  `asset://localhost/...` 协议。`tauri.conf.json` 的 `assetProtocol` 必须启用。
- **Capabilities / 权限**：`src-tauri/capabilities/default.json` 白名单管理。
  新增原生 API（dialog、fs 等）必须显式授权。
- **invoke 类型标注**：始终为 `invoke<T>()` 标注返回值类型。

## 主题系统

- **浅色**：暖白背景 `#FAFAF7`，靛蓝强调 `#4F46E5`。
- **深色**：`body[arco-theme="dark"]` 切换，Arco CSS 变量自动适配。
- 字体：Fraunces（标题）+ Geist（正文）+ JetBrains Mono（代码/快捷键）。

## 当前状态

✅ **已开发完成** — 三栏布局、任务 CRUD、子任务树形展开、智能视图、
标签管理、习惯打卡、富文本备注（含图片粘贴/缩放/预览）、全局搜索、
快速添加、深色模式、侧边栏收起、任务详情面板（可拖拽/ESC关闭/面包屑导航）。
