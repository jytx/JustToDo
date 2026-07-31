<script setup lang="ts">
// 批量操作右键菜单 —— 多选模式下右键选中任务时弹出
// 含 6 项操作：标记完成/取消完成、移到清单、加标签、改优先级、改截止日期、删除
// 采用「点击进入二级面板」而非 hover 级联，改动最小，符合现有 ContextMenu 结构
// 子菜单数据复用 listStore/taskStore/tagStore，日期复用 DatePopover
//
// 详见 discuss/2026-07-31-batch-operation-design.md
import { ref, computed } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { PRIORITY_LABELS, type Priority } from "@/types";
import ContextMenu from "./ContextMenu.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import DatePopover from "./DatePopover.vue";
import PriorityDot from "./PriorityDot.vue";

defineProps<{
  visible: boolean;
  /** 鼠标视口坐标 X（clientX） */
  x: number;
  /** 鼠标视口坐标 Y（clientY） */
  y: number;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const taskStore = useTaskStore();
const listStore = useListStore();
const tagStore = useTagStore();

/** 选中的任务数量（菜单标题显示用） */
const selectedCount = computed(() => taskStore.batchSelectedTasks.length);

/** 当前子面板：null=主菜单，其它值为对应二级面板 */
const panel = ref<null | "list" | "tag" | "priority" | "date">(null);

/** 清单选项（扁平，仅 task kind；笔记不进入批量操作场景） */
const listOptions = computed(() =>
  listStore.taskLists.map((l) => ({ id: l.id, name: l.name, color: l.color })),
);

/** 标签选项（复用 tagStore.tags） */
const tagOptions = computed(() => tagStore.tags);

/** 标签二级面板里勾选的标签 id（可多选，最后统一应用） */
const selectedTagIds = ref<string[]>([]);

/** 切换标签勾选 */
function toggleTag(id: string): void {
  const idx = selectedTagIds.value.indexOf(id);
  if (idx === -1) {
    selectedTagIds.value = [...selectedTagIds.value, id];
  } else {
    selectedTagIds.value = selectedTagIds.value.filter((t) => t !== id);
  }
}

/** 菜单关闭时重置子面板与标签勾选（避免下次打开残留） */
function onVisibleChange(v: boolean): void {
  emit("update:visible", v);
  if (!v) {
    panel.value = null;
    selectedTagIds.value = [];
  }
}

/** 返回主菜单 */
function backToMain(): void {
  panel.value = null;
}

// ── 各批量操作处理（执行后自动关闭菜单，store action 内部会 exitBatchMode） ──

/** 批量移到清单 */
async function applyList(listId: string): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchUpdateFields([...taskStore.batchSelectedIds], { listId });
}

/** 批量改优先级 */
async function applyPriority(p: Priority): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchUpdateFields([...taskStore.batchSelectedIds], { priority: p });
}

/** 批量加标签（应用当前勾选的标签后清空勾选） */
async function applyTags(): Promise<void> {
  if (selectedTagIds.value.length === 0) return;
  onVisibleChange(false);
  const ids = [...selectedTagIds.value];
  selectedTagIds.value = [];
  await taskStore.batchAddTags([...taskStore.batchSelectedIds], ids);
}

/** 批量改截止日期（DatePopover confirm 回调） */
async function applyDate(start: string | null, end: string | null): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchUpdateFields([...taskStore.batchSelectedIds], {
    dueStartAt: start,
    dueEndAt: end,
  });
}

/** 批量清除截止日期（DatePopover clear 回调） */
async function clearDate(): Promise<void> {
  await applyDate(null, null);
}

/** 批量标记完成 / 取消完成 */
async function applyToggleDone(done: boolean): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchToggleDone([...taskStore.batchSelectedIds], done);
}

/** 批量删除 */
async function applyDelete(): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchDelete([...taskStore.batchSelectedIds]);
}
</script>

<template>
  <ContextMenu :visible="visible" :x="x" :y="y" @update:visible="onVisibleChange">
    <!-- 标题：已选任务数 -->
    <div class="batch-menu__title">已选 {{ selectedCount }} 个任务</div>
    <div class="batch-menu__divider" />

    <!-- 主面板 -->
    <template v-if="!panel">
      <MenuPopoverItem @click="applyToggleDone(true)">
        <icon-check :size="15" />
        <span>标记完成</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="applyToggleDone(false)">
        <icon-refresh :size="15" />
        <span>取消完成</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'list'">
        <icon-folder :size="15" />
        <span>移到清单</span>
        <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'tag'">
        <icon-tag :size="15" />
        <span>加标签</span>
        <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'priority'">
        <icon-fire :size="15" />
        <span>改优先级</span>
        <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'date'">
        <icon-calendar :size="15" />
        <span>改截止日期</span>
        <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <div class="batch-menu__divider" />
      <MenuPopoverItem danger @click="applyDelete">
        <icon-delete :size="15" />
        <span>删除（{{ selectedCount }}）</span>
      </MenuPopoverItem>
    </template>

    <!-- 二级面板：移到清单 -->
    <template v-else-if="panel === 'list'">
      <MenuPopoverItem @click="backToMain">
        <icon-left :size="14" />
        <span>返回</span>
      </MenuPopoverItem>
      <div class="batch-menu__divider" />
      <div class="batch-menu__scroll">
        <MenuPopoverItem v-for="l in listOptions" :key="l.id" @click="applyList(l.id)">
          <span class="batch-menu__dot" :style="{ backgroundColor: l.color || '#6B7280' }" />
          <span>{{ l.name }}</span>
        </MenuPopoverItem>
      </div>
    </template>

    <!-- 二级面板：改优先级 -->
    <template v-else-if="panel === 'priority'">
      <MenuPopoverItem @click="backToMain">
        <icon-left :size="14" />
        <span>返回</span>
      </MenuPopoverItem>
      <div class="batch-menu__divider" />
      <MenuPopoverItem
        v-for="(label, p) in PRIORITY_LABELS"
        :key="p"
        @click="applyPriority(Number(p) as Priority)"
      >
        <PriorityDot :priority="Number(p) as Priority" />
        <span>{{ label }}</span>
      </MenuPopoverItem>
    </template>

    <!-- 二级面板：加标签（可多选 + 应用） -->
    <template v-else-if="panel === 'tag'">
      <MenuPopoverItem @click="backToMain">
        <icon-left :size="14" />
        <span>返回</span>
      </MenuPopoverItem>
      <div class="batch-menu__divider" />
      <div class="batch-menu__scroll">
        <MenuPopoverItem v-for="t in tagOptions" :key="t.id" @click="toggleTag(t.id)">
          <span class="batch-menu__check-slot">
            <icon-check v-if="selectedTagIds.includes(t.id)" :size="14" />
          </span>
          <span>{{ t.name }}</span>
        </MenuPopoverItem>
      </div>
      <div class="batch-menu__divider" />
      <MenuPopoverItem :disabled="selectedTagIds.length === 0" @click="applyTags">
        <icon-check-circle :size="15" />
        <span>应用到 {{ selectedCount }} 个任务</span>
      </MenuPopoverItem>
    </template>

    <!-- 二级面板：改截止日期（复用 DatePopover） -->
    <template v-else-if="panel === 'date'">
      <MenuPopoverItem @click="backToMain">
        <icon-left :size="14" />
        <span>返回</span>
      </MenuPopoverItem>
      <div class="batch-menu__divider" />
      <DatePopover
        :start-iso="null"
        :end-iso="null"
        @confirm="applyDate"
        @clear="clearDate"
      />
    </template>
  </ContextMenu>
</template>

<style scoped>
/* 菜单标题：非交互，灰色小字 */
.batch-menu__title {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  padding: 4px 8px;
  user-select: none;
}

/* 分隔线：与现有菜单视觉一致 */
.batch-menu__divider {
  height: 1px;
  background-color: var(--jt-border);
  margin: 4px 0;
}

/* 子菜单箭头：右对齐，灰色 */
.batch-menu__arrow {
  margin-left: auto;
  color: var(--jt-text-tertiary);
}

/* 清单色点 */
.batch-menu__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* 标签勾选占位（未选时占位保持对齐） */
.batch-menu__check-slot {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* 长列表滚动（清单/标签多时） */
.batch-menu__scroll {
  max-height: 240px;
  overflow-y: auto;
}
</style>
