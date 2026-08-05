// 表格扩展集合 —— 用 Tiptap 3 的 TableKit 一键加载 Table/TableRow/TableCell/TableHeader。
//
// 第一版不做列宽拖拽（resizable: false），保持简洁。
// 命令：insertTable({rows,cols}) / addColumnBefore/After / deleteColumn /
//       addRowBefore/After / deleteRow / mergeCells / splitCell /
//       toggleHeaderRow/Column/Cell / deleteTable
// Tab 键跳下一单元格由 Table 内置 keymap 提供，无需额外处理。
import { TableKit } from "@tiptap/extension-table";

/** 表格扩展，RichTextEditor 直接加到 extensions 数组 */
export const tableExtension = TableKit.configure({
  table: {
    resizable: false,
    allowTableNodeSelection: true,
  },
});

export default tableExtension;
