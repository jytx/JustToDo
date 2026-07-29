// 任务拖拽实时让位（FLIP 动画）—— 复用于 ListView / SmartView / TagView。
//
// 设计参考 TemplateSection.vue 的 grid 让位机制，适配为纵向列表：
// · dragstart 记录被拖任务 id
// · dragover 阶段实时调整 localOrder，TransitionGroup 做 FLIP 动画
// · dragend 时持久化最终顺序（WKWebView 的 drop 不可靠，以 dragend 为准）
// · 拖拽期间 store 数据若变化（如新建任务），通过 watch 同步 localOrder

import { ref, computed, watch } from "vue";
import type { Task } from "@/types";
import { useTaskStore } from "@/stores/task";

/**
 * 任务拖拽实时让位 composable。
 *
 * @param getOpenTasks 获取未完成任务的 getter（传 () => taskStore.openTasks）
 * @returns 拖拽状态 + 事件处理器 + 按本地顺序排序的任务列表
 */
export function useTaskDragReorder(getOpenTasks: () => Task[]) {
  const taskStore = useTaskStore();

  /** 本地实时顺序（id 数组，dragover 期间不断调整） */
  const localOrder = ref<string[]>([]);
  /** 正在被拖动的任务 id（dragstart 设置，dragend 清空） */
  const draggingId = ref<string | null>(null);
  /** 容器 DOM 引用（dragover 监听锚点） */
  const containerRef = ref<HTMLElement | null>(null);

  /** 本次拖拽期间 localOrder 是否真的变化过（用于 dragend 判断要不要持久化） */
  let orderChangedDuringDrag = false;

  /** store 数据变化时同步本地顺序（加载/新建/删除后） */
  watch(
    () => getOpenTasks().map((t) => t.id),
    (ids) => {
      localOrder.value = [...ids];
    },
    { immediate: true },
  );

  /** 按本地顺序从 store 取出任务对象（渲染用） */
  const orderedTasks = computed<Task[]>(() => {
    const source = getOpenTasks();
    const map = new Map(source.map((t) => [t.id, t]));
    return localOrder.value
      .map((id) => map.get(id))
      .filter((t): t is Task => t !== undefined);
  });

  /** dragstart：记录被拖任务 id */
  function onTaskDragStart(taskId: string): void {
    draggingId.value = taskId;
    orderChangedDuringDrag = false;
  }

  /**
   * 根据鼠标 Y 坐标计算 dragging 应该插入的目标 index（纵向列表版）。
   *
   * 遍历所有非 dragging 任务行，找到第一行「鼠标在其上半段」的行，
   * dragging 就插到它前面；如果鼠标在所有行的下半段，dragging 插到末尾。
   * 这个算法不依赖进入哪行的事件，鼠标在间隙/边缘也能识别。
   */
  function computeTargetIndex(clientY: number): number {
    if (!containerRef.value) return -1;
    const rows = Array.from(
      containerRef.value.querySelectorAll<HTMLElement>(".task-tree-node"),
    );
    // dragging 自己跳过
    const otherRows = rows.filter(
      (r) => r.getAttribute("data-task-id") !== draggingId.value,
    );
    for (let i = 0; i < otherRows.length; i++) {
      const rect = otherRows[i].getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      // 鼠标在该行上半段（含中心）→ 插到该行前面
      if (clientY <= centerY) {
        const id = otherRows[i].getAttribute("data-task-id")!;
        const withoutDragging = localOrder.value.filter(
          (x) => x !== draggingId.value,
        );
        return withoutDragging.indexOf(id);
      }
    }
    // 鼠标在所有行下面 → 插到末尾
    return localOrder.value.length - 1;
  }

  /** 容器级 dragover：实时调整 localOrder，触发 FLIP 让位动画 */
  function onContainerDragOver(e: DragEvent): void {
    if (!draggingId.value) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";

    const targetIdx = computeTargetIndex(e.clientY);
    if (targetIdx < 0) return;

    const withoutDragging = localOrder.value.filter(
      (id) => id !== draggingId.value,
    );
    const clampedIdx = Math.max(0, Math.min(targetIdx, withoutDragging.length));
    withoutDragging.splice(clampedIdx, 0, draggingId.value);

    // 仅当顺序真正变化时才赋值（避免无限 dragover 触发响应式更新）
    const changed = withoutDragging.some((id, i) => id !== localOrder.value[i]);
    if (changed) {
      localOrder.value = withoutDragging;
      orderChangedDuringDrag = true;
    }
  }

  /** 容器级 drop：preventDefault 即可（实际持久化由 dragend 兜底） */
  function onContainerDrop(e: DragEvent): void {
    if (!draggingId.value) return;
    e.preventDefault();
  }

  /**
   * dragend：拖拽真正结束的可靠钩子（drop 在某些 webview 不触发）。
   *
   * 策略（与 TemplateSection 一致）：
   * - 拖拽期间 localOrder 变化过 → 持久化最终顺序
   * - 完全没变化（拖出区域 / 没触发让位）→ 不做任何事
   */
  async function onTaskDragEnd(): Promise<void> {
    const finalOrder = [...localOrder.value];
    const draggingIdSnapshot = draggingId.value;
    draggingId.value = null;
    if (!orderChangedDuringDrag || !draggingIdSnapshot) {
      return;
    }
    const ok = await taskStore.persistTaskOrder(finalOrder);
    if (!ok) {
      // 持久化失败，回滚到 store 的顺序
      localOrder.value = getOpenTasks().map((t) => t.id);
    }
  }

  return {
    /** 容器 DOM ref（模板里绑定到包裹任务列表的外层 div） */
    containerRef,
    /** 正在被拖动的任务 id（可用于给源行加半透明样式） */
    draggingId,
    /** 按本地顺序排序的任务列表（渲染用，替代 taskStore.openTasks） */
    orderedTasks,
    /** dragstart 处理器（TaskListItem 的 @dragstart 调用） */
    onTaskDragStart,
    /** dragover 处理器（容器级，挂在外层 div） */
    onContainerDragOver,
    /** drop 处理器（容器级，挂在外层 div） */
    onContainerDrop,
    /** dragend 处理器（TaskListItem 的 @dragend 调用） */
    onTaskDragEnd,
  };
}
