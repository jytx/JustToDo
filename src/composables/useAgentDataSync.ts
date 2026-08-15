// AI Agent 数据同步 —— 监听 Rust 侧 ai:data-changed 事件刷新 stores
//
// 背景：agent 的写工具在 Rust 端直写 SQLite，而 Pinia store 是前端唯一数据源。
// 会话轮结束且发生写操作时（commands/agent.rs emit），在此统一刷新：
// 当前视图任务 + 侧边栏计数 + 清单树 + 标签。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";

/** 挂载监听（AppLayout onMounted 调一次）。返回卸载函数（Promise 形态，调用方 .then 接住） */
export function setupAgentDataSync(): Promise<UnlistenFn> {
  return listen("ai:data-changed", () => {
    const taskStore = useTaskStore();
    const listStore = useListStore();
    const tagStore = useTagStore();
    // 当前视图任务重载（保持选中）+ 各类计数/树/标签
    taskStore.reload(true).catch((e) => console.error("[AgentSync] 刷新任务失败:", e));
    listStore.loadLists().catch((e) => console.error("[AgentSync] 刷新清单失败:", e));
    tagStore.loadTags().catch((e) => console.error("[AgentSync] 刷新标签失败:", e));
  });
}
