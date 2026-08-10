// 任务项内标签拖拽排序 composable —— 拖动任务项上的标签 chip，调整该任务内标签的显示顺序。
//
// 设计对齐任务拖拽（useTaskDragReorder）：容器级 dragover + 鼠标坐标实时让位，
// 配合 TransitionGroup 的 FLIP 动画，拖动过程中其他标签平滑让位（不是松手才跳位）。
// 与任务行拖拽（TaskListItem 的 onDragStart 等，用 text/plain）、侧边栏标签拖拽
// （TheSidebar，用 text/plain）完全隔离：
// - 本 composable 用自定义 MIME「application/x-task-tag-reorder」标记拖拽类型；
//   任务行拖拽和侧边栏标签拖拽都不写这个 MIME，三方互不干扰。
// - 所有拖拽事件处理器内 stopPropagation，阻断冒泡到外层 .task-item 的任务行
//   drag handler（避免触发任务重排 / FLIP 让位 / 覆写 text/plain）。
//
// 与任务拖拽（纵向单列）的区别：标签 chip 是横向排列（flex-wrap 可换行），
// 落点判定用「鼠标 X 与 chip 中心比较」（横向版 computeTargetIndex），
// 并按鼠标 Y 先锁定所在行，避免换行时跨行误判。
//
// 持久化调 taskStore.reorderTaskTags（乐观更新 taskTagMap + 调 task_reorder_tags 命令），
// 后端按 i*1000 全量重写 task_tags.sort_order。

import { ref, watch, type Ref } from "vue";
import type { Tag } from "@/api/db";
import { useTaskStore } from "@/stores/task";

/** 标签拖拽专用的 dataTransfer MIME，与任务拖拽（text/plain）区分 */
export const TASK_TAG_REORDER_MIME = "application/x-task-tag-reorder";

/**
 * 任务项内标签拖拽排序
 *
 * @param getTaskId 获取当前任务 id 的 getter（持久化时用；用 getter 而非固定字符串，
 *                  支持详情面板切换任务后仍持久化到正确的 task）
 * @param sourceTags 响应式的外部标签数据源（来自 taskStore.taskTagMap[taskId]）
 * @returns 本地有序标签数组 + 拖拽状态 + 容器级事件处理器
 */
export function useTaskTagReorder(getTaskId: () => string, sourceTags: Ref<Tag[]>) {
  const taskStore = useTaskStore();

  /** 本地有序标签数组（拖拽中实时调整，驱动渲染） */
  const localTags = ref<Tag[]>([...sourceTags.value]);

  /** 正在被拖动的标签 id */
  const draggingTagId = ref<string | null>(null);

  /** 标签容器 DOM 引用（容器级 dragover/drop 监听锚点，坐标计算用） */
  const containerRef = ref<HTMLElement | null>(null);

  /** 拖拽进行中（禁止外部 watch 覆盖本地中间态） */
  let isDragging = false;
  /** 持久化防重入 */
  let persisting = false;
  /** 本次拖拽是否有变化 */
  let dragChanged = false;

  /** 同步外部数据到 localTags（非拖拽期间由 watch 自动调用） */
  function syncFromStore(tags: Tag[]): void {
    if (isDragging) return;
    localTags.value = [...tags];
  }

  // 外部数据变化时同步（如增删标签、切换任务后 store 刷新）
  watch(
    sourceTags,
    (tags) => syncFromStore(tags),
    { deep: true },
  );

  /** 判定 dataTransfer 是否为标签拖拽（区分任务拖拽 / 侧边栏标签拖拽） */
  function isTagDrag(e: DragEvent): boolean {
    // 优先认自定义 MIME；部分 WKWebView 读自定义 MIME 不可靠时，
    // 用 draggingTagId 兜底（任务拖拽不会设本 composable 的 draggingTagId）
    return e.dataTransfer?.types.includes(TASK_TAG_REORDER_MIME) || draggingTagId.value !== null;
  }

  /** chip dragstart：写自定义 MIME + 记录源 + stopPropagation 阻断任务行 dragstart */
  function onTagDragStart(e: DragEvent, tagId: string): void {
    e.stopPropagation(); // 阻止冒泡到 .task-item 的 onDragStart（否则会覆写 text/plain 为 task id）
    draggingTagId.value = tagId;
    isDragging = true;
    dragChanged = false;
    e.dataTransfer!.setData(TASK_TAG_REORDER_MIME, tagId);
    // 同时写 text/plain 兜底（部分环境对自定义 MIME 兼容性差），但任务行/侧边栏
    // 的 drop handler 不读这个 MIME，且本 composable 的 handler 已 stopPropagation，
    // 所以不会被它们误处理。
    e.dataTransfer!.setData("text/plain", tagId);
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.dropEffect = "move";
  }

  /**
   * 根据鼠标坐标计算 dragging 应该插入的目标 index（横向 wrap 版）。
   *
   * 1. 先按鼠标 Y 锁定所在行（Y 在 chip 垂直范围内的 chip 集合）；
   *    鼠标在行间隙时兜底用全部 chip。
   * 2. 在该行内按 X 比较：找到第一个「鼠标在其左半段」的 chip，
   *    dragging 插到它前面；鼠标在所有 chip 右半段则插到末尾。
   * 3. dragging 自己跳过。
   */
  function computeTargetIndex(clientX: number, clientY: number): number {
    if (!containerRef.value) return -1;
    const chips = Array.from(
      containerRef.value.querySelectorAll<HTMLElement>("[data-tag-id]"),
    );
    const otherChips = chips.filter(
      (c) => c.getAttribute("data-tag-id") !== draggingTagId.value,
    );
    if (otherChips.length === 0) return -1;

    // 鼠标所在行：Y 落在 chip 垂直范围内的集合
    const rowChips = otherChips.filter((c) => {
      const r = c.getBoundingClientRect();
      return clientY >= r.top && clientY <= r.bottom;
    });
    const candidates = rowChips.length > 0 ? rowChips : otherChips;

    for (let i = 0; i < candidates.length; i++) {
      const rect = candidates[i].getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      // 鼠标在该 chip 左半段（含中心）→ 插到该 chip 前面
      if (clientX <= centerX) {
        const id = candidates[i].getAttribute("data-tag-id")!;
        const withoutDragging = localTags.value.filter(
          (t) => t.id !== draggingTagId.value,
        );
        return withoutDragging.findIndex((t) => t.id === id);
      }
    }
    // 鼠标在所有 chip 右侧 → 插到末尾
    return localTags.value.length - 1;
  }

  /** 容器级 dragover：实时重排 localTags，触发 FLIP 让位动画（不等到 drop） */
  function onContainerDragOver(e: DragEvent): void {
    if (!isTagDrag(e)) return; // 任务拖拽：不干预（放行给外层）
    e.preventDefault(); // 允许 drop
    e.stopPropagation(); // 阻断任务行 onDragOver（否则会显示任务重排高亮 + FLIP 让位）
    e.dataTransfer!.dropEffect = "move";

    const draggedId = draggingTagId.value;
    if (!draggedId) return; // 未识别拖拽源

    const targetIdx = computeTargetIndex(e.clientX, e.clientY);
    if (targetIdx < 0) return;

    const withoutDragging = localTags.value.filter((t) => t.id !== draggedId);
    const clampedIdx = Math.max(0, Math.min(targetIdx, withoutDragging.length));
    const draggedTag = localTags.value.find((t) => t.id === draggedId);
    if (!draggedTag) return;
    withoutDragging.splice(clampedIdx, 0, draggedTag);

    // 仅当顺序真正变化时才赋值（避免无限 dragover 触发响应式更新）
    const changed = withoutDragging.some((t, i) => t.id !== localTags.value[i]?.id);
    if (changed) {
      localTags.value = withoutDragging;
      dragChanged = true;
      scheduleAutoPersist();
    }
  }

  /** 容器级 drop：dragover 已实时重排，这里直接持久化 */
  function onContainerDrop(e: DragEvent): void {
    if (!isTagDrag(e)) return; // 任务拖拽：放行给外层
    e.preventDefault();
    e.stopPropagation(); // 阻断任务行 onDrop（否则会误触发任务重排）
    void persist();
  }

  /** autoPersist 计时器（dragover 停止 500ms 后兜底持久化，WKWebView drop/dragend 不可靠） */
  let autoPersistTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutoPersist(): void {
    if (autoPersistTimer) clearTimeout(autoPersistTimer);
    autoPersistTimer = setTimeout(() => {
      autoPersistTimer = null;
      if (dragChanged) void persist();
    }, 500);
  }

  /** 持久化：把本地顺序整体提交给 store（乐观更新 + 后端 i*1000 重写） */
  async function persist(): Promise<void> {
    if (persisting) return;
    if (!dragChanged) {
      clearDragState();
      return;
    }
    persisting = true;
    try {
      const orderedIds = localTags.value.map((t) => t.id);
      await taskStore.reorderTaskTags(getTaskId(), orderedIds);
    } finally {
      dragChanged = false;
      persisting = false;
      clearDragState();
    }
  }

  /** 清理拖拽状态 */
  function clearDragState(): void {
    isDragging = false;
    draggingTagId.value = null;
  }

  /** chip dragend：清状态 + 兜底持久化 */
  function onTagDragEnd(e: DragEvent): void {
    e.stopPropagation(); // 阻断任务行 onDragEnd
    if (dragChanged) void persist();
    else clearDragState();
  }

  /** 容器 DOM 设置器：模板 ref 回调调用（TransitionGroup 是组件，ref 拿到实例需取 $el） */
  function setContainerEl(el: unknown): void {
    containerRef.value = (el as { $el?: HTMLElement } | null)?.$el ?? (el as HTMLElement | null);
  }

  return {
    /** 本地有序标签数组（渲染数据源） */
    localTags,
    /** 正在被拖动的标签 id（给源 chip 加半透明样式） */
    draggingTagId,
    /** 容器 DOM 设置器（模板 ref 回调调用；TransitionGroup 是组件需取 $el） */
    setContainerEl,
    /** 手动同步外部数据（一般由 watch 自动触发，极少手动调） */
    syncFromStore,
    /** chip dragstart */
    onTagDragStart,
    /** chip dragend */
    onTagDragEnd,
    /** 容器级 dragover（挂到标签列表容器） */
    onContainerDragOver,
    /** 容器级 drop（挂到标签列表容器） */
    onContainerDrop,
  };
}
