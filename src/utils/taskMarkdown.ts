// 任务/笔记 → Markdown 导出渲染（纯函数集）
//
// 供 useTaskExport composable 调用：输入任务树 + 标签，输出整篇 Markdown 文档。
// 与 IO 完全解耦（不弹对话框、不写文件），便于独立测试与复用。
//
// 导出结构：
// # 标题
// 元数据行（仅有值时）：优先级 / 截止 / 标签 / 链接 / 附件
// 正文（HTML → Markdown，见 utils/markdown.ts）
// ## 子任务（任务型子项 → checkbox 嵌套列表，子项带正文则缩进追加）
// 检查项（checklist → checkbox 列表，并入各条目正文区）
// 笔记型子项 → 追加为独立章节（## 标题 + 正文，其子项递归）

import { htmlToMarkdown } from "@/utils/markdown";
import { PRIORITY_LABELS } from "@/types";
import type { Task } from "@/types";
import type { Tag } from "@/api/db";

/** 导出树节点：任务 + 递归子项（由 useTaskExport 负责拉取组装） */
export interface ExportNode {
  task: Task;
  children: ExportNode[];
}

/** 子项渲染结果：任务型子项的列表行 + 笔记型子项的章节（互不混排） */
interface ChildrenRender {
  listLines: string[];
  sections: string[];
}

/** 本地日期字面量 → 导出可读格式（00:00 整只留日期） */
function formatExportDate(iso: string): string {
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return time === "00:00" ? date : `${date} ${time}`;
}

/** 标题净化为合法文件名（去掉文件系统非法字符，空标题兜底「未命名」） */
export function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, "").trim();
  return cleaned || "未命名";
}

/** 渲染单条目的正文区（note → Markdown + checklist → checkbox 列表），每行加缩进 */
function renderBody(task: Task, indent: string): string {
  const parts: string[] = [];
  if (task.note) {
    const md = htmlToMarkdown(task.note).trim();
    if (md) parts.push(md);
  }
  if (task.checklist.length > 0) {
    parts.push(task.checklist.map((c) => `- [${c.done ? "x" : " "}] ${c.title}`).join("\n"));
  }
  // 空行不加缩进（Markdown 段落间空行保持为空）
  return parts
    .join("\n\n")
    .split("\n")
    .map((l) => (l ? indent + l : l))
    .join("\n");
}

/** 递归渲染子项：任务型 → checkbox 嵌套列表；笔记型 → 独立章节 */
function renderChildren(nodes: ExportNode[], depth: number, noteLevel: number): ChildrenRender {
  const out: ChildrenRender = { listLines: [], sections: [] };
  for (const node of nodes) {
    if (node.task.kind === "note") {
      out.sections.push(renderNoteSection(node, noteLevel));
      continue;
    }
    const indent = "  ".repeat(depth);
    const title = node.task.title || "未命名";
    out.listLines.push(`${indent}- [${node.task.done ? "x" : " "}] ${title}`);
    const body = renderBody(node.task, indent + "  ");
    if (body) out.listLines.push(body);
    const sub = renderChildren(node.children, depth + 1, noteLevel);
    out.listLines.push(...sub.listLines);
    out.sections.push(...sub.sections);
  }
  return out;
}

/** 渲染笔记型子项为章节：标题 + 正文 + 其子项递归 */
function renderNoteSection(node: ExportNode, level: number): string {
  const heading = `${"#".repeat(level)} ${node.task.title || "未命名"}`;
  const parts = [heading, renderBody(node.task, "")];
  const sub = renderChildren(node.children, 0, level + 1);
  if (sub.listLines.length > 0) parts.push(sub.listLines.join("\n"));
  parts.push(...sub.sections);
  return parts.filter(Boolean).join("\n\n");
}

/** 组装元数据行（仅有值的行；任务才有截止时间） */
function buildMetaLines(task: Task, tags: Tag[]): string[] {
  const lines: string[] = [];
  if (task.priority > 0) {
    lines.push(`- 优先级：${PRIORITY_LABELS[task.priority]}`);
  }
  if (task.kind === "task" && (task.dueStartAt || task.dueEndAt)) {
    const start = task.dueStartAt ? formatExportDate(task.dueStartAt) : "";
    const end = task.dueEndAt ? formatExportDate(task.dueEndAt) : "";
    const sameDay =
      !!task.dueStartAt && !!task.dueEndAt && task.dueStartAt.slice(0, 10) === task.dueEndAt.slice(0, 10);
    lines.push(`- 截止：${sameDay ? end : [start, end].filter(Boolean).join(" ~ ")}`);
  }
  if (tags.length > 0) {
    lines.push(`- 标签：${tags.map((t) => `#${t.name}`).join(" ")}`);
  }
  if (task.titleUrl) {
    lines.push(`- 链接：${task.titleUrl}`);
  }
  if (task.attachments.length > 0) {
    lines.push(`- 附件：${task.attachments.map((a) => a.originalName).join("、")}`);
  }
  return lines;
}

/** 渲染整篇导出 Markdown */
export function renderTaskMarkdown(root: ExportNode, tags: Tag[]): string {
  const parts: string[] = [`# ${root.task.title || "未命名"}`];
  const meta = buildMetaLines(root.task, tags);
  if (meta.length > 0) parts.push(meta.join("\n"));
  const body = renderBody(root.task, "");
  if (body) parts.push(body);
  const sub = renderChildren(root.children, 0, 2);
  if (sub.listLines.length > 0) {
    parts.push(["## 子任务", sub.listLines.join("\n")].join("\n\n"));
  }
  parts.push(...sub.sections);
  return `${parts.join("\n\n")}\n`;
}
