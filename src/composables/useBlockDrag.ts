// 块拖拽状态机 —— 管理 idle / dragging 两态，绑定鼠标事件。
//
// idle：监听编辑器 mousemove，hover 到顶层块时计算手柄应出现的位置
// dragging：手柄 mousedown 后，监听 document mousemove/mouseup，
//           实时更新落点横线，mouseup 时 dispatch 移动事务。
//
// 与 blockDrag.ts（纯函数）配合：状态机负责"何时调"，纯函数负责"怎么算"。

import { ref, watch, onBeforeUnmount, type Ref } from "vue";
import type { Editor } from "@tiptap/vue-3";
import {
  findDropTarget,
  buildMoveTransaction,
  posOfTopChild,
  type DropTarget,
} from "@/utils/blockDrag";

/** 手柄在屏幕上的定位（absolute 坐标系，相对 editor wrapper 容器） */
export interface HandlePosition {
  left: number;
  top: number;
  visible: boolean;
}

/** 落点横线的定位（absolute 坐标系，相对 editor wrapper 容器） */
export interface IndicatorPosition {
  left: number;
  top: number;
  width: number;
  visible: boolean;
}

/** 手柄距 wrapper 左边缘的内边距（px），手柄左缘 = wrapper 左 + 此值 */
const HANDLE_PADDING = 4;
/** 手柄高度（px），用于在块内垂直居中定位 */
const HANDLE_HEIGHT = 22;

/**
 * 块拖拽组合式函数。
 * @param editor Tiptap editor 的 ref（useEditor 返回值）
 * @returns 响应式的手柄位置、横线位置、拖拽状态，供 UI 组件渲染
 */
export function useBlockDrag(editor: Ref<Editor | undefined>) {
  /** 手柄当前位置（idle 态跟随 hover 块；dragging 态跟随鼠标） */
  const handlePos = ref<HandlePosition>({ left: 0, top: 0, visible: false });
  /** 落点横线位置（仅 dragging 态可见） */
  const indicatorPos = ref<IndicatorPosition>({
    left: 0,
    top: 0,
    width: 0,
    visible: false,
  });
  /** 是否处于拖拽中（UI 据此切换 cursor / 手柄样式） */
  const isDragging = ref(false);

  // 拖拽过程中的内部状态（非响应式，避免无谓渲染）
  let dragFromIndex = -1;
  let currentTarget: DropTarget | null = null;

  /** 当前 hover 到的顶层块索引（idle 态用） */
  let hoverIndex = -1;
  /** 鼠标是否正在手柄上（抑制隐藏） */
  let isHoveringHandle = false;
  /** 延迟隐藏手柄的定时器（mouseleave 后给鼠标留出移到手柄的时间） */
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  /** 清除待执行的隐藏定时器 */
  function clearHideTimer(): void {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }
  /** 立即隐藏手柄（拖拽中除外） */
  function hideHandle(): void {
    clearHideTimer();
    if (isDragging.value || isHoveringHandle) return;
    handlePos.value.visible = false;
  }
  /** 延迟隐藏手柄：给鼠标留出从编辑区移到手柄的时间 */
  function scheduleHide(): void {
    clearHideTimer();
    hideTimer = setTimeout(hideHandle, 150);
  }

  /**
   * 根据鼠标坐标更新手柄位置（idle 态：定位到 hover 块的左侧）。
   * 手柄使用 absolute 定位，坐标相对 editor wrapper（而非视口），
   * 这样手柄就在 editor DOM 内，鼠标从 editor 移到手柄不会触发 mouseleave。
   */
  function updateHandleOnHover(view: Editor["view"], clientX: number, clientY: number): void {
    const doc = view.state.doc;
    const coords = view.posAtCoords({ left: clientX, top: clientY });
    if (!coords) {
      handlePos.value.visible = false;
      return;
    }
    const $pos = doc.resolve(coords.pos);
    // 无论 depth 是 0（缝隙）还是 >=1（块内），index(0) 都给出顶层块索引
    const idx = $pos.index(0);
    if (idx < 0 || idx >= doc.childCount) {
      handlePos.value.visible = false;
      return;
    }
    hoverIndex = idx;
    const blockStart = posOfTopChild(doc, idx);
    const dom = view.nodeDOM(blockStart);
    if (!(dom instanceof HTMLElement)) {
      handlePos.value.visible = false;
      return;
    }
    const blockRect = dom.getBoundingClientRect();
    // 用 view DOM（editor 容器）作为定位基准；手柄和内容共享同一坐标系。
    // 手柄固定在 wrapper 左缘 + 4px（绝对定位），垂直跟随 hover 块居中。
    const wrapperRect = view.dom.getBoundingClientRect();
    handlePos.value = {
      left: HANDLE_PADDING,
      top: blockRect.top - wrapperRect.top + (blockRect.height - HANDLE_HEIGHT) / 2,
      visible: true,
    };
  }

  /**
   * 编辑器 mousemove（idle 态）：算手柄位置。移动即取消待隐藏。
   */
  function onEditorMouseMove(e: MouseEvent): void {
    if (isDragging.value) return;
    const ed = editor.value;
    if (!ed) return;
    clearHideTimer();
    updateHandleOnHover(ed.view, e.clientX, e.clientY);
  }

  /** 编辑器 mouseleave：延迟隐藏手柄。
   *  用延迟而非立即：手柄 teleport 到 body、不在编辑器 DOM 内，鼠标从编辑区
   *  移到手柄必然经过编辑器边界触发 mouseleave，立即隐藏会导致手柄一碰就消失、
   *  无法按下。延迟 150ms 给鼠标留出移到手柄的时间；若 150ms 内手柄被
   *  mouseenter 则取消隐藏。 */
  function onEditorMouseLeave(): void {
    if (isDragging.value) return;
    scheduleHide();
  }

  /** 手柄 mouseenter：取消隐藏、标记鼠标在手柄上（抑制隐藏） */
  function onHandleMouseEnter(): void {
    isHoveringHandle = true;
    clearHideTimer();
  }
  /** 手柄 mouseleave：鼠标离开手柄，延迟隐藏 */
  function onHandleMouseLeave(): void {
    isHoveringHandle = false;
    scheduleHide();
  }

  /**
   * 手柄 mousedown：进入 dragging 态。
   * @param e 手柄上的 mousedown 事件
   */
  function onHandleMouseDown(e: MouseEvent): void {
    const ed = editor.value;
    if (!ed || hoverIndex < 0) return;
    e.preventDefault();

    dragFromIndex = hoverIndex;
    isDragging.value = true;
    currentTarget = null;

    // mousedown 时立刻把手柄重置到 idle 态位置（hover 块所在行居中），
    // 避免上一次 dragging 末尾鼠标 Y 偏出导致手柄从"野位置"开始。
    // dragging 态下 X 锁在 HANDLE_PADDING、Y 跟鼠标；Y 会在第一次 mousemove
    // 立即被 followMouse 覆盖到鼠标位置，所以这里设的 Y 是"瞬态过渡值"，
    // 视觉上几乎看不到（一个 frame 内就被覆盖）。
    resetHandleToHoverBlock(ed.view);

    // 锁定全局面板 cursor + 防文字选中，并在 document 上监听 move/up
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onDragMouseMove);
    document.addEventListener("mouseup", onDragMouseUp);
  }

  /**
   * 把 handlePos 复位到 idle 态（hover 块所在行居中）。
   * 提取出来供 mousedown（开始拖拽前重置）和 mouseup 后的下一次 idle 用。
   */
  function resetHandleToHoverBlock(view: Editor["view"]): void {
    const doc = view.state.doc;
    if (hoverIndex < 0 || hoverIndex >= doc.childCount) {
      handlePos.value.visible = false;
      return;
    }
    const blockStart = posOfTopChild(doc, hoverIndex);
    const dom = view.nodeDOM(blockStart);
    if (!(dom instanceof HTMLElement)) {
      handlePos.value.visible = false;
      return;
    }
    const blockRect = dom.getBoundingClientRect();
    const wrapperRect = view.dom.getBoundingClientRect();
    const rawTop = blockRect.top - wrapperRect.top + (blockRect.height - HANDLE_HEIGHT) / 2;
    // 钳制在 wrapper 合法范围内（极端情况：hover 在 wrapper 顶部最后一行）
    const maxHandleTop = Math.max(0, wrapperRect.height - HANDLE_HEIGHT);
    const top = Math.max(0, Math.min(rawTop, maxHandleTop));
    handlePos.value = {
      left: HANDLE_PADDING,
      top,
      visible: true,
    };
  }

  /**
   * dragging 态 document mousemove：更新落点横线 + 手柄跟随鼠标。
   */
  function onDragMouseMove(e: MouseEvent): void {
    const ed = editor.value;
    if (!ed) return;
    updateDragState(ed.view, e.clientX, e.clientY);
  }

  /**
   * 手柄跟随鼠标（拖拽态用）。
   * X 锁在原列（idle 态位置 HANDLE_PADDING），仅 Y 跟鼠标走——
   * 拖拽时手柄只在源块那一列上下滑动，视觉上"原地拖动"，
   * 不会因鼠标水平抖动而满世界跑（Notion 风格）。
   * @param handleTop 手柄 top 的绝对值（相对 wrapper 顶），调用方已钳制在合理范围
   */
  function followMouse(handleTop: number): void {
    handlePos.value = {
      left: HANDLE_PADDING,
      top: handleTop,
      visible: true,
    };
  }

  /**
   * 更新拖拽中的落点横线和手柄位置。
   */
  function updateDragState(view: Editor["view"], clientX: number, clientY: number): void {
    const target = findDropTarget(view, clientX, clientY);
    currentTarget = target;
    const wrapperRect = view.dom.getBoundingClientRect();
    // 钳制手柄 top 在 wrapper 内容区内。手柄 top 的合法范围是
    // [0, wrapper.height - HANDLE_HEIGHT]：底部不能超过 wrapper 底。
    // 鼠标拖到 wrapper 外（document 监听）就让手柄停在边界。
    const maxHandleTop = Math.max(0, wrapperRect.height - HANDLE_HEIGHT);
    const rawRelY = clientY - wrapperRect.top;
    // 让鼠标"拖动手柄中心"对齐视觉：手柄 top = 鼠标 - 半高
    const handleTop = Math.max(0, Math.min(rawRelY - HANDLE_HEIGHT / 2, maxHandleTop));
    if (!target) {
      indicatorPos.value.visible = false;
      followMouse(handleTop);
      return;
    }

    // 算横线位置：插到 target 块前面 → 横线在该块上沿；后面 → 下沿
    const doc = view.state.doc;
    const safeIdx = Math.min(target.blockIndex, doc.childCount - 1);
    const blockStart = posOfTopChild(doc, safeIdx);
    const dom = view.nodeDOM(blockStart);
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect();
      const lineY = target.insertBefore ? rect.top : rect.bottom;
      indicatorPos.value = {
        // 横线对齐 wrapper 内的内容区（24px 左 padding 是给手柄的，横线跳过 padding 紧贴内容）
        left: 24,
        top: lineY - wrapperRect.top - 1,
        width: wrapperRect.width - 24,
        visible: true,
      };
    }

    followMouse(handleTop);
  }
  function onDragMouseUp(): void {
    const ed = editor.value;
    // 先快照源/目标，cleanupDrag() 会重置它们
    const fromIdx = dragFromIndex;
    const target = currentTarget;

    cleanupDrag();

    if (!ed || fromIdx < 0 || !target) return;

    // 判断目标是否等于源的当前位置（无效移动，跳过避免无意义事务）。
    // 块 i 的"自身位置"等价于四种 target 表达：
    //   - 插到 i 前面：            blockIndex===i && insertBefore
    //   - 插到 i 后面：            blockIndex===i && !insertBefore
    //   - 插到 i+1 前面(=i 后面)： blockIndex===i+1 && insertBefore
    //   - 插到 i-1 后面(=i 前面)： blockIndex===i-1 && !insertBefore
    const t = target;
    const i = fromIdx;
    const isNoOp =
      (t.blockIndex === i) ||
      (t.blockIndex === i + 1 && t.insertBefore) ||
      (t.blockIndex === i - 1 && !t.insertBefore);
    if (isNoOp) return;

    const tr = buildMoveTransaction(ed.state, fromIdx, target);
    ed.view.dispatch(tr);
  }

  /** 清理拖拽态：移除监听、重置 cursor、隐藏横线 */
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

  // 绑定/解绑编辑器事件（editor ref 变化时重新绑定）
  let boundDom: HTMLElement | null = null;
  function bindEditor(ed: Editor | undefined): void {
    unbindEditor();
    if (!ed) return;
    boundDom = ed.view.dom;
    boundDom.addEventListener("mousemove", onEditorMouseMove);
    boundDom.addEventListener("mouseleave", onEditorMouseLeave);
  }
  function unbindEditor(): void {
    if (boundDom) {
      boundDom.removeEventListener("mousemove", onEditorMouseMove);
      boundDom.removeEventListener("mouseleave", onEditorMouseLeave);
      boundDom = null;
    }
  }

  watch(editor, (ed) => bindEditor(ed), { immediate: true });
  onBeforeUnmount(() => {
    unbindEditor();
    cleanupDrag();
  });

  return {
    handlePos,
    indicatorPos,
    isDragging,
    /** 手柄 mousedown 处理器（BlockDragHandle 绑定到手柄元素） */
    onHandleMouseDown,
    /** 手柄 mouseenter/mouseleave（维持手柄显示，避免移上去就消失） */
    onHandleMouseEnter,
    onHandleMouseLeave,
  };
}
