<script setup lang="ts">
// 侧边栏收起态：目录级联浮动面板
// 点击目录图标后，在 rail 右侧弹出本面板；子目录点击后再递归弹出下一级。
// 子清单点击 → 路由跳转；外部点击 / Esc → 关闭整个级联链（由父级统一管理）。
import { computed } from "vue";
import { useRouter } from "vue-router";
import { IconFolder, IconRight } from "@arco-design/web-vue/es/icon";
import type { ListTreeNode } from "@/stores/list";
import { useTaskStore } from "@/stores/task";

/** 展开链项：目录 id + 该级面板的垂直锚点 */
interface CascadeChainItem {
  id: string;
  anchorTop: number;
}

const props = defineProps<{
  /** 要展开的目录节点 */
  folder: ListTreeNode;
  /** 本级面板的垂直锚点（与触发图标 / 上一级行对齐） */
  anchorTop: number;
  /** 本级面板距 rail 左侧的偏移（每深一级 + 面板宽度） */
  left: number;
  /** 当前已展开的目录链（id + anchorTop），用于判断哪一级行高亮、子级面板位置 */
  expandedChain: CascadeChainItem[];
  /** 当前层级深度（根级 = 0），用于决定 left 偏移 */
  depth: number;
  /** 节点类型：'task'（默认）清单目录 | 'note' 笔记本目录。
   *  决定子项跳转前缀（/list vs /notebook）与计数来源。 */
  kind?: "task" | "note";
}>();

const emit = defineEmits<{
  /** 点击子目录：把该目录设为展开链的第 parentDepth+1 位，截断其后 */
  expand: [folder: ListTreeNode, anchorTop: number, parentDepth: number];
  /** 点击子清单：跳转后由父级关闭整个级联 */
  select: [listId: string];
}>();

const router = useRouter();
const taskStore = useTaskStore();

/** 是否笔记本目录（kind='note'）：决定路由前缀与计数来源 */
const isNote = computed(() => props.kind === "note");
/** 路由前缀：清单 → /list，笔记本 → /notebook */
const routePrefix = computed(() => (isNote.value ? "/notebook" : "/list"));

/** 子项计数：清单用 listCounts，笔记本用 noteCounts */
function childCount(id: string): number {
  const map = isNote.value ? taskStore.noteCounts : taskStore.listCounts;
  return map[id] ?? 0;
}

/** 下一级展开项（链中 depth+1 位置）；存在则渲染递归子面板 */
const childExpanded = computed<CascadeChainItem | null>(() => {
  return props.expandedChain[props.depth + 1] ?? null;
});

/** 下一级要展开的子目录节点 */
const childExpandedFolder = computed<ListTreeNode | null>(() => {
  const next = childExpanded.value;
  if (!next) return null;
  return props.folder.children.find((c) => c.id === next.id) ?? null;
});

/** 某个子项是否处于展开高亮态（它的 id 出现在展开链的下一级位置） */
function isChildExpanded(childId: string): boolean {
  return childExpanded.value?.id === childId;
}

/** 点击子目录：通知父级把该目录设为展开链的下一级（截断同级及更深的旧选择） */
function onFolderClick(e: MouseEvent, folder: ListTreeNode) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  emit("expand", folder, rect.top + rect.height / 2, props.depth);
}

/** 点击子清单/子笔记本：按 kind 路由跳转 + 通知父级关闭级联 */
function onListClick(listId: string) {
  router.push(`${routePrefix.value}/${listId}`);
  emit("select", listId);
}
</script>

<template>
  <!-- 本级面板：Teleport 到 body，fixed 定位到 anchorTop / left -->
  <Teleport to="body">
    <div
      class="rail-cascade"
      :style="{ top: `${anchorTop}px`, left: `${left}px`, transform: 'translateY(-50%)' }"
    >
      <div class="rail-cascade__header">
        <icon-folder :size="13" :style="{ color: folder.color }" />
        <span class="rail-cascade__title">{{ folder.name }}</span>
      </div>
      <div class="rail-cascade__divider" />
      <div class="rail-cascade__list">
        <button
          v-for="child in folder.children"
          :key="child.id"
          type="button"
          class="rail-cascade__item"
          :class="{ 'rail-cascade__item--expanded': isChildExpanded(child.id) }"
          @click="child.isFolder ? onFolderClick($event, child) : onListClick(child.id)"
        >
          <!-- 子目录：文件夹图标 + 展开箭头 -->
          <icon-folder
            v-if="child.isFolder"
            :size="14"
            :style="{ color: child.color }"
          />
          <!-- 子清单：彩色圆点 -->
          <span
            v-else
            class="rail-cascade__dot"
            :style="{ backgroundColor: child.color }"
          />

          <span class="rail-cascade__name">{{ child.name }}</span>

          <!-- 子清单/子笔记本的条目数 -->
          <span
            v-if="!child.isFolder && childCount(child.id)"
            class="rail-cascade__count"
          >{{ childCount(child.id) }}</span>

          <!-- 子目录的展开提示箭头 -->
          <icon-right
            v-if="child.isFolder"
            :size="12"
            class="rail-cascade__arrow"
          />
        </button>
      </div>
    </div>

    <!-- 递归渲染下一级面板（子目录展开时） -->
    <SidebarRailCascade
      v-if="childExpandedFolder"
      :folder="childExpandedFolder"
      :anchor-top="childExpanded!.anchorTop"
      :left="left + 184"
      :expanded-chain="expandedChain"
      :depth="depth + 1"
      :kind="kind"
      @expand="(f, top, d) => emit('expand', f, top, d)"
      @select="(id) => emit('select', id)"
    />
  </Teleport>
</template>

<style scoped>
/* 浮动面板本体 —— 与 rail-tooltip 风格统一，但更大、可交互 */
.rail-cascade {
  position: fixed;
  z-index: 10000;
  min-width: 168px;
  max-width: 220px;
  padding: 6px;
  border-radius: 10px;
  background-color: var(--jt-surface);
  border: 1px solid var(--jt-border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  animation: rail-cascade-in 0.14s ease-out;
}

@keyframes rail-cascade-in {
  from { opacity: 0; transform: translateY(-50%) translateX(-6px); }
  to   { opacity: 1; transform: translateY(-50%) translateX(0); }
}

.rail-cascade__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 6px;
  color: var(--jt-text-tertiary);
  font-size: 11px;
  font-weight: 600;
}

.rail-cascade__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-cascade__divider {
  height: 1px;
  margin: 0 4px 4px;
  background-color: var(--jt-border);
}

.rail-cascade__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.rail-cascade__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s;
}

.rail-cascade__item:hover {
  background-color: var(--jt-surface-hover);
}

.rail-cascade__item--expanded {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

.rail-cascade__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.rail-cascade__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-cascade__count {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}

.rail-cascade__arrow {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}
</style>
