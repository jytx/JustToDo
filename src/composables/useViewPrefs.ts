// 视图偏好持久化 —— 按作用域（scope）记住用户选择的视图（列表/看板/时间线）、
// 看板维度、时间线是否显示已完成。
//
// 用 localStorage 存储（UI 偏好，无需进 DB schema）。每个作用域独立记录，
// scope 形如 "list:{listId}"（清单）或 "smart:{viewId}"（智能视图 today/upcoming/all），
// 最终 localStorage key 为 "jt-view-pref:{scope}"。
//
// 向后兼容：清单 scope "list:{id}" 对应的 key "jt-view-pref:list:{id}" 与旧版完全一致，
// 已存的清单偏好不会丢失。智能视图是新增 scope，互不干扰。
// 查不到时返回默认值（列表视图 + 优先级维度 + 不显示已完成）。

import { type KanbanMode } from "@/stores/kanban";

/** 清单视图类型 */
export type ListView = "list" | "kanban" | "timeline";

/** 单个作用域的视图偏好 */
interface ViewPref {
  /** 视图：列表 / 看板 / 时间线 */
  view: ListView;
  /** 看板维度（仅看板视图有意义）：优先级 / 分组 */
  kanbanMode: KanbanMode;
  /** 时间线是否显示已完成任务（默认 false，不显示） */
  showCompleted: boolean;
}

const DEFAULT_PREF: ViewPref = { view: "list", kanbanMode: "priority", showCompleted: false };
const PREFIX = "jt-view-pref:";

/** 读取某作用域的视图偏好（无记录返回默认值）。
 *  scope：清单用 "list:{listId}"，智能视图用 "smart:{viewId}" */
export function getViewPref(scope: string): ViewPref {
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw) return { ...DEFAULT_PREF };
    const parsed = JSON.parse(raw) as Partial<ViewPref>;
    const view: ListView = parsed.view === "kanban" || parsed.view === "timeline" ? parsed.view : "list";
    return {
      view,
      kanbanMode: parsed.kanbanMode === "group" ? "group" : "priority",
      // 仅显式 true 才显示已完成（缺失/旧数据默认不显示）
      showCompleted: parsed.showCompleted === true,
    };
  } catch {
    return { ...DEFAULT_PREF };
  }
}

/** 写入某作用域的视图偏好（局部更新，合并已有值）。
 *  scope：清单用 "list:{listId}"，智能视图用 "smart:{viewId}" */
export function setViewPref(scope: string, patch: Partial<ViewPref>): void {
  try {
    const current = getViewPref(scope);
    const next = { ...current, ...patch };
    localStorage.setItem(PREFIX + scope, JSON.stringify(next));
  } catch {
    // localStorage 不可用（隐私模式等）时静默失败，不影响功能
  }
}
