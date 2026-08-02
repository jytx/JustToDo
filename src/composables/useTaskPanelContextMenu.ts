// 任务主面板右键菜单 composable
// ListView / SmartView / TagView 三个视图共用：右键面板空白区域 → 弹出「新建任务」菜单。
// 唯一差异是新建任务归属的 listId，由各视图通过参数传入。
//
// 设计要点：
// 1. 右键落在输入框 / 文本域 / contentEditable 上时放行系统菜单（保留复制/粘贴等）。
// 2. 右键落在任务项（.task-item）上时不弹出面板菜单 —— 任务项有自己专属的右键菜单。
//    通过在 contextmenu 事件冒泡到面板根前，由任务项的 @contextmenu.prevent.stop 拦截。
// 3. 新建任务走「空标题 + 选中打开详情面板」范式，与任务项右键的「新建任务」一致，
//    让用户直接在详情面板输入标题。

import { reactive } from "vue";
import { useTaskStore } from "@/stores/task";
import type { TaskKind } from "@/types";
import { shouldReserveNativeMenu } from "@/utils/contextMenu";

/** 右键菜单的坐标 + 可见性 + 命中分组 */
interface CtxMenuState {
  visible: boolean;
  x: number;
  y: number;
  /** 右键就近命中的分组 ID（落点不在任何分组内则为 null → 建默认分组） */
  groupId: string | null;
}

/** 判定右键是否落在任务项上（任务项有自己的右键菜单，面板菜单不重复弹出） */
function isOnTaskItem(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return !!el.closest(".task-item");
}

/**
 * 任务主面板右键菜单
 * @param resolveListId 返回新建条目归属的清单/笔记本 ID（各视图自行决定）
 * @param kind 新建条目类型：'task'（默认）或 'note'（笔记本视图用）
 * @param resolveGroupId 由右键事件落点判定所属分组的函数（仅 ListView 分组视图需要）；
 *   不传则新建任务一律落默认分组（后端兜底），SmartView/TagView 行为不变
 */
export function useTaskPanelContextMenu(
  resolveListId: () => string,
  kind: TaskKind = "task",
  resolveGroupId?: (e: MouseEvent) => string | null,
) {
  const taskStore = useTaskStore();
  const ctxMenu = reactive<CtxMenuState>({ visible: false, x: 0, y: 0, groupId: null });

  /** 面板根元素的 @contextmenu 处理：放行输入框/任务项，否则弹出自定义菜单 */
  function onContextMenu(e: MouseEvent): void {
    if (shouldReserveNativeMenu(e.target)) return;
    if (isOnTaskItem(e.target)) return;
    e.preventDefault();
    ctxMenu.x = e.clientX;
    ctxMenu.y = e.clientY;
    // 就近分组判定：右键落在某分组容器内 → 新建任务进该组；否则 null（默认组）
    ctxMenu.groupId = resolveGroupId ? resolveGroupId(e) : null;
    ctxMenu.visible = true;
  }

  /** 「新建」菜单项：创建主条目（parentId=null），空标题 + 选中打开详情面板。
   *  kind='note' 时创建笔记（笔记本视图）。groupId 透传实现就近进指定分组。 */
  async function onCreateTask(): Promise<void> {
    ctxMenu.visible = false;
    const created = await taskStore.createTask({
      title: "",
      listId: resolveListId(),
      parentId: null,
      kind,
      groupId: ctxMenu.groupId ?? undefined,
    });
    taskStore.selectTask(created.id);
  }

  return {
    ctxMenu,
    onContextMenu,
    onCreateTask,
  };
}
