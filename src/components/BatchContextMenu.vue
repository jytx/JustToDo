<script setup lang="ts">
// 批量操作右键菜单 —— 多选模式下右键选中任务时弹出
// 含 6 项操作：标记完成/取消完成、移到清单、加标签、改优先级、改截止日期、删除
// 子菜单（清单/标签/优先级/日期）在主菜单项 hover 时级联出现在右侧，
// 是桌面应用标准范式（Finder/IDE），比「同位置切换+返回」更直觉。
//
// 级联子菜单的实现要点：
// 1. 主菜单项 hover → 显示对应子菜单浮层，定位在主菜单项右边缘
// 2. 鼠标在主菜单项和子菜单间移动时不能误关（用定时器延迟关闭）
// 3. 视口右边缘放不下时，子菜单自动翻转到主菜单左侧
//
// 详见 discuss/2026-07-31-batch-operation-design.md
import { ref, computed, nextTick, reactive } from "vue";
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

/** 清单选项（扁平，仅 task kind） */
const listOptions = computed(() =>
  listStore.taskLists.map((l) => ({ id: l.id, name: l.name, color: l.color })),
);

/** 标签选项 */
const tagOptions = computed(() => tagStore.tags);

/** 标签子菜单里勾选的标签 id（可多选，最后统一应用） */
const selectedTagIds = ref<string[]>([]);

// ── 级联子菜单状态 ──
/** 当前展开的子菜单 key：null=无 | 'list' | 'tag' | 'priority' | 'date' */
const openSubmenu = ref<null | "list" | "tag" | "priority" | "date">(null);
/** 子菜单浮层定位（相对视口，position:fixed） */
const submenuStyle = reactive<{ display: boolean; top: string; left: string }>({
  display: false,
  top: "0px",
  left: "0px",
});
/** 关闭子菜单的定时器（延迟关闭，避免鼠标斜向移动时误关） */
let closeTimer: number | null = null;
/** 延迟关闭毫秒数：给鼠标留出从主菜单项移动到子菜单的时间 */
const CLOSE_DELAY = 200;

/** 计算子菜单定位：贴在主菜单项的右边缘，垂直对齐项顶部。
 *  视口边界保护：
 *  - 水平：右侧放不下 → 翻转到触发项左侧
 *  - 垂直：底部放不下（日期选择器等大高度子菜单）→ 整体上移贴视口底边，
 *    保证完整可见不被裁剪 */
async function showSubmenu(key: "list" | "tag" | "priority" | "date", triggerEl: HTMLElement): Promise<void> {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  openSubmenu.value = key;
  await nextTick();
  // 等 submenu DOM 渲染后，按主菜单项位置 + 子菜单实际尺寸计算
  const tr = triggerEl.getBoundingClientRect();
  const submenuEl = document.querySelector(".batch-submenu") as HTMLElement | null;
  const subW = submenuEl ? submenuEl.offsetWidth : 180;
  const subH = submenuEl ? submenuEl.offsetHeight : 400;
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const margin = 4;
  // 水平：默认放右侧；右侧放不下则翻转到左侧
  let left = tr.right + margin;
  if (left + subW > viewportW - margin) {
    left = tr.left - subW - margin;
  }
  // 垂直：默认对齐触发项顶部；底部放不下则整体上移贴视口底边（向上收，不被裁剪）
  let top = tr.top;
  if (top + subH > viewportH - margin) {
    top = Math.max(margin, viewportH - subH - margin);
  }
  submenuStyle.top = top + "px";
  submenuStyle.left = left + "px";
  submenuStyle.display = true;
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

/** 菜单关闭时重置所有子菜单与标签勾选状态 */
function onVisibleChange(v: boolean): void {
  emit("update:visible", v);
  if (!v) {
    openSubmenu.value = null;
    submenuStyle.display = false;
    selectedTagIds.value = [];
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }
}

/** 切换标签勾选 */
function toggleTag(id: string): void {
  const idx = selectedTagIds.value.indexOf(id);
  if (idx === -1) {
    selectedTagIds.value = [...selectedTagIds.value, id];
  } else {
    selectedTagIds.value = selectedTagIds.value.filter((t) => t !== id);
  }
}

// ── 各批量操作处理（执行后自动关闭菜单，store action 内部会 exitBatchMode） ──

async function applyList(listId: string): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchUpdateFields([...taskStore.batchSelectedIds], { listId });
}

async function applyPriority(p: Priority): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchUpdateFields([...taskStore.batchSelectedIds], { priority: p });
}

async function applyTags(): Promise<void> {
  if (selectedTagIds.value.length === 0) return;
  onVisibleChange(false);
  const ids = [...selectedTagIds.value];
  selectedTagIds.value = [];
  await taskStore.batchAddTags([...taskStore.batchSelectedIds], ids);
}

async function applyDate(start: string | null, end: string | null): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchUpdateFields([...taskStore.batchSelectedIds], {
    dueStartAt: start,
    dueEndAt: end,
  });
}

async function clearDate(): Promise<void> {
  await applyDate(null, null);
}

async function applyToggleDone(done: boolean): Promise<void> {
  onVisibleChange(false);
  await taskStore.batchToggleDone([...taskStore.batchSelectedIds], done);
}

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

    <!-- 标记完成（无子菜单） -->
    <MenuPopoverItem @click="applyToggleDone(true)">
      <icon-check :size="15" />
      <span>标记完成</span>
    </MenuPopoverItem>
    <!-- 取消完成（无子菜单） -->
    <MenuPopoverItem @click="applyToggleDone(false)">
      <icon-refresh :size="15" />
      <span>取消完成</span>
    </MenuPopoverItem>

    <!-- 移到清单（hover 弹右侧子菜单） -->
    <MenuPopoverItem
      @mouseenter="(e: MouseEvent) => showSubmenu('list', e.currentTarget as HTMLElement)"
      @mouseleave="scheduleCloseSubmenu"
    >
      <icon-folder :size="15" />
      <span>移到清单</span>
      <icon-right class="batch-menu__arrow" :size="12" />
    </MenuPopoverItem>

    <!-- 加标签（hover 弹右侧子菜单） -->
    <MenuPopoverItem
      @mouseenter="(e: MouseEvent) => showSubmenu('tag', e.currentTarget as HTMLElement)"
      @mouseleave="scheduleCloseSubmenu"
    >
      <icon-tag :size="15" />
      <span>加标签</span>
      <icon-right class="batch-menu__arrow" :size="12" />
    </MenuPopoverItem>

    <!-- 改优先级（hover 弹右侧子菜单） -->
    <MenuPopoverItem
      @mouseenter="(e: MouseEvent) => showSubmenu('priority', e.currentTarget as HTMLElement)"
      @mouseleave="scheduleCloseSubmenu"
    >
      <icon-fire :size="15" />
      <span>改优先级</span>
      <icon-right class="batch-menu__arrow" :size="12" />
    </MenuPopoverItem>

    <!-- 改截止日期（hover 弹右侧子菜单） -->
    <MenuPopoverItem
      @mouseenter="(e: MouseEvent) => showSubmenu('date', e.currentTarget as HTMLElement)"
      @mouseleave="scheduleCloseSubmenu"
    >
      <icon-calendar :size="15" />
      <span>改截止日期</span>
      <icon-right class="batch-menu__arrow" :size="12" />
    </MenuPopoverItem>

    <div class="batch-menu__divider" />
    <MenuPopoverItem danger @click="applyDelete">
      <icon-delete :size="15" />
      <span>删除（{{ selectedCount }}）</span>
    </MenuPopoverItem>

    <!-- 级联子菜单：Teleport 到 body，position:fixed 定位在主菜单项右侧 -->
    <Teleport to="body">
      <div
        v-if="submenuStyle.display"
        class="batch-submenu context-menu"
        :style="{ position: 'fixed', top: submenuStyle.top, left: submenuStyle.left, zIndex: '10010' }"
        @mouseenter="cancelCloseSubmenu"
        @mouseleave="scheduleCloseSubmenu"
      >
        <!-- 移到清单子菜单 -->
        <template v-if="openSubmenu === 'list'">
          <div class="batch-menu__scroll">
            <MenuPopoverItem v-for="l in listOptions" :key="l.id" @click="applyList(l.id)">
              <span class="batch-menu__dot" :style="{ backgroundColor: l.color || '#6B7280' }" />
              <span>{{ l.name }}</span>
            </MenuPopoverItem>
          </div>
        </template>

        <!-- 改优先级子菜单 -->
        <template v-else-if="openSubmenu === 'priority'">
          <MenuPopoverItem
            v-for="(label, p) in PRIORITY_LABELS"
            :key="p"
            @click="applyPriority(Number(p) as Priority)"
          >
            <PriorityDot :priority="Number(p) as Priority" />
            <span>{{ label }}</span>
          </MenuPopoverItem>
        </template>

        <!-- 加标签子菜单（多选 + 应用） -->
        <template v-else-if="openSubmenu === 'tag'">
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

        <!-- 改截止日期子菜单（复用 DatePopover） -->
        <template v-else-if="openSubmenu === 'date'">
          <DatePopover
            :start-iso="null"
            :end-iso="null"
            @confirm="applyDate"
            @clear="clearDate"
          />
        </template>
      </div>
    </Teleport>
  </ContextMenu>
</template>

<style scoped>
/* 级联子菜单容器：与一级菜单（ContextMenu 的 .context-menu）外观完全一致，
 * 背景/圆角/padding/flex 布局保持一致；阴影更强，视觉上浮在一级菜单上方。
 * 说明：一级菜单的 .context-menu 样式是 ContextMenu.vue 的 scoped 样式，
 * 在本组件里复用类名匹配不到，必须在这里显式补全。 */
.batch-submenu {
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
.batch-menu__title {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  padding: 4px 8px;
  user-select: none;
}

/* 分隔线 */
.batch-menu__divider {
  height: 1px;
  background-color: var(--jt-border);
  margin: 4px 0;
}

/* 子菜单箭头：右对齐，灰色，提示有下级 */
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
