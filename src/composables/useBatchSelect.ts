// 批量多选组合式钩子 —— 统一管理任务多选的事件转发与批量右键菜单状态
// 三个任务视图（ListView/SmartView/TagView）共用，避免重复逻辑（DRY）。
//
// 职责：
// 1. 提供 onTaskRowSelect(taskId, e)：根据修饰键决定走多选还是单选
// 2. 提供 batchCtxMenu：批量右键菜单的 visible/x/y 状态
// 3. 提供 onBatchContextMenu(e)：多选模式下右键任务的容器级处理
//
// 用法：
//   const { onTaskRowSelect, batchCtxMenu, onBatchContextMenu } = useBatchSelect();
//   <TaskListItem @select="(e) => onTaskRowSelect(task.id, e)" />
//   <div @contextmenu="onBatchContextMenu">  <!-- 容器级，捕获冒泡的右键 -->

import { reactive } from "vue";
import { useTaskStore } from "@/stores/task";

/** 批量右键菜单状态 */
export interface BatchCtxMenu {
  visible: boolean;
  x: number;
  y: number;
}

export function useBatchSelect() {
  const taskStore = useTaskStore();

  /** 批量右键菜单状态（由视图传给 BatchContextMenu 组件） */
  const batchCtxMenu = reactive<BatchCtxMenu>({
    visible: false,
    x: 0,
    y: 0,
  });

  /** 任务行点击转发：根据修饰键决定走多选还是单选。
   *  - Shift → 范围选（从锚点到当前任务）
   *  - Cmd/Ctrl → 单点增减选
   *  - 多选模式下普通点击 → 增减选
   *  - 非多选模式普通点击 → 单选（打开详情面板） */
  function onTaskRowSelect(taskId: string, e: MouseEvent): void {
    if (e.shiftKey) {
      taskStore.rangeBatchSelect(taskId);
    } else if (e.metaKey || e.ctrlKey) {
      taskStore.toggleBatchSelect(taskId);
    } else if (taskStore.batchMode) {
      // 多选模式下普通点击 = 增减选
      taskStore.toggleBatchSelect(taskId);
    } else {
      taskStore.selectTask(taskId);
    }
  }

  /** 容器级右键处理：多选模式下，捕获从 TaskListItem 冒泡上来的 contextmenu，
   *  打开批量菜单。非多选模式不处理（TaskListItem 内部已 stopPropagation）。
   *  注意：TaskListItem 在「多选且本任务已选中」时不 stop，事件冒泡到这里。 */
  function onBatchContextMenu(e: MouseEvent): void {
    if (!taskStore.batchMode || taskStore.batchSelectedIdsArr.length === 0) {
      return;
    }
    e.preventDefault();
    batchCtxMenu.x = e.clientX;
    batchCtxMenu.y = e.clientY;
    batchCtxMenu.visible = true;
  }

  return {
    batchCtxMenu,
    onTaskRowSelect,
    onBatchContextMenu,
  };
}
