<script setup lang="ts">
// 清单级联子菜单 —— 递归渲染清单树，用于任务菜单的「移动至」。
//
// 多级目录：目录节点 hover 时在右侧展开下一级子菜单（Vue 递归组件天然
// 支持任意层级）。用 mouseenter/mouseleave 显式控制展开（而非纯 CSS :hover），
// 便于自动化验证 + 避免 :hover 在某些边缘场景的抖动。
//
// 关键：mouseenter/mouseleave 绑在 .list-cascade__folder（含菜单项 + 子菜单的
// 外层）上，鼠标在 folder 内部移动（含移入子菜单）不触发 mouseleave，
// 只有完全离开 folder 才收起，避免移动断开。
//
// 外观：一级由父级 .task-item-submenu 提供容器外观；递归子级由 .list-cascade__sub
// 提供同款外观，保持视觉统一。
import { computed, reactive } from "vue";
import type { ListTreeNode } from "@/stores/list";
import MenuPopoverItem from "@/components/MenuPopoverItem.vue";

const props = defineProps<{
  /** 本级要渲染的节点列表（同级清单 + 目录） */
  nodes: ListTreeNode[];
  /** 当前任务所属清单 id（用于高亮当前清单） */
  currentListId: string;
  /** 选中节点的回调（点击清单节点时触发；selectFolders=true 时目录节点也触发） */
  onSelect: (listId: string) => void;
  /** 目录节点是否可点击选中（侧边栏「移动至」场景：目标就是目录本身）。
   *  默认 false：目录仅作导航容器（任务「移动至」行为不变）。 */
  selectFolders?: boolean;
}>();

/** 目录节点：isFolder=true（仅作分组容器，不可放置任务） */
const folders = computed(() => props.nodes.filter((n) => n.isFolder));
/** 清单节点：isFolder=false（可放置任务） */
const lists = computed(() => props.nodes.filter((n) => !n.isFolder));

/** 各目录的展开态（folderId → 是否展开）。reactive 对象保证响应式。 */
const expanded = reactive<Record<string, boolean>>({});

function openFolder(id: string): void {
  expanded[id] = true;
}
function closeFolder(id: string): void {
  expanded[id] = false;
}
</script>

<template>
  <div class="list-cascade">
    <!-- 清单：点击即移动，当前所属清单高亮 -->
    <MenuPopoverItem
      v-for="list in lists"
      :key="list.id"
      :active="list.id === currentListId"
      @click="onSelect(list.id)"
    >
      <span class="list-cascade__dot" :style="{ backgroundColor: list.color }" />
      <span>{{ list.name }}</span>
    </MenuPopoverItem>

    <!-- 目录：hover 在右侧展开下一级（递归）。
         mouseenter/mouseleave 绑在外层 folder：移入子菜单仍属 folder 内，不收起。
         selectFolders=true 时目录项本身可点击选中（侧边栏「移动至」目标即目录）。 -->
    <div
      v-for="folder in folders"
      :key="folder.id"
      class="list-cascade__folder"
      @mouseenter="openFolder(folder.id)"
      @mouseleave="closeFolder(folder.id)"
    >
      <MenuPopoverItem @click="props.selectFolders ? onSelect(folder.id) : undefined">
        <icon-folder :size="15" />
        <span>{{ folder.name }}</span>
        <icon-right :size="12" style="margin-left: auto" />
      </MenuPopoverItem>
      <!-- 递归子菜单：absolute 定位在目录项右侧，expanded 控制显隐。
           外观由本组件 .list-cascade__sub 自定义（不依赖外部 .task-item-submenu，
           因 ListCascadeMenu 是独立组件，外部 scoped 样式不穿透到递归子级）。 -->
      <div
        class="list-cascade__sub"
        :class="{ 'list-cascade__sub--open': expanded[folder.id] }"
      >
        <ListCascadeMenu
          v-if="folder.children.length > 0"
          :nodes="folder.children"
          :current-list-id="currentListId"
          :on-select="onSelect"
          :select-folders="selectFolders"
        />
        <div v-else class="list-cascade__empty">（空目录）</div>
      </div>
    </div>

    <!-- 空状态：本级既无清单也无目录 -->
    <div v-if="lists.length === 0 && folders.length === 0" class="list-cascade__empty">
      （无可用清单）
    </div>
  </div>
</template>

<style scoped>
/* 容器：flex 列布局，不设外观（外观由父级 .task-item-submenu 或 .list-cascade__sub 提供） */
.list-cascade {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 目录项：relative 作为子菜单 absolute 定位基准 */
.list-cascade__folder {
  position: relative;
}

/* 递归子菜单：absolute 在目录项右侧，默认隐藏，open 时显示。
   外观自包含（背景/圆角/阴影/宽度/padding 与一级 .task-item-submenu 一致），
   不依赖外部 scoped 样式（ListCascadeMenu 是独立组件，外部 scoped 不穿透到递归子级）。 */
.list-cascade__sub {
  position: absolute;
  left: 100%;
  top: 0;
  display: none;
  /* 与目录项的小间距 */
  margin-left: 2px;
  /* 容器外观（与一级 .task-item-submenu 保持视觉统一） */
  width: max-content;
  min-width: 120px;
  max-width: 220px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.16),
    0 4px 12px rgba(0, 0, 0, 0.08);
  padding: 8px;
}
.list-cascade__sub--open {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 清单前置色点 */
.list-cascade__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}

/* 空状态提示 */
.list-cascade__empty {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  white-space: nowrap;
}
</style>
