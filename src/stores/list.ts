// 清单 store —— 管理清单与目录的加载、创建、树形结构、归档
// 遵循 AGENTS.md：store 作为唯一数据源，组件只读取不缓存
// 清单（kind='task'）与笔记本（kind='note'）共用 lists 表，靠 kind 隔离成两棵独立树。

import { defineStore } from "pinia";
import { ref, computed } from "vue";
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
    getById,
    getChildren,
    ensureFolderPath,
    moveNode,
    archiveTree,
    unarchiveTree,
  };
});
