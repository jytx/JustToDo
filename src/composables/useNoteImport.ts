// 笔记导入 composable：系统文件选择器 → Rust 读取 → 转 HTML → 创建笔记。
// 供三处入口共用：侧边栏笔记本右键菜单 / 侧边栏 hover 三点菜单 / 笔记本视图空白右键。
// 模式参考 useAttachmentUpload（openDialog 返回路径数组 → 逐个处理）。
//
// 转换规则（与富文本编辑器保持一致的表达能力）：
// - md / markdown → marked.parse 转 HTML（同富文本 Markdown 粘贴路径，Tiptap 兼容）
// - txt           → 纯文本 HTML 转义 + 按空行分段包 <p>，段内单换行转 <br>
//
// 注意：创建走 db 层直调而非 taskStore.createTask —— 后者会无条件 push 进
// currentTasks（见 task.ts），从侧边栏给「非当前打开的笔记本」导入时会把
// 笔记塞进当前视图。导入完成后按需 loadTasks 刷新 + refreshCounts 刷侧边栏计数。

import { ref } from "vue";
import { Message } from "@arco-design/web-vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { marked } from "marked";
import { useTaskStore } from "@/stores/task";
import { createTask, readImportText, updateTask } from "@/api/db";

/** HTML 特殊字符转义（txt 纯文本导入用，防止原文中的标签被当 HTML 解析） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** txt 原文转 HTML：按空行分段，每段一个 <p>，段内单换行转 <br>；全空白返回 "" */
function plainTextToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return paragraphs
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

/** 按扩展名把文件原文转成笔记正文 HTML（纯函数） */
export function importContentToHtml(content: string, ext: string): string {
  if (ext === "md" || ext === "markdown") {
    return marked.parse(content, { async: false }) as string;
  }
  return plainTextToHtml(content);
}

/** 从绝对路径取文件名（含扩展名），用于失败提示展示 */
function fileNameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** 从绝对路径取小写扩展名（无扩展名返回 ""，如 ".gitignore" 视为无扩展名） */
function fileExtOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * 笔记导入
 * @returns importing（导入中标记）+ pickAndImport（打开文件选择器并导入到指定笔记本）
 */
export function useNoteImport() {
  const taskStore = useTaskStore();
  const importing = ref(false);

  /** 打开系统文件选择器，把选中的 md/txt 逐个导入为目标笔记本的笔记；返回成功篇数 */
  async function pickAndImport(listId: string): Promise<number> {
    if (importing.value) return 0;
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Markdown / 文本", extensions: ["md", "markdown", "txt"] }],
    });
    if (!selected) return 0;
    // openDialog 单选返回 string，多选返回 string[]；统一成数组
    const paths = Array.isArray(selected) ? selected : [selected];

    importing.value = true;
    let ok = 0;
    const failed: string[] = [];
    try {
      // 单文件失败（超限 / 非 UTF-8 等）不中断批量导入，最后汇总提示
      for (const p of paths) {
        try {
          const file = await readImportText(p);
          const note = importContentToHtml(file.content, fileExtOf(p));
          const task = await createTask({ title: file.title, listId, kind: "note" });
          if (note) {
            await updateTask(task.id, { note });
          }
          ok++;
        } catch (e) {
          failed.push(fileNameOf(p));
          console.error("[NoteImport] 导入失败:", p, e);
        }
      }
      if (ok > 0) {
        // 当前正打开该笔记本时刷新列表显示新笔记；侧边栏计数始终刷新
        if (taskStore.currentListId === listId) {
          await taskStore.loadTasks(listId);
        }
        void taskStore.refreshCounts();
        Message.success(`已导入 ${ok} 篇笔记`);
      }
      if (failed.length > 0) {
        Message.error(`导入失败：${failed.join("、")}`);
      }
    } finally {
      importing.value = false;
    }
    return ok;
  }

  return { importing, pickAndImport };
}
