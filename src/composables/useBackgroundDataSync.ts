// 后台任务数据同步 —— 监听 Rust 侧 bg:data-changed 事件刷新 stores
//
// 背景：重复任务实例 / 清单生成计划由 Rust 后台 tick 直写 SQLite（lib.rs），
// 前端不感知。生成数量 > 0 时 Rust emit 此事件，在此统一刷新：
// 当前视图任务 + 侧边栏计数 + 清单树。
// （后台生成不涉及标签，无需刷 tagStore）
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";

/** 挂载监听（AppLayout onMounted 调一次）。返回卸载函数（Promise 形态，调用方 .then 接住） */
export function setupBackgroundDataSync(): Promise<UnlistenFn> {
  return listen("bg:data-changed", () => {
    const taskStore = useTaskStore();
    const listStore = useListStore();
    // reload 只重载当前视图任务列表，不刷计数——侧边栏清单徽标、
    // 智能视图计数、AppRail 全局徽标都来自 refreshCounts，必须显式调
    taskStore.reload(true).catch((e) => console.error("[BgSync] 刷新任务失败:", e));
    taskStore.refreshCounts().catch((e) => console.error("[BgSync] 刷新计数失败:", e));
    listStore.loadLists().catch((e) => console.error("[BgSync] 刷新清单失败:", e));
  });
}
