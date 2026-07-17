// 通用列表拖拽状态机 —— 不依赖 Tiptap，适用于任意"扁平可拖列表"。
//
// 工作原理：
// idle：监听 containerRef 的 mousemove，根据 hover 行实时定位 ⋮⋮ 手柄
// dragging：手柄 mousedown 后，监听 document mousemove 找落点，
//           计算鼠标应该在哪个 item 之前/之后插入；
//           mouseup 时调 onMove(fromIdx, toIdx) 回调。
//
// 与 BlockDragHandle（tiptap-special）的区别：
// - 用 querySelectorAll + getBoundingClientRect 找 row（不再走 PM posAtCoords）
// - 坐标相对 container，不 teleport
// - 落点只用顶层 row，不处理嵌套

import { ref, watch, onBeforeUnmount, type Ref } from "vue";

/** 手柄位置（相对 containerRef 的 absolute 坐标） */
export interface HandlePosition {
  left: number;
  top: number;
  visible: boolean;
}

/** 落点横线位置（相对 containerRef 的 absolute 坐标） */
export interface IndicatorPosition {
  left: number;
  top: number;
  width: number;
  visible: boolean;
}

/** 手柄距 container 左缘的内边距（px） */
const HANDLE_PADDING = 4;
/** 手柄高度（px） */
const HANDLE_HEIGHT = 22;

export interface UseListDragOptions {
  /** 可拖容器的 ref（含若干 itemSelector 命中的 DOM 子元素） */
  containerRef: Ref<HTMLElement | null>;
  /** 拖拽项选择器（CSS 选择器），如 ".detail-panel__checklist-item" */
  itemSelector: string;
  /** 拖拽结束时回调；toIndex 是不含源项的新索引位置
   *  （drop 在 item K 之前 → toIndex = K；drop 在最后 → toIndex = items.length-1） */
  onMove: (fromIndex: number, toIndex: number) => void | Promise<void>;
  /** 可选：手柄距离项左缘的偏移（默认 4px） */
  handlePaddingLeft?: number;
}

/**
 * 通用列表拖拽组合式函数。
 * @param options containerRef / itemSelector / onMove
 */
export function useListDrag(options: UseListDragOptions) {
  const { containerRef, itemSelector, onMove } = options;
  const handlePaddingLeft = options.handlePaddingLeft ?? HANDLE_PADDING;

  /** 手柄位置（相对 container absolute 坐标） */
  const handlePos = ref<HandlePosition>({ left: 0, top: 0, visible: false });
  /** 落点横线位置 */
  const indicatorPos = ref<IndicatorPosition>({
    left: 0,
    top: 0,
    width: 0,
    visible: false,
  });
  /** 是否处于拖拽态（UI 切换 cursor / 样式） */
  const isDragging = ref(false);

  /* === 内部状态（非响应式） === */
  /** 拖拽起点所在的 item 索引 */
  let dragFromIndex = -1;
  /** 当前落点：item 索引 + 是否插到它前面（true）还是后面（false） */
  let currentTarget: { itemIndex: number; insertBefore: boolean } | null = null;

  /** 当前 hover 的 item 索引（idle 态定位手柄用） */
  let hoverIndex = -1;
  /** 鼠标是否在手柄上（防止一碰就消失） */
  let isHoveringHandle = false;
  /** 延迟隐藏手柄的定时器 */
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHideTimer(): void {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }
  function hideHandle(): void {
    clearHideTimer();
    if (isDragging.value || isHoveringHandle) return;
    handlePos.value.visible = false;
  }
  function scheduleHide(): void {
    clearHideTimer();
    hideTimer = setTimeout(hideHandle, 150);
  }

  /** 取当前所有 item（DOM 顺序） */
  function getItems(): HTMLElement[] {
    const c = containerRef.value;
    if (!c) return [];
    return Array.from(c.querySelectorAll<HTMLElement>(itemSelector));
  }

  /** 把 container 内坐标转为 viewport 坐标后定位最近 item（snap by y） */
  function findItemByClientY(clientY: number): number {
    const items = getItems();
    if (!items.length) return -1;
    let best = -1;
    let bestDist = Infinity;
    const containerRect = containerRef.value!.getBoundingClientRect();
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      const itemMid = r.top + r.height / 2;
      const dist = Math.abs(clientY - itemMid);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    // 若 hover 容器外但在容器底部下方（光标在最后一项之下），snap 到最后
    if (best < 0) return -1;
    // 额外：若鼠标在容器边缘之外（容器底部下方）也允许取最后一项
    if (clientY > containerRect.bottom && best !== items.length - 1) {
      best = items.length - 1;
    }
    return best;
  }

  /** idle 态：根据 hover item 更新手柄位置（手柄垂直居中于 item 内） */
  function updateHandleOnHover(clientY: number): void {
    const c = containerRef.value;
    if (!c) {
      handlePos.value.visible = false;
      return;
    }
    const idx = findItemByClientY(clientY);
    if (idx < 0) {
      handlePos.value.visible = false;
      return;
    }
    hoverIndex = idx;
    const items = getItems();
    const rect = items[idx].getBoundingClientRect();
    const wrapperRect = c.getBoundingClientRect();
    handlePos.value = {
      left: handlePaddingLeft,
      top: rect.top - wrapperRect.top + (rect.height - HANDLE_HEIGHT) / 2,
      visible: true,
    };
  }

  function onContainerMouseMove(e: MouseEvent): void {
    if (isDragging.value) return;
    clearHideTimer();
    updateHandleOnHover(e.clientY);
  }

  function onContainerMouseLeave(): void {
    if (isDragging.value) return;
    scheduleHide();
  }

  function onHandleMouseEnter(): void {
    isHoveringHandle = true;
    clearHideTimer();
  }
  function onHandleMouseLeave(): void {
    isHoveringHandle = false;
    scheduleHide();
  }

  /** dragging 态：根据鼠标位置决定落点（item + 上/下半区） */
  function findDropTarget(clientY: number): { itemIndex: number; insertBefore: boolean } | null {
    const items = getItems();
    if (!items.length) return null;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        const mid = r.top + r.height / 2;
        return { itemIndex: i, insertBefore: clientY < mid };
      }
    }
    // 鼠标在所有 item 下方 → 放到末尾
    const lastRect = items[items.length - 1].getBoundingClientRect();
    if (clientY > lastRect.bottom) {
      return { itemIndex: items.length - 1, insertBefore: false };
    }
    // 鼠标在所有 item 上方 → 放到最前
    const firstRect = items[0].getBoundingClientRect();
    if (clientY < firstRect.top) {
      return { itemIndex: 0, insertBefore: true };
    }
    return null;
  }

  /** 落点转"toIndex"（不含源项） */
  function toIndex(target: { itemIndex: number; insertBefore: boolean }, fromIdx: number): number {
    let to = target.itemIndex;
    if (!target.insertBefore) to += 1;
    // 拖到源项之后时不偏移；拖到源项之前时 fromIdx > to，去掉 1
    if (fromIdx < to) to -= 1;
    return to;
  }

  function followMouse(handleTop: number): void {
    handlePos.value = {
      left: handlePaddingLeft,
      top: handleTop,
      visible: true,
    };
  }

  function resetHandleToHoverItem(): void {
    const c = containerRef.value;
    if (!c) {
      handlePos.value.visible = false;
      return;
    }
    const items = getItems();
    if (hoverIndex < 0 || hoverIndex >= items.length) {
      handlePos.value.visible = false;
      return;
    }
    const rect = items[hoverIndex].getBoundingClientRect();
    const wrapperRect = c.getBoundingClientRect();
    const maxHandleTop = Math.max(0, wrapperRect.height - HANDLE_HEIGHT);
    const rawTop = rect.top - wrapperRect.top + (rect.height - HANDLE_HEIGHT) / 2;
    const top = Math.max(0, Math.min(rawTop, maxHandleTop));
    handlePos.value = { left: handlePaddingLeft, top, visible: true };
  }

  /** 手柄 mousedown：进入 dragging 态 */
  function onHandleMouseDown(e: MouseEvent): void {
    if (hoverIndex < 0) return;
    e.preventDefault();
    dragFromIndex = hoverIndex;
    isDragging.value = true;
    currentTarget = null;
    resetHandleToHoverItem();

    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onDragMouseMove);
    document.addEventListener("mouseup", onDragMouseUp);
  }

  function onDragMouseMove(e: MouseEvent): void {
    const c = containerRef.value;
    if (!c) return;
    const target = findDropTarget(e.clientY);
    currentTarget = target;

    const wrapperRect = c.getBoundingClientRect();
    const maxHandleTop = Math.max(0, wrapperRect.height - HANDLE_HEIGHT);
    const rawRelY = e.clientY - wrapperRect.top;
    const handleTop = Math.max(0, Math.min(rawRelY - HANDLE_HEIGHT / 2, maxHandleTop));

    if (!target) {
      indicatorPos.value.visible = false;
      followMouse(handleTop);
      return;
    }

    const items = getItems();
    const safeIdx = Math.min(target.itemIndex, items.length - 1);
    const rect = items[safeIdx].getBoundingClientRect();
    const lineY = target.insertBefore ? rect.top : rect.bottom;
    indicatorPos.value = {
      // 容器内可见位置即可；若容器有 padding 可改成更准的算法
      left: 0,
      top: lineY - wrapperRect.top - 1,
      width: wrapperRect.width,
      visible: true,
    };

    followMouse(handleTop);
  }

  function cleanupDrag(): void {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onDragMouseMove);
    document.removeEventListener("mouseup", onDragMouseUp);
    isDragging.value = false;
    indicatorPos.value.visible = false;
    dragFromIndex = -1;
    currentTarget = null;
    isHoveringHandle = false;
    clearHideTimer();
  }

  function onDragMouseUp(): void {
    const fromIdx = dragFromIndex;
    const target = currentTarget;
    cleanupDrag();
    if (fromIdx < 0 || !target) return;
    const to = toIndex(target, fromIdx);
    if (to === fromIdx) return; // 无效移动
    void onMove(fromIdx, to);
  }

  let boundDom: HTMLElement | null = null;
  function bindContainer(dom: HTMLElement | null): void {
    if (boundDom) {
      boundDom.removeEventListener("mousemove", onContainerMouseMove);
      boundDom.removeEventListener("mouseleave", onContainerMouseLeave);
      boundDom = null;
    }
    if (dom) {
      boundDom = dom;
      boundDom.addEventListener("mousemove", onContainerMouseMove);
      boundDom.addEventListener("mouseleave", onContainerMouseLeave);
    }
  }
  watch(containerRef, (el) => bindContainer(el), { immediate: true });

  onBeforeUnmount(() => {
    bindContainer(null);
    cleanupDrag();
  });

  return {
    handlePos,
    indicatorPos,
    isDragging,
    onHandleMouseDown,
    onHandleMouseEnter,
    onHandleMouseLeave,
  };
}
