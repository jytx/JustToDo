<script setup lang="ts">
// 清单/笔记本批量操作右键菜单 —— 多选模式下右键选中节点时弹出
//
// 主页菜单（scope='home'）：
//   · 批量归档（含 inbox/default-notebook 时置灰）
//   · 移动至 ▸（hover 级联子菜单：根目录 + 仅目录树，排除选中节点及后代）
//   · 改色 ▸（hover 级联色板：8 色调色板，选色即应用）
//   · 删除（弹确认框）
// 归档区菜单（scope='archive'）：
//   · 批量取消归档 · 删除
// 所有批量操作（含改色）执行后统一退出多选。
//
// 级联子菜单实现要点与 BatchContextMenu 完全一致（详见其注释）：
// 1. 主菜单项 hover → 显示对应子菜单浮层，定位在主菜单项右边缘
// 2. 鼠标在主菜单项和子菜单间移动时不能误关（用定时器延迟关闭）
// 3. 视口右边缘放不下时，子菜单自动翻转到主菜单左侧
// 4. 容器类名 .batch-submenu：ContextMenu 的点外部/滚动关闭逻辑已豁免该类名，
//    Teleport 出去的子菜单点击不会误关一级菜单
import { ref, computed, nextTick, reactive } from "vue";
import { Message } from "@arco-design/web-vue";
import { useListStore } from "@/stores/list";
import type { ListTreeNode } from "@/stores/list";
import { LIST_COLORS } from "@/utils/colors";
import ContextMenu from "./ContextMenu.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import ListCascadeMenu from "./menu/ListCascadeMenu.vue";

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 鼠标视口坐标 X（clientX） */
    x: number;
    /** 鼠标视口坐标 Y（clientY） */
    y: number;
    /** 菜单场景：'home' 主页多选 | 'archive' 归档区多选（决定「归档 vs 取消归档」） */
    scope?: "home" | "archive";
    /** 实体类型：'task' 清单 | 'note' 笔记本（决定文案） */
    kind?: "task" | "note";
    /** 「移动至」可选目标树（TheSidebar 计算好：仅目录 + 排除选中节点及后代）。
     *  默认空树（归档区不显示移动至，用不上） */
    moveTargetTree?: ListTreeNode[];
  }>(),
  { scope: "home", kind: "task", moveTargetTree: () => [] },
);

const emit = defineEmits<{
  "update:visible": [value: boolean];
  /** 批量操作完成（归档/取消归档），携带操作前的 ids 快照。
   *  TheSidebar 据此做路由跳转保护（当前路由在被操作节点上时跳走）。 */
  "batch-done": [ids: string[]];
}>();

const listStore = useListStore();

/** 是否笔记模式（文案：清单/任务 vs 笔记本/笔记） */
const isNote = computed(() => props.kind === "note");

/** 选中的数量（菜单标题与各操作项文案用） */
const selectedCount = computed(() => listStore.batchSelectedIdsArr.length);

/** 是否包含受保护节点（inbox / default-notebook）：批量归档/删除置灰禁用。
 *  与单条右键对系统节点的拦截一致（不可批量归档/删除系统节点）。 */
const containsProtected = computed(() =>
  listStore.batchSelectedIdsArr.some(
    (id) => id === "inbox" || id === "default-notebook",
  ),
);

// ── 级联子菜单状态（与 BatchContextMenu 同构） ──
/** 当前展开的子菜单 key：null=无 | 'move' | 'color' */
const openSubmenu = ref<null | "move" | "color">(null);
/** 子菜单浮层定位（相对视口，position:fixed）。
 *  top/bottom 二选一：普通子菜单用 top 对齐触发项；未使用的一侧用 undefined。 */
const submenuStyle = reactive<{
  display: boolean;
  top: string | undefined;
  bottom: string | undefined;
  left: string;
}>({
  display: false,
  top: "0px",
  bottom: undefined,
  left: "0px",
});
/** 关闭子菜单的定时器（延迟关闭，避免鼠标斜向移动时误关） */
let closeTimer: number | null = null;
/** 延迟关闭毫秒数：给鼠标留出从主菜单项移动到子菜单的时间 */
const CLOSE_DELAY = 200;

/** 计算子菜单定位：贴在主菜单项的右边缘，垂直对齐项顶部。
 *  视口边界保护：右侧放不下 → 翻转到触发项左侧；底部放不下 → 整体上移贴视口底边。 */
async function showSubmenu(key: "move" | "color", triggerEl: HTMLElement): Promise<void> {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  openSubmenu.value = key;
  // 先显示再测量：v-if 依赖 submenuStyle.display，若后置则在 nextTick 时元素
  // 尚未渲染，querySelector 拿不到真实尺寸，导致首次打开时定位错误（BatchContextMenu 教训）
  submenuStyle.display = true;
  await nextTick();
  // 再等一帧浏览器布局完成（offsetHeight 才准确）
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const tr = triggerEl.getBoundingClientRect();
  const submenuEl = document.querySelector(".batch-submenu") as HTMLElement | null;
  const subW = submenuEl ? submenuEl.offsetWidth : 180;
  const subH = submenuEl ? submenuEl.offsetHeight : 300;
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const margin = 4;
  // 水平：默认放右侧；右侧放不下则翻转到左侧
  let left = tr.right + margin;
  if (left + subW > viewportW - margin) {
    left = tr.left - subW - margin;
  }
  // 垂直：top 对齐触发项顶部；底部放不下则整体上移
  let top = tr.top;
  if (top + subH > viewportH - margin) {
    top = Math.max(margin, viewportH - subH - margin);
  }
  submenuStyle.top = top + "px";
  submenuStyle.bottom = undefined;
  submenuStyle.left = left + "px";
}

/** 延迟关闭子菜单（鼠标移出主菜单项和子菜单时触发） */
function scheduleCloseSubmenu(): void {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    openSubmenu.value = null;
    submenuStyle.display = false;
    closeTimer = null;
  }, CLOSE_DELAY);
}

/** 取消延迟关闭（鼠标进入子菜单或回到主菜单项时触发） */
function cancelCloseSubmenu(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** 菜单关闭时重置子菜单状态 */
function onVisibleChange(v: boolean): void {
  emit("update:visible", v);
  if (!v) {
    openSubmenu.value = null;
    submenuStyle.display = false;
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }
}

// ── 各批量操作处理（与 BatchContextMenu 统一原则：先快照选中 id，
//    再 onVisibleChange(false) 关菜单，最后用快照执行） ──

/** 批量归档：循环 archiveTree 整树归档（store 内部完成后退出多选）。
 *  完成后 emit batch-done（TheSidebar 做路由跳转保护）。 */
async function applyArchive(): Promise<void> {
  const ids = [...listStore.batchSelectedIdsArr];
  onVisibleChange(false);
  await listStore.batchArchive(ids);
  emit("batch-done", ids);
  Message.success(`已归档 ${ids.length} 个${isNote.value ? "笔记本" : "清单"}`);
}

/** 批量取消归档：循环 unarchiveTree（store 内部完成后退出多选）。
 *  完成后 emit batch-done。 */
async function applyUnarchive(): Promise<void> {
  const ids = [...listStore.batchSelectedIdsArr];
  onVisibleChange(false);
  await listStore.batchUnarchive(ids);
  emit("batch-done", ids);
  Message.success(`已取消归档 ${ids.length} 个${isNote.value ? "笔记本" : "清单"}`);
}

/** 批量移动到目标父级（null = 根目录）：追加到目标子列表末尾（保持相对顺序） */
async function applyMoveTo(parentId: string | null): Promise<void> {
  const ids = [...listStore.batchSelectedIdsArr];
  onVisibleChange(false);
  const insertIndex = listStore.getChildren(parentId).length;
  await listStore.batchMove(ids, parentId, insertIndex);
  Message.success(`已移动 ${ids.length} 个${isNote.value ? "笔记本" : "清单"}`);
}

/** 批量改色：选色即应用。
 *  store 内部完成后退出多选（所有批量操作统一「执行后退出」）。 */
async function applyColor(color: string): Promise<void> {
  const ids = [...listStore.batchSelectedIdsArr];
  onVisibleChange(false);
  await listStore.batchSetColor(ids, color);
  Message.success(`已为 ${ids.length} 个${isNote.value ? "笔记本" : "清单"}设置颜色`);
}

/** 批量删除：不直接执行，先请求确认（弹确认对话框），由用户确认后实际删除 */
function applyDelete(): void {
  const ids = [...listStore.batchSelectedIdsArr];
  onVisibleChange(false);
  void listStore.requestBatchDelete(ids);
}
</script>

<template>
  <ContextMenu :visible="visible" :x="x" :y="y" @update:visible="onVisibleChange">
    <!-- 标题：已选数量（文案随 kind：清单/笔记本） -->
    <div class="list-batch__title">已选 {{ selectedCount }} 个{{ isNote ? "笔记本" : "清单" }}</div>
    <div class="list-batch__divider" />

    <!-- 主页：批量归档 / 移动至 / 改色 -->
    <template v-if="scope === 'home'">
      <MenuPopoverItem :disabled="containsProtected" @click="applyArchive">
        <icon-archive :size="15" />
        <span>归档（{{ selectedCount }}）</span>
      </MenuPopoverItem>

      <!-- 移动至（hover 弹右侧级联子菜单：根目录 + 仅目录树） -->
      <MenuPopoverItem
        @mouseenter="(e: MouseEvent) => showSubmenu('move', e.currentTarget as HTMLElement)"
        @mouseleave="scheduleCloseSubmenu"
      >
        <icon-swap :size="15" />
        <span>移动至</span>
        <icon-right class="list-batch__arrow" :size="12" />
      </MenuPopoverItem>

      <!-- 改色（hover 弹右侧级联色板） -->
      <MenuPopoverItem
        @mouseenter="(e: MouseEvent) => showSubmenu('color', e.currentTarget as HTMLElement)"
        @mouseleave="scheduleCloseSubmenu"
      >
        <icon-bg-colors :size="15" />
        <span>改色</span>
        <icon-right class="list-batch__arrow" :size="12" />
      </MenuPopoverItem>
    </template>

    <!-- 归档区：批量取消归档 -->
    <template v-else>
      <MenuPopoverItem @click="applyUnarchive">
        <icon-archive :size="15" />
        <span>取消归档（{{ selectedCount }}）</span>
      </MenuPopoverItem>
    </template>

    <div class="list-batch__divider" />

    <!-- 删除：弹确认框（inbox/default-notebook 参与多选时置灰） -->
    <MenuPopoverItem danger :disabled="containsProtected" @click="applyDelete">
      <icon-delete :size="15" />
      <span>删除（{{ selectedCount }}）</span>
    </MenuPopoverItem>

    <!-- 级联子菜单：Teleport 到 body，position:fixed 定位在主菜单项右侧。
         类名 .batch-submenu 与 BatchContextMenu 一致（ContextMenu 点外部/滚动豁免） -->
    <Teleport to="body">
      <div
        v-if="submenuStyle.display"
        class="batch-submenu list-batch-submenu"
        :style="{ position: 'fixed', top: submenuStyle.top, bottom: submenuStyle.bottom, left: submenuStyle.left, zIndex: '10010' }"
        @mouseenter="cancelCloseSubmenu"
        @mouseleave="scheduleCloseSubmenu"
      >
        <!-- 移动至子菜单：根目录 + 目录树（仅目录可选，selectFolders=true）。
             树由 TheSidebar 传入（filterFolderTree 排除选中节点及后代） -->
        <template v-if="openSubmenu === 'move'">
          <MenuPopoverItem @click="applyMoveTo(null)">
            <icon-home :size="15" />
            <span>根目录</span>
          </MenuPopoverItem>
          <ListCascadeMenu
            :nodes="moveTargetTree"
            :current-list-id="''"
            :on-select="(folderId: string) => applyMoveTo(folderId)"
            :select-folders="true"
          />
        </template>

        <!-- 改色子菜单：8 色调色板（与侧边栏行内色板同款网格） -->
        <template v-else-if="openSubmenu === 'color'">
          <div class="list-batch__color-grid">
            <button
              v-for="c in LIST_COLORS"
              :key="c"
              type="button"
              class="list-batch__color-swatch"
              :style="{ backgroundColor: c }"
              :title="c"
              @click="applyColor(c)"
            />
          </div>
        </template>
      </div>
    </Teleport>
  </ContextMenu>
</template>

<style scoped>
/* 级联子菜单容器：复用 BatchContextMenu 的 .batch-submenu 外观
 * （ContextMenu 豁免逻辑按类名匹配；样式在此显式补全，与一级菜单一致） */
.list-batch-submenu {
  width: max-content;
  min-width: 120px;
  max-width: 220px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.16),
    0 4px 12px rgba(0, 0, 0, 0.08);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 菜单标题：非交互，灰色小字 */
.list-batch__title {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  padding: 4px 8px;
  user-select: none;
}

/* 分隔线 */
.list-batch__divider {
  height: 1px;
  background-color: var(--jt-border);
  margin: 4px 0;
}

/* 子菜单箭头：右对齐，灰色，提示有下级 */
.list-batch__arrow {
  margin-left: auto;
  color: var(--jt-text-tertiary);
}

/* 改色色板：与侧边栏行内色板同款 8 色网格 */
.list-batch__color-grid {
  display: flex;
  gap: 6px;
  padding: 4px 6px;
}

.list-batch__color-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: transform 0.12s;
}

.list-batch__color-swatch:hover {
  transform: scale(1.25);
}
</style>
