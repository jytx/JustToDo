// 任务/笔记导出 Markdown composable（IO 层）
//
// 入口三处（与「创建副本」一致）：TaskListItem 右键菜单 / 行内 ⋯ 菜单 / 详情面板更多菜单。
// 流程：系统保存对话框（save，默认文件名 = 标题.md）→ 递归拉取子项树 →
// 渲染 Markdown（纯函数在 utils/taskMarkdown.ts）→ Rust 写入（write_export_text）。
// 标签从 taskStore.taskTagMap 取（列表项与详情面板统一来源）。

import { ref } from "vue";
import { Message } from "@arco-design/web-vue";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useTaskStore } from "@/stores/task";
import { getSubtasks, writeExportText } from "@/api/db";
import { renderTaskMarkdown, sanitizeFileName } from "@/utils/taskMarkdown";
import type { ExportNode } from "@/utils/taskMarkdown";
import type { Task } from "@/types";

/** 递归拉取任务及其全部子项（每节点一次查询；单任务子项量级小） */
async function fetchExportTree(task: Task): Promise<ExportNode> {
  const subs = await getSubtasks(task.id);
  const children = await Promise.all(subs.map(fetchExportTree));
  return { task, children };
}

/**
 * 任务/笔记导出
 * @returns exporting（导出中标记）+ exportTask（弹保存对话框并导出 Markdown）
 */
export function useTaskExport() {
  const taskStore = useTaskStore();
  const exporting = ref(false);

  /** 导出单个任务/笔记为 Markdown 文件 */
  async function exportTask(task: Task): Promise<void> {
    if (exporting.value) return;
    const target = await saveDialog({
      defaultPath: `${sanitizeFileName(task.title)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!target) return; // 用户取消，静默返回
    exporting.value = true;
    try {
      const tree = await fetchExportTree(task);
      const tags = taskStore.taskTagMap[task.id] ?? [];
      const markdown = renderTaskMarkdown(tree, tags);
      await writeExportText(target, markdown);
      Message.success(`已导出到 ${target}`);
    } catch (e) {
      console.error("[TaskExport] 导出失败:", e);
      Message.error("导出失败：" + String(e));
    } finally {
      exporting.value = false;
    }
  }

  return { exporting, exportTask };
}
