// HTML → Markdown 转换（turndown）
//
// 从 RichTextEditor 抽出的共享转换：源码模式切换与任务导出（useTaskExport）共用，
// 保证两条路径对同一富文本 HTML 产出一致的 Markdown。
//
// 配置要点：
// - atx 标题（#）/ fenced 代码块（```）/ 无序列表用 -
// - GFM 删除线插件（~~text~~）
// - 三条自定义规则适配 Tiptap 的 DOM 结构（标题 NodeView / 表格 / 任务列表）

import TurndownService from "turndown";
import * as turndownPluginGfm from "turndown-plugin-gfm";

/** TurndownService 单例（纯转换无状态，全局共享即可） */
const turndownService = new TurndownService({
  headingStyle: "atx", // 标题用 # 风格
  codeBlockStyle: "fenced", // 代码块用 ``` 围栏
  bulletListMarker: "-", // 无序列表用 -
});
// GFM 删除线插件（~~text~~）
turndownService.use(turndownPluginGfm.strikethrough);

// 标题 NodeView（heading-block）：编辑器内标题渲染为 .heading-block--h{N} 包裹的
// div（NodeViewContent 固定 as=div，见 HeadingView），turndown 默认 heading 规则
// 按 h1-h6 tagName 识别不到。这里自定义规则按 class 的级别数字转 ATX 标题（# 前缀）。
turndownService.addRule("headingBlocks", {
  filter: (node: HTMLElement) => /^heading-block--h[1-6]$/.test(node.className ?? ""),
  replacement: (content: string, node: HTMLElement) => {
    const m = /^heading-block--h([1-6])$/.exec(node.className ?? "");
    if (!m) return content;
    // 折叠按钮（空 button + 图标）转出的空内容直接丢弃，只保留标题文字
    return `${"#".repeat(Number(m[1]))} ${content.trim()}\n\n`;
  },
});

// 表格 → Markdown 表格语法（| col | col |）。
// 不用 gfm.tables：Tiptap 表格单元格内含 <p>、colspan/rowspan 属性，gfm 规则
// 处理不了会拆成零散文本。这里自定义规则：逐行取单元格纯文本，用 | 拼接。
turndownService.addRule("tables", {
  filter: (node: HTMLElement) => node.nodeName === "TABLE",
  replacement: (_content: string, node: HTMLElement) => {
    const rows: string[][] = [];
    node.querySelectorAll("tr").forEach((tr) => {
      const cells: string[] = [];
      tr.querySelectorAll(":scope > td, :scope > th").forEach((cell) => {
        // 单元格纯文本：去掉内部 <p> 的换行，压缩空格
        const text = (cell.textContent ?? "").trim().replace(/\s*\n\s*/g, " ");
        cells.push(text.replace(/\|/g, "\\|"));
      });
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length === 0) return "";
    // 第一行作表头，第二行是分隔行 | --- | --- |
    const header = `| ${rows[0].join(" | ")} |`;
    const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
    const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`);
    return `\n\n${[header, sep, ...body].join("\n")}\n\n`;
  },
});

// 任务列表（checkbox）转 Markdown 任务语法：- [ ] / - [x]
turndownService.addRule("taskListItems", {
  filter: (node: HTMLElement) => node.nodeName === "LI" && node.getAttribute("data-type") === "taskItem",
  replacement: (content: string, node: HTMLElement) => {
    const checked = node.getAttribute("data-checked") === "true";
    return `- [${checked ? "x" : " "}] ${content.trim()}\n`;
  },
});

/** 富文本 HTML → Markdown（纯函数） */
export function htmlToMarkdown(html: string): string {
  return turndownService.turndown(html);
}
