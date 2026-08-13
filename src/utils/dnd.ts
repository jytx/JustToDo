// 拖拽 MIME 常量与解析 —— 任务/笔记拖拽用自定义 MIME 与清单拖拽（text/plain）隔离，
// 避免任务 id 被侧边栏当成清单 id 处理（反之亦然）。
// 与 useTaskTagReorder（application/x-task-tag-reorder）、useGroupReorder
// （application/x-group-reorder）同一套自定义 MIME 惯例。
import type { TaskKind } from "@/types";

/** 任务/笔记拖拽的 MIME（值为 JSON：{ id, kind }） */
export const TASK_DRAG_MIME = "application/x-task-drag";

/** 任务拖拽 payload（dragstart 时序列化进 dataTransfer） */
export interface TaskDragPayload {
  id: string;
  kind: TaskKind;
}

/** 判断本次拖拽是否为任务/笔记拖拽（dataTransfer.types 包含自定义 MIME）。
 *  Array.from 兼容 DOMStringList / FrozenArray 两种 types 实现。 */
export function hasTaskDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes(TASK_DRAG_MIME);
}

/** 解析任务拖拽 payload；非任务拖拽或数据损坏返回 null */
export function parseTaskDrag(e: DragEvent): TaskDragPayload | null {
  if (!hasTaskDrag(e)) return null;
  try {
    const raw = e.dataTransfer!.getData(TASK_DRAG_MIME);
    const parsed = JSON.parse(raw) as Partial<TaskDragPayload>;
    if (
      typeof parsed?.id === "string" &&
      (parsed.kind === "task" || parsed.kind === "note")
    ) {
      return { id: parsed.id, kind: parsed.kind };
    }
  } catch {
    // 数据损坏按非任务拖拽处理（由清单拖拽逻辑兜底）
  }
  return null;
}
