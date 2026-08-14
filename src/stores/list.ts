// 清单 store —— 管理清单与目录的加载、创建、树形结构、归档
// 遵循 AGENTS.md：store 作为唯一数据源，组件只读取不缓存
// 清单（kind='task'）与笔记本（kind='note'）共用 lists 表，靠 kind 隔离成两棵独立树。

import { defineStore } from "pinia";
import { ref, reactive, computed } from "vue";
import type { List, TaskKind } from "@/types";
import * as db from "@/api/db";

/** 带子节点的树形清单 */
export interface ListTreeNode extends List {
  children: ListTreeNode[];
}

/** 递归遍历扁平数组，返回指定 id 的全部后代 id（含自身），按深度顺序排列
 *  纯函数：不修改入参，只读 lists.value；用于归档/取消归档后本地批量更新 archived 字段 */
function collectSubtreeIds(lists: List[], rootId: string): string[] {
  const ids: string[] = [];
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    ids.push(cur);
    for (const l of lists) {
      if (l.parentId === cur) stack.push(l.id);
    }
  }
  return ids;
}

/** 子树构建（纯函数）。归档区与主页区用同一份算法，但选用不同的"可见父级"集合：
 *
 *  1. archiveListTree / archiveNoteListTree：父级集合 = archived 项自己（active 父级不算）
 *     ——归档区只关心 archived 项之间的嵌套关系；active 父级会把 archived 子项"切开"独立显示。
 *     例如：active 父级"工作"→ archived 子目录"啊"→ archived 子清单 222/333/444。
 *     归档区里"啊"作为顶层根目录展示（不再挂在"工作"名下），222/333/444 仍挂在"啊"下。
 *     这样"啊"永远能在归档区可见，与 active 父级"工作"是否被归档独立。
 *
 *  2. listTree / noteListTree：父级集合 = active 项
 *     ——主页：active 子项挂在 active 父级下；若父级 archived 而子项 active（中间态），
 *     视为父级缺失，子项自然升至根级或祖父级展示，避免"数据没了"孤儿态。
 */
function buildArchiveTree(flat: List[], visibleIds: Set<string>): ListTreeNode[] {
  const byParent: Record<string, List[]> = {};
  for (const l of flat) {
    const key = l.parentId !== null && visibleIds.has(l.parentId) ? l.parentId : "__root__";
    (byParent[key] ??= []).push(l);
  }
  const build = (parentId: string | null): ListTreeNode[] => {
    const key = parentId ?? "__root__";
    const children = byParent[key] ?? [];
    return children.map((l) => ({ ...l, children: build(l.id) }));
  };
  return build(null);
}

export const useListStore = defineStore("list", () => {
  const lists = ref<List[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // === 侧边栏目录展开状态（UI 状态提升到 store：键盘切换清单时需跨组件展开目录链） ===
  /** 目录展开状态：key = 节点 id，value = 是否展开。缺省视为展开（undefined 时按 true 处理）。
   *  仅目录（isFolder）有意义；叶节点不读此状态。 */
  const expandedNodes = reactive<Record<string, boolean>>({});

  /** 切换目录展开/收起（点击侧边栏箭头） */
  function toggleNodeExpanded(id: string): void {
    expandedNodes[id] = !(expandedNodes[id] ?? true);
  }

  /** 显式设置目录展开状态（拖放落入目录后展开等场景） */
  function setNodeExpanded(id: string, value: boolean): void {
    expandedNodes[id] = value;
  }

  // ─── 批量多选状态（清单/笔记本；与 task.ts 的 batchSelectedIds 同构） ─────
  // 多选模式：Shift/Cmd+点击 或 右键菜单「多选」入口进入。
  // 选中集合独立于路由激活态（activeListId），互不影响。
  // 注意：多选是当前 subheader（清单/笔记本）的临时状态，切换视图必须清空，
  // 否则 batchSelectedIds 里的旧 id 残留，右键批量菜单会误操作到已不可见节点。
  /** 批量选中的清单/笔记本 id 集合（用 Set 保证去重，ref 包裹触发响应式） */
  const batchSelectedIds = ref<Set<string>>(new Set());
  /** 是否处于多选模式（决定行是否显示勾选框、右键是否弹批量菜单） */
  const batchMode = ref(false);
  /** Shift 范围选的锚点 id（最近一次选中/取消的节点） */
  const batchAnchorId = ref<string | null>(null);

  /** 展开目标节点的全部祖先目录链（键盘切换清单后让激活项在侧边栏可见）。
   *  纯操作：只写 expandedNodes，不改动数据。 */
  function expandPath(id: string): void {
    let curId: string | null = id;
    while (curId) {
      const node: List | undefined = lists.value.find((l) => l.id === curId);
      curId = node?.parentId ?? null;
      if (curId) expandedNodes[curId] = true;
    }
  }

  /** 按 position 排序的扁平清单 */
  const sortedLists = computed(() =>
    [...lists.value].sort((a, b) => a.position - b.position),
  );

  /** 已归档清单/目录（首页隐藏，归档区可见） */
  const archivedLists = computed(() => sortedLists.value.filter((l) => !!l.archived));
  /** 未归档清单/目录（首页可见） */
  const activeLists = computed(() => sortedLists.value.filter((l) => !l.archived));

  // === 按 kind 拆分：清单（task）与笔记本（note）两棵独立树 ===
  /** 未归档清单/目录（kind='task'） */
  const taskLists = computed(() => activeLists.value.filter((l) => l.kind !== "note"));
  /** 未归档笔记本/笔记本目录（kind='note'） */
  const noteLists = computed(() => activeLists.value.filter((l) => l.kind === "note"));

  /** 清单树（仅 kind='task' 的未归档项）
   *  注意：仅按 active 父级嵌套还不够——
   *  若父级已归档而子项未归档（用户曾因某种历史操作造成"中间态"），
   *  子项在 UI 上将"消失"（找不到父级可挂）。为此镜像 archiveListTree 的"父级存在即挂下"
   *  逻辑：把不在 activeLists 内的父级当作不存在，子项直接挂到根级，保证可见性。 */
  const listTree = computed<ListTreeNode[]>(() =>
    buildArchiveTree(taskLists.value, activeListIds.value),
  );

  /** 笔记本树（仅 kind='note' 的未归档项；同 listTree 思路防"中间态孤儿"） */
  const noteListTree = computed<ListTreeNode[]>(() =>
    buildArchiveTree(noteLists.value, activeListIds.value),
  );

  /** 未归档 id 集合，用于 listTree 的父级存在性判定（避免 active 子项因 archived 父级"消失"） */
  const activeListIds = computed(() => new Set(activeLists.value.map((l) => l.id)));
  /** 已归档 id 集合：归档区在自身 archived 项之间保持嵌套；
   *  active 祖先不再纳入"父级可见集合"——确保 archived 子项总能脱离 active 父级独立展示 */
  const archivedListIds = computed(() => new Set(archivedLists.value.map((l) => l.id)));

  /** 已归档清单（kind='task'） */
  const archivedTaskLists = computed(() =>
    archivedLists.value.filter((l) => l.kind !== "note"),
  );
  /** 已归档笔记本（kind='note'） */
  const archivedNoteLists = computed(() =>
    archivedLists.value.filter((l) => l.kind === "note"),
  );

  /** 清单归档子树 */
  const archiveListTree = computed<ListTreeNode[]>(() =>
    buildArchiveTree(archivedTaskLists.value, archivedListIds.value),
  );

  /** 笔记本归档子树 */
  const archiveNoteListTree = computed<ListTreeNode[]>(() =>
    buildArchiveTree(archivedNoteLists.value, archivedListIds.value),
  );

  /** 获取某目录下的直接子项 */
  function getChildren(parentId: string | null): List[] {
    return sortedLists.value.filter((l) => l.parentId === parentId);
  }

  async function loadLists() {
    loading.value = true;
    error.value = null;
    try {
      lists.value = await db.getLists();
    } catch (e) {
      error.value = String(e);
      console.error("[listStore] loadLists 失败:", e);
    } finally {
      loading.value = false;
    }
    // 整树重建后旧选中 id 已无意义：清空多选态，防止残留 id 误操作
    exitBatchMode();
  }

  async function createList(params: {
    name: string;
    color: string;
    parentId?: string | null;
    isFolder?: boolean;
    /** 容器类型：不传默认 'task'（清单/目录）；'note' = 笔记本/笔记本目录 */
    kind?: TaskKind;
  }) {
    const list = await db.createList(params);
    lists.value.push(list);
    return list;
  }

  /** 修改清单/笔记本/目录颜色：db 成功后原地更新 lists.value 中的对象，
   *  listTree 等 computed 及各消费方自动同步，不整树重载（沿用 tag store 的原地改对象模式） */
  async function setColor(id: string, color: string): Promise<void> {
    const node = lists.value.find((l) => l.id === id);
    if (!node || node.color === color) return;
    await db.setListColor(id, color);
    node.color = color;
  }

  function getById(id: string): List | undefined {
    return lists.value.find((l) => l.id === id);
  }

  /** 根据 "A/B/C" 路径查找或创建多级目录，返回最末级目录 ID。
   *  kind 决定创建的目录属于清单树还是笔记本树（两棵树独立，不互通）。 */
  async function ensureFolderPath(
    path: string,
    color: string,
    kind: TaskKind = "task",
  ): Promise<string | null> {
    const segments = path.split("/").map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    let parentId: string | null = null;
    for (const seg of segments) {
      // 查找同级是否已有同名同 kind 目录
      const existing = lists.value.find(
        (l) =>
          l.parentId === parentId &&
          l.isFolder &&
          l.name === seg &&
          (l.kind ?? "task") === kind,
      );
      if (existing) {
        parentId = existing.id;
      } else {
        const folder = await createList({
          name: seg,
          color,
          parentId,
          isFolder: true,
          kind,
        });
        parentId = folder.id;
      }
    }
    return parentId;
  }

  /**
   * 移动节点到新父级和位置
   * @param id 被移动的节点 ID
   * @param targetParentId 目标父级 ID（null = 根级）
   * @param targetIndex 在目标父级子列表中的插入位置（0 = 最前）
   *
   * 跨 kind 防护：清单与笔记本是两棵独立树，禁止互相移动（避免目录树混淆）。
   * 目标父级存在时，被移动节点 kind 必须等于目标父级 kind；目标为根级时放行。
   */
  async function moveNode(id: string, targetParentId: string | null, targetIndex: number) {
    // 跨 kind 防护
    const movingNode = lists.value.find((l) => l.id === id);
    if (movingNode && targetParentId !== null) {
      const target = lists.value.find((l) => l.id === targetParentId);
      if (target) {
        const nodeKind = movingNode.kind ?? "task";
        const targetKind = target.kind ?? "task";
        if (nodeKind !== targetKind) {
          console.warn("[listStore] 拒绝跨 kind 移动：清单与笔记本不可互相拖拽");
          return;
        }
      }
    }

    // 获取目标父级的子列表（移动前）
    const siblings = sortedLists.value.filter(
      (l) => l.parentId === targetParentId && l.id !== id,
    );

    // 计算新 position：取前后兄弟的中间值
    let newPosition: number;
    if (siblings.length === 0) {
      // 目标为空，给一个大值
      newPosition = Date.now();
    } else if (targetIndex <= 0) {
      // 插到最前面：比第一个小
      newPosition = siblings[0].position - 1000;
    } else if (targetIndex >= siblings.length) {
      // 插到最后面：比最后一个大
      newPosition = siblings[siblings.length - 1].position + 1000;
    } else {
      // 插到中间：取前后平均
      newPosition = Math.floor(
        (siblings[targetIndex - 1].position + siblings[targetIndex].position) / 2,
      );
    }

    await db.moveList(id, targetParentId, newPosition);

    // 更新本地数据
    const node = lists.value.find((l) => l.id === id);
    if (node) {
      node.parentId = targetParentId;
      node.position = newPosition;
    }
  }

  /** 归档整棵子树（自身 + 所有后代）。调 db 完成持久化后就地更新 lists.value 的 archived 字段，
   *  不调 loadLists：避免一次额外 round-trip。任务本身不动（list_id 不变）。 */
  async function archiveTree(id: string): Promise<void> {
    await db.archiveListTree(id);
    const ids = collectSubtreeIds(lists.value, id);
    for (const nid of ids) {
      const node = lists.value.find((l) => l.id === nid);
      if (node) node.archived = true;
    }
  }

  /** 取消归档：后端自动顺带恢复祖先链上的已归档项（避免"父级仍归档、子项已恢复"孤儿态）。
   *  本地无法精确预测被后端改动的祖先集合，因此重新 loadLists 同步状态。
   *  同时刷新 task counts（取消归档后主页可能重新计入该清单的任务数）。 */
  async function unarchiveTree(id: string): Promise<void> {
    await db.unarchiveListTree(id);
    await loadLists();
  }

  // ─── 批量多选 action（交互详见 discuss/2026-08-14-list-batch-operation-design.md） ──
  // 进入方式：① Shift+点击范围选 ② Cmd/Ctrl+点击单点增减 ③ 右键菜单「多选」入口 ④ Cmd+A 全选。
  // 退出方式：Esc / 批量操作执行完毕（改色例外，见 batchSetColor 注释）。

  /** 进入多选模式（从右键菜单「多选」入口触发），清空旧选中 */
  function enterBatchMode(): void {
    batchMode.value = true;
    batchSelectedIds.value = new Set();
    batchAnchorId.value = null;
  }

  /** 退出多选模式，清空所有选中与锚点 */
  function exitBatchMode(): void {
    batchMode.value = false;
    batchSelectedIds.value = new Set();
    batchAnchorId.value = null;
  }

  /** Cmd/Ctrl+点击：单节点增减选（切一个）。
   *  全部取消后自动退出多选模式。 */
  function toggleBatchSelect(id: string): void {
    batchMode.value = true;
    const next = new Set(batchSelectedIds.value);
    if (next.has(id)) {
      next.delete(id);
      if (next.size === 0) {
        exitBatchMode();
        return;
      }
    } else {
      next.add(id);
    }
    batchSelectedIds.value = next;
    batchAnchorId.value = id;
  }

  /** Shift+点击：范围选（从锚点到当前节点，基于 flatIds 顺序）。
   *  flatIds = 当前 subheader（清单/笔记本）可见 active 节点 DFS 序列，
   *  由 composable 传入（tree DFS 顺序即用户在界面上看到的顺序）。
   *  无锚点或锚点不在当前序列时退化为单点选。 */
  function rangeBatchSelect(flatIds: string[], id: string): void {
    batchMode.value = true;
    if (!batchAnchorId.value || flatIds.length === 0) {
      toggleBatchSelect(id);
      return;
    }
    const startIdx = flatIds.indexOf(batchAnchorId.value);
    const endIdx = flatIds.indexOf(id);
    if (startIdx === -1 || endIdx === -1) {
      toggleBatchSelect(id);
      return;
    }
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    const next = new Set(batchSelectedIds.value);
    for (let i = lo; i <= hi; i++) {
      next.add(flatIds[i]);
    }
    batchSelectedIds.value = next;
    batchAnchorId.value = id;
  }

  /** Cmd/Ctrl+A：全选当前 subheader 可见 active 节点（flatIds 序列） */
  function selectAllBatch(flatIds: string[]): void {
    if (flatIds.length === 0) return;
    batchMode.value = true;
    batchSelectedIds.value = new Set(flatIds);
    batchAnchorId.value = flatIds[flatIds.length - 1] ?? null;
  }

  /** 选中的清单/笔记本 id 数组（传给批量操作 action 用） */
  const batchSelectedIdsArr = computed(() => Array.from(batchSelectedIds.value));

  /** 判断节点是否被批量选中 */
  function isBatchSelected(id: string): boolean {
    return batchSelectedIds.value.has(id);
  }

  /** 批量改色（循环调 setColor 原地更新对象，不重载树）。
   *  完成后退出多选——所有批量操作统一「执行后退出」，行为可预测
   *  （与归档/删除/移动一致；用户反馈不再保留多选态）。 */
  async function batchSetColor(ids: string[], color: string): Promise<void> {
    for (const id of ids) {
      await setColor(id, color);
    }
    exitBatchMode();
  }

  /** 批量归档：循环调 archiveTree 整树归档。
   *  完成后退出多选（选中的节点已移至归档区，主页不再可见）。 */
  async function batchArchive(ids: string[]): Promise<void> {
    for (const id of ids) {
      await archiveTree(id);
    }
    exitBatchMode();
  }

  /** 批量取消归档：循环调 unarchiveTree（内部 loadLists）。
   *  完成后退出多选。 */
  async function batchUnarchive(ids: string[]): Promise<void> {
    for (const id of ids) {
      await unarchiveTree(id);
    }
    exitBatchMode();
  }

  /** 批量移动到目标父级（null = 根目录）：按 position 升序依次追加到目标末尾，
   *  保持整组的相对顺序（批量拖拽 / 批量「移动至」共用）。
   *  跨 kind 防护：清单与笔记本是两棵独立树，禁止互相移动（与 moveNode 对齐）。
   *  完成后退出多选。 */
  async function batchMove(ids: string[], targetParentId: string | null): Promise<void> {
    // 跨 kind 防护：被移动节点必须与目标父级同 kind（根级放行）
    if (targetParentId !== null) {
      const target = lists.value.find((l) => l.id === targetParentId);
      const targetKind = target?.kind ?? "task";
      const hasCrossKind = ids.some((id) => {
        const node = lists.value.find((l) => l.id === id);
        return node && (node.kind ?? "task") !== targetKind;
      });
      if (hasCrossKind) {
        console.warn("[listStore] 拒绝批量跨 kind 移动：清单与笔记本不可互相移动");
        return;
      }
    }
    const sorted = [...ids].sort((a, b) => {
      const pa = lists.value.find((l) => l.id === a)?.position ?? 0;
      const pb = lists.value.find((l) => l.id === b)?.position ?? 0;
      return pa - pb;
    });
    for (const id of sorted) {
      const siblings = sortedLists.value.filter(
        (l) => l.parentId === targetParentId && l.id !== id,
      );
      const newPosition =
        siblings.length === 0
          ? Date.now()
          : siblings[siblings.length - 1].position + 1000;
      await db.moveList(id, targetParentId, newPosition);
      const node = lists.value.find((l) => l.id === id);
      if (node) {
        node.parentId = targetParentId;
        node.position = newPosition;
      }
    }
    exitBatchMode();
  }

  // ─── 批量删除确认（与 task.ts 的 pendingBatchDeleteIds 同构） ─────────────
  /** 待批量删除的节点 id + 汇总的任务/笔记数（确认弹窗文案用）；null = 无待删除 */
  const pendingBatchDelete = ref<{ ids: string[]; taskCount: number } | null>(null);

  /** 请求批量删除：先汇总选中节点下的任务/笔记数（弹窗需展示「将移动到收件箱」的数量），
   *  再打开确认弹窗。不立即执行——由用户确认后走 confirmBatchDelete。 */
  async function requestBatchDelete(ids: string[]): Promise<void> {
    // 并行查各清单/笔记本下的条目数，汇总到弹窗文案
    const counts = await Promise.all(
      ids.map((id) => db.getTasksByList(id).then((tasks) => tasks.length)),
    );
    pendingBatchDelete.value = {
      ids,
      taskCount: counts.reduce((sum, n) => sum + n, 0),
    };
  }

  /** 取消批量删除（关闭确认弹窗） */
  function cancelBatchDelete(): void {
    pendingBatchDelete.value = null;
  }

  /** 确认批量删除：逐个 deleteList（任务迁移到收件箱/默认笔记本由后端处理），
   *  完成后重载树 + 退出多选。 */
  async function confirmBatchDelete(): Promise<void> {
    const pending = pendingBatchDelete.value;
    if (!pending) return;
    for (const id of pending.ids) {
      await db.deleteList(id);
    }
    pendingBatchDelete.value = null;
    await loadLists();
    exitBatchMode();
  }

  return {
    lists,
    sortedLists,
    archivedLists,
    activeLists,
    // 按 kind 拆分的两棵独立树
    taskLists,
    noteLists,
    listTree,
    noteListTree,
    archiveListTree,
    archiveNoteListTree,
    archivedTaskLists,
    archivedNoteLists,
    loading,
    error,
    loadLists,
    createList,
    setColor,
    getById,
    getChildren,
    ensureFolderPath,
    moveNode,
    archiveTree,
    unarchiveTree,
    expandedNodes,
    toggleNodeExpanded,
    setNodeExpanded,
    expandPath,
    // 批量多选状态与 actions
    batchSelectedIds,
    batchSelectedIdsArr,
    batchMode,
    batchAnchorId,
    enterBatchMode,
    exitBatchMode,
    toggleBatchSelect,
    rangeBatchSelect,
    selectAllBatch,
    isBatchSelected,
    batchSetColor,
    batchArchive,
    batchUnarchive,
    batchMove,
    // 批量删除确认
    pendingBatchDelete,
    requestBatchDelete,
    cancelBatchDelete,
    confirmBatchDelete,
  };
});
