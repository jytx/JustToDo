// 附件上传逻辑（文件选择 / 路径转 File / 拦截可执行类 / 调 store 落盘）
//
// 抽成 composable 的原因：附件区默认不展示（无附件时不渲染），
// 但"添加附件"入口在任务详情面板的更多菜单里，两者都需要这套上传逻辑。
// 提取后 TaskDetailPanel 和 AttachmentSection 可共用，避免重复（DRY）。

import { ref } from "vue";
import { Message } from "@arco-design/web-vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTaskStore } from "@/stores/task";
import { isBlockedAttachment } from "@/types";

/**
 * 附件上传 composable
 * @param taskId 目标任务 id
 * @returns uploading（上传中标记）+ pickFiles（打开文件选择器）+ addFiles（批量添加 File 对象）
 */
export function useAttachmentUpload(taskId: () => string) {
  const taskStore = useTaskStore();
  // 上传中标记（批量添加时用于 UI 反馈，如更多菜单按钮的 disabled）
  const uploading = ref(false);

  /** 校验并过滤文件列表（拦截可执行类） */
  function filterValidFiles(files: File[]): File[] {
    const blocked: string[] = [];
    const valid: File[] = [];
    for (const f of files) {
      if (isBlockedAttachment(f.name)) {
        blocked.push(f.name);
      } else {
        valid.push(f);
      }
    }
    if (blocked.length > 0) {
      Message.warning(`已拦截可执行文件：${blocked.join("、")}`);
    }
    return valid;
  }

  /** 把本地文件路径转为 File 对象（通过 fetch asset 协议读 blob） */
  async function pathToFile(path: string): Promise<File | null> {
    try {
      // Tauri 2 中可用 fetch + convertFileSrc 读本地文件
      const src = convertFileSrc(path);
      const res = await fetch(src);
      const blob = await res.blob();
      // 从路径提取文件名
      const name = path.split(/[/\\]/).pop() ?? "file";
      return new File([blob], name, { type: blob.type });
    } catch (e) {
      console.error("[Attachment] 读文件失败:", path, e);
      return null;
    }
  }

  /** 批量添加 File 对象到目标任务 */
  async function addFiles(files: File[]): Promise<void> {
    const valid = filterValidFiles(files);
    if (valid.length === 0) return;

    const id = taskId();
    if (!id) return;

    uploading.value = true;
    try {
      await taskStore.addAttachments(id, valid);
      Message.success(`已添加 ${valid.length} 个附件`);
    } catch (e) {
      console.error("[Attachment] 添加附件失败:", e);
      Message.error("添加附件失败：" + String(e));
    } finally {
      uploading.value = false;
    }
  }

  /** 打开系统文件选择器，选完后自动添加 */
  async function pickFiles(): Promise<void> {
    const selected = await openDialog({ multiple: true });
    if (!selected) return;
    // openDialog 单选返回 string，多选返回 string[]；统一成数组
    const paths = Array.isArray(selected) ? selected : [selected];
    // 从路径读 File 对象（Tauri dialog 返回的是路径字符串，需要 fetch 转 File）
    const files: File[] = [];
    for (const p of paths) {
      const file = await pathToFile(p);
      if (file) files.push(file);
    }
    await addFiles(files);
  }

  return { uploading, pickFiles, addFiles };
}
