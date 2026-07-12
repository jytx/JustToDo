<script setup lang="ts">
// 侧边栏清单树形节点 —— 递归渲染目录和清单
import { ref } from "vue";
import type { ListTreeNode } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import {
  IconFolder,
  IconMore,
  IconEdit,
  IconDelete,
  IconRight,
  IconDown,
} from "@arco-design/web-vue/es/icon";

const props = defineProps<{
  node: ListTreeNode;
  depth: number;
}>();

const taskStore = useTaskStore();

const expanded = ref(true);

/** 删除确认 */
const emit = defineEmits<{
  edit: [node: ListTreeNode];
  delete: [node: ListTreeNode];
}>();

function onMenuClick(key: string) {
  if (key === "edit") emit("edit", props.node);
  else if (key === "delete") emit("delete", props.node);
}
</script>

<template>
  <div class="list-node">
    <!-- 目录 -->
    <div
      v-if="node.isFolder"
      class="list-node__row list-node__folder"
      :style="{ paddingLeft: depth * 16 + 'px' }"
    >
      <span class="list-node__expand" @click="expanded = !expanded">
        <icon-down v-if="expanded" :size="12" />
        <icon-right v-else :size="12" />
      </span>
      <icon-folder
        :size="16"
        class="list-node__folder-icon"
      />
      <span class="list-node__name">{{ node.name }}</span>
      <a-dropdown trigger="click" position="br" :popup-offset="4">
        <button class="list-node__menu-btn" @click.stop>
          <icon-more :size="16" />
        </button>
        <template #content>
          <a-menu class="sidebar-ctx-menu" @menu-item-click="onMenuClick">
            <a-menu-item key="edit">
              <icon-edit :size="15" />
              <span style="margin-left: 8px">编辑目录</span>
            </a-menu-item>
            <a-menu-item key="delete" class="sidebar-ctx-menu--danger">
              <icon-delete :size="15" />
              <span style="margin-left: 8px">删除目录</span>
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
    </div>

    <!-- 清单（非目录） -->
    <router-link
      v-else
      :to="`/list/${node.id}`"
      class="list-node__row list-node__list-item"
      :style="{ paddingLeft: depth * 16 + 'px' }"
    >
      <span class="list-node__dot-placeholder" />
      <span
        class="list-node__dot"
        :style="{ backgroundColor: node.color }"
      />
      <span class="list-node__title">{{ node.name }}</span>
      <span v-if="taskStore.listCounts[node.id]" class="list-node__count">{{ taskStore.listCounts[node.id] }}</span>
      <a-dropdown
        v-if="node.id !== 'inbox'"
        trigger="click"
        position="br"
        :popup-offset="4"
      >
        <button class="list-node__menu-btn" @click.stop.prevent>
          <icon-more :size="16" />
        </button>
        <template #content>
          <a-menu class="sidebar-ctx-menu" @menu-item-click="onMenuClick">
            <a-menu-item key="edit">
              <icon-edit :size="15" />
              <span style="margin-left: 8px">编辑清单</span>
            </a-menu-item>
            <a-menu-item key="delete" class="sidebar-ctx-menu--danger">
              <icon-delete :size="15" />
              <span style="margin-left: 8px">删除清单</span>
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
    </router-link>

    <!-- 递归渲染子节点 -->
    <div v-if="node.isFolder && expanded && node.children.length" class="list-node__children">
      <SidebarListNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        @edit="(n: ListTreeNode) => $emit('edit', n)"
        @delete="(n: ListTreeNode) => $emit('delete', n)"
      />
    </div>
  </div>
</template>

<style scoped>
/* 通用行样式 */
.list-node__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  position: relative;
}

/* 清单行（router-link）去掉下划线 */
.list-node__list-item {
  text-decoration: none;
}

.list-node__list-item:hover {
  background-color: var(--jt-surface-hover);
}

.list-node__folder:hover {
  background-color: var(--jt-surface-hover);
}

/* 展开箭头 */
.list-node__expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
  cursor: pointer;
}

/* 文件夹图标 */
.list-node__folder-icon {
  color: var(--jt-warning);
  flex-shrink: 0;
}

/* 名称 */
.list-node__name,
.list-node__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 色点占位（清单行对齐用） */
.list-node__dot-placeholder {
  width: 14px;
  flex-shrink: 0;
}

/* 色点 */
.list-node__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 任务计数 */
.list-node__count {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
  position: absolute;
  right: 8px;
  transition: right 0.15s;
}

/* hover 时计数左移给菜单按钮让位 */
.list-node__list-item:hover .list-node__count,
.list-node__folder:hover .list-node__count {
  right: 32px;
}

/* 更多按钮 */
.list-node__menu-btn {
  position: absolute;
  right: 4px;
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 5;
}

.list-node__row:hover .list-node__menu-btn {
  opacity: 1;
}

.list-node__menu-btn:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
</style>
