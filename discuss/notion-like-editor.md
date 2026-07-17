# Notion-like 编辑器升级

参考 https://template.tiptap.dev/notion-like/KfcWkL8pPT 实现的富文本编辑器增强。

> 本文档位于 `discuss/`，是开发备忘，**不入版本库**。AGENTS.md 也指向此路径。

## 提供的体验

| 能力 | 用户视角 |
|---|---|
| 块级 placeholder | 光标在空段落，提示 "按 / 唤起命令，输入备注…" |
| 输入 `/` 唤起 block 选择菜单 | 弹出 10 种 block 选项（正文/H1/H2/H3/无序/有序/待办/引用/代码/分隔线），↑↓ Enter 切换执行 |
| Global Drag Handle | hover 任一 block，左侧浮 ⋮⋮，可拖动重排 |
| 空段落浮 `+` 按钮 | 光标在空段首时，左侧浮 `+`，点击插入 `/` 触发 slash menu |

## 实现组件

| 组件 | 位置 |
|---|---|
| Tiptap base extensions | `src/components/RichTextEditor.vue` |
| `@tiptap/extension-placeholder`（OSS） | 块级 placeholder |
| `@tiptap/suggestion`（OSS） | `/` 触发 |
| `tiptap-extension-global-drag-handle`（社区 AGPL/MIT） | 拖拽手柄 |
| `SlashCommandMenu.vue` | block 选择菜单 UI（受控） |
| `RichTextFloatingMenu.vue` | 空段落浮 `+` 按钮（受控） |

## Tiptap Pro 与 OSS 边界

参考 Notion-like 的官方实现用了 `@tiptap-pro/extension-unique-id` + `@tiptap/ui`（商业插件，付费）。我们**完全使用 OSS / 社区等效方案**，不引入 `@tiptap-pro/*`。具体未实现的能力：

- AI（Continue Writing / Ask AI）—— 需要 LLM 后端，留作后续
- Mention（@ 唤起人员）—— 当前项目不需要
- Emoji / Table / TOC —— 单 extension，需要时单独引入

## AGPL 注意

`tiptap-extension-global-drag-handle` 是 AGPL/MIT 包：
- **AGPL ≠ GPL**：发布 web 服务时不需要公开衍生代码
- Tauri 应用不发布为 web 服务，仅在用户机器本地运行 renderer，AGPL 条款不实际触发
- 修改该插件本身并分发其修改版时才需要 AGPL 条款（本项目不修改该插件源码）

如未来以纯 Web 形式分发应用或 fork 修改该插件源码，请法务复核。

## 相关文件

- `src/components/RichTextEditor.vue`：主编辑器，集成所有 extension
- `src/components/SlashCommandMenu.vue`：block 选择菜单
- `src/components/RichTextFloatingMenu.vue`：空段 `+` 按钮
- `src/components/RichTextToolbar.vue`：顶部工具条（与 slash / drag 是平行入口，互不冲突）
