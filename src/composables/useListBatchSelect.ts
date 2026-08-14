// 清单/笔记本批量多选组合式钩子 —— 统一管理清单/笔记本多选的事件转发与批量右键菜单状态
// 与 useBatchSelect（任务侧）同构，仅转发目标从 taskStore 换成 listStore。
//
// 职责：
// 1. flattenActiveTree：把 listTree/noteListTree 拍平成 DFS 序列（范围选/全选的数据源）
// 2. onListNodeClick(id, e)：根据修饰键决定走多选还是让位（返回 false = 未消费，调用方跳转）
// 3. onBatchContextMenu(e)：多选模式下右键的容器级处理（打开批量菜单）
//
// 用法：
//   const listBatch = useListBatchSelect(() => flattenActiveTree(listStore.listTree));
//   <SidebarListNode :on-node-click="listBatch.onListNodeClick" ... />
//   <div @contextmenu="listBatch.onBatchContextMenu">  <!-- 容器级，捕获冒泡的右键 -->

import { reactive } from "vue";
import { useListStore } from "@/stores/list";
import type { ListTreeNode } from "@/stores/list";

/** 批量右键菜单状态 */
export interface ListBatchCtxMenu {
  visible: boolean;
  x: number;
  y: number;
}

/** 把树拍平成 DFS 序列（纯函数：不修改入参，返回新数组）。
 *  tree DFS 顺序 = 用户在界面上看到的顺序（父 → 子），
 *  用于 Shift 范围选与 Cmd+A 全选的「可见节点序列」。 */
export function flattenActiveTree(nodes: ListTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (arr: ListTreeNode[]): void => {
    for (const n of arr) {
      out.push(n.id);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function useListBatchSelect(flatIds: () => string[]) {
  const listStore = useListStore();

  /** 批量右键菜单状态（由 TheSidebar 传给 ListBatchContextMenu 组件） */
  const batchCtxMenu = reactive<ListBatchCtxMenu>({
    visible: false,
    x: 0,
    y: 0,
  });

  /** 行点击转发：根据修饰键决定走多选还是让位。
   *  - Shift → 范围选（从锚点到当前节点）
   *  - Cmd/Ctrl → 单点增减选
   *  - 多选模式下普通点击 → 增减选
   *  - 非多选模式普通点击 → 返回 false（未消费，由 SidebarListNode 走路由跳转） */
  function onListNodeClick(id: string, e: MouseEvent): boolean {
    if (e.shiftKey) {
      listStore.rangeBatchSelect(flatIds(), id);
      return true;
    }
    if (e.metaKey || e.ctrlKey) {
      listStore.toggleBatchSelect(id);
      return true;
    }
    if (listStore.batchMode) {
      listStore.toggleBatchSelect(id);
      return true;
    }
    return false;
  }

  /** 容器级右键处理：多选模式下，捕获从 SidebarListNode 冒泡上来的 contextmenu，
   *  打开批量菜单。非多选模式不处理（SidebarListNode 内部已 stopPropagation）。 */
  function onBatchContextMenu(e: MouseEvent): void {
    if (!listStore.batchMode || listStore.batchSelectedIdsArr.length === 0) {
      return;
    }
    e.preventDefault();
    batchCtxMenu.x = e.clientX;
    batchCtxMenu.y = e.clientY;
    batchCtxMenu.visible = true;
  }

  return {
    batchCtxMenu,
    onListNodeClick,
    onBatchContextMenu,
  };
}
