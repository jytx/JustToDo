// 图片上传工具 —— 把 File 保存到本地附件目录并返回可用的 src。
// RichTextEditor 的粘贴/拖拽上传、RichTextToolbar 的"插入图片"按钮共用本模块（DRY）。
//
// 流程：File → base64 → Rust save_image 落盘 → get_attachment_fullpath 拿绝对路径
//       → convertFileSrc 转 asset:// 协议（Tauri 2 webview 禁止 file://）。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Editor } from "@tiptap/vue-3";

/** 上传单张图片并插入到 editor（自动按容器宽度限制初始尺寸）。 */
export async function uploadAndInsertImage(file: File, editor: Editor, maxContainerWidth: number): Promise<void> {
  try {
    const base64 = await fileToBase64(file);
    const ext = file.name.split(".").pop()?.toLowerCase() || "png";

    const filename = await invoke<string>("save_image", {
      data: base64,
      ext,
    });

    const fullPath = await invoke<string>("get_attachment_fullpath", {
      filename,
    });

    const src = convertFileSrc(fullPath);

    // 按原始尺寸设置初始宽度，超过容器则限制
    const dims = await getImageSize(src);
    const maxWidth = Math.max(80, maxContainerWidth - 24);
    const width = dims.width > maxWidth ? maxWidth : dims.width;

    editor.chain().focus().setImage({ src, width }).run();
  } catch (e) {
    console.error("[RichText] 图片上传失败:", e);
  }
}

/** 读取 File 为 base64 字符串（不含 data: 前缀）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 加载图片获取原始尺寸（用于设置初始宽度）。 */
export function getImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = document.createElement("img");
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = src;
  });
}
