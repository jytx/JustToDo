// 视图偏好持久化 —— 按清单记住用户选择的视图（列表/看板/时间线）、看板维度、
// 时间线是否显示已完成。
//
// 用 localStorage 存储（UI 偏好，无需进 DB schema）。每个清单独立记录，
// key 形如 "jt-view-pref:list:{listId}"，值为 JSON。
// 查不到时返回默认值（列表视图 + 优先级维度 + 显示已完成）。

import { type KanbanMode } from "@/stores/kanban";

/** 清单视图类型 */
export type ListView = "list" | "kanban" | "timeline";

/** 单个清单的视图偏好 */
interface ViewPref {
  /** 视图：列表 / 看板 / 时间线 */
  view: ListView;
  /** 看板维度（仅看板视图有意义）：优先级 / 分组 */
  kanbanMode: KanbanMode;
  /** 时间线是否显示已完成任务（默认 true） */
  showCompleted: boolean;
}

const DEFAULT_PREF: ViewPref = { view: "list", kanbanMode: "priority", showCompleted: true };
const PREFIX = "jt-view-pref:list:";

/** 读取某清单的视图偏好（无记录返回默认值） */
export function getViewPref(listId: string): ViewPref {
  try {
    const raw = localStorage.getItem(PREFIX + listId);
    if (!raw) return { ...DEFAULT_PREF };
    const parsed = JSON.parse(raw) as Partial<ViewPref>;
    const view: ListView = parsed.view === "kanban" || parsed.view === "timeline" ? parsed.view : "list";
    return {
      view,
      kanbanMode: parsed.kanbanMode === "group" ? "group" : "priority",
      showCompleted: parsed.showCompleted !== false,
    };
  } catch {
    return { ...DEFAULT_PREF };
  }
}

/** 写入某清单的视图偏好（局部更新，合并已有值） */
export function setViewPref(listId: string, patch: Partial<ViewPref>): void {
  try {
    const current = getViewPref(listId);
    const next = { ...current, ...patch };
    localStorage.setItem(PREFIX + listId, JSON.stringify(next));
  } catch {
    // localStorage 不可用（隐私模式等）时静默失败，不影响功能
  }
}
