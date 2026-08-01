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
import { Message } from "@arco-design/web-vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { useSettingsStore } from "@/stores/settings";
import { PRIORITY_LABELS, type Priority } from "@/types";
import ContextMenu from "./ContextMenu.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import DatePopover from "./DatePopover.vue";
import PriorityDot from "./PriorityDot.vue";

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 鼠标视口坐标 X（clientX） */
    x: number;
    /** 鼠标视口坐标 Y（clientY） */
    y: number;
    /** 实体类型：'task'（默认，完整菜单）| 'note'（笔记：隐藏完成/优先级/日期等任务专属项） */
    kind?: "task" | "note";
  }>(),
  { kind: "task" },
);

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const taskStore = useTaskStore();
const listStore = useListStore();
const tagStore = useTagStore();

/** 是否笔记模式（隐藏任务专属菜单项） */
const isNote = computed(() => props.kind === "note");

/** AI 是否启用（决定是否显示 AI 总结菜单项） */
const aiEnabled = computed(() => useSettingsStore().aiEnabled);

/** 选中的数量（菜单标题显示用，文案随 kind）。
 *  用 batchSelectedIdsArr 而非 batchSelectedTasks：后者只从 currentTasks（根任务）
 *  过滤，不含子任务，选中子任务时计数会少算。 */
const selectedCount = computed(() => taskStore.batchSelectedIdsArr.length);

/** 目标列表选项：任务 → taskLists（清单）；笔记 → noteLists（笔记本）。
 *  两棵树相互独立，必须按 kind 取数，避免跨 kind 移动。
 *  必须过滤掉目录（isFolder=true）：目录是容器，不直接承载任务，
 *  任务移入目录后无法在任何视图显示，相当于数据丢失。 */
const listOptions = computed(() => {
  const source = isNote.value ? listStore.noteLists : listStore.taskLists;
  return source
    .filter((l) => !l.isFolder)
    .map((l) => ({ id: l.id, name: l.name, color: l.color }));
});

/** 标签选项 */
const tagOptions = computed(() => tagStore.tags);

// ── 级联子菜单状态 ──
/** 当前展开的子菜单 key：null=无 | 'list' | 'tag' | 'priority' | 'date' */
const openSubmenu = ref<null | "list" | "tag" | "priority" | "date">(null);
/** 子菜单浮层定位（相对视口，position:fixed）。
 *  top/bottom 二选一：普通子菜单用 top 对齐触发项；
 *  date 子菜单高度大，用 bottom 贴视口底边（CSS 层面，不依赖 JS 测量高度）。
 *  未使用的一侧用 undefined，Vue 会忽略该样式属性。 */
const submenuStyle = reactive<{ display: boolean; top: string | undefined; bottom: string | undefined; left: string }>({
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
  // 先显示再测量：v-if 依赖 submenuStyle.display，若后置则在 nextTick 时元素
  // 尚未渲染，querySelector 拿不到真实尺寸（fallback 高度偏小），
  // 导致首次打开时大高度子菜单（日期面板）定位错误、底部被裁。
  submenuStyle.display = true;
  await nextTick();
  // 再等一帧浏览器布局完成（DatePopover 内部日历等可能延迟渲染，
  // 仅 nextTick 不够，offsetHeight 仍偏小导致定位偏低）
  await new Promise((r) => requestAnimationFrame(() => r(null)));
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
  // 垂直定位策略：
  //  - date 子菜单高度大且内部日历可能延迟渲染（offsetHeight 测不准），
  //    用 CSS bottom 贴视口底边（不依赖 JS 测量高度），面板从下往上长，
  //    配合面板自身 max-height 滚动，确保完整可见
  //  - 其他子菜单（清单/标签/优先级）高度小，用 top 对齐触发项顶部，
  //    底部放不下时再整体上移
  if (key === "date") {
    submenuStyle.top = undefined;
    submenuStyle.bottom = margin + "px";
  } else {
    let top = tr.top;
    if (top + subH > viewportH - margin) {
      top = Math.max(margin, viewportH - subH - margin);
    }
    submenuStyle.top = top + "px";
    submenuStyle.bottom = undefined;
  }
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

/** 菜单关闭时重置子菜单状态与已应用标签记录 */
function onVisibleChange(v: boolean): void {
  emit("update:visible", v);
  if (!v) {
    openSubmenu.value = null;
    submenuStyle.display = false;
    appliedTagIds.value = new Set();
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }
}

/** 本轮已应用的标签 id（用于子菜单显示「已加」勾选，支持再点取消）。
 *  加标签不退出多选、不关菜单，用户可连续加多个标签。 */
const appliedTagIds = ref<Set<string>>(new Set());

/** 点击标签 toggle：未加 → 加到所有选中任务；已加 → 从所有选中任务移除。
 *  不关闭菜单、不退出多选——用户常需连续操作多个标签。 */
async function applySingleTag(id: string): Promise<void> {
  const taskCount = taskStore.batchSelectedIds.size;
  const taskIds = [...taskStore.batchSelectedIds];
  const applied = new Set(appliedTagIds.value);
  if (applied.has(id)) {
    // 已加 → 取消（从选中任务移除该标签）
    applied.delete(id);
    appliedTagIds.value = applied;
    await taskStore.batchRemoveTags(taskIds, [id]);
    Message.success(`已从 ${taskCount} 项移除标签`);
  } else {
    // 未加 → 添加
    applied.add(id);
    appliedTagIds.value = applied;
    await taskStore.batchAddTags(taskIds, [id]);
    Message.success(`已为 ${taskCount} 项添加标签`);
  }
}

// ── 各批量操作处理（执行后自动关闭菜单，store action 内部会 exitBatchMode） ──
// 统一原则：先快照选中 id（taskIds），再 onVisibleChange(false) 关菜单，
// 最后用快照执行。避免关闭菜单触发的状态重置影响待应用数据。

/** 批量移到清单/笔记本：移动后给「已移动 N 项到 XXX」提示，明确反馈 */
async function applyList(listId: string, listName: string): Promise<void> {
  const count = taskStore.batchSelectedIds.size;
  const taskIds = [...taskStore.batchSelectedIds];
  onVisibleChange(false);
  await taskStore.batchUpdateFields(taskIds, { listId });
  Message.success(`已移动 ${count} 项到「${listName}」`);
}

async function applyPriority(p: Priority): Promise<void> {
  const count = taskStore.batchSelectedIds.size;
  const taskIds = [...taskStore.batchSelectedIds];
  onVisibleChange(false);
  await taskStore.batchUpdateFields(taskIds, { priority: p });
  Message.success(`已为 ${count} 项设置优先级「${PRIORITY_LABELS[p]}」`);
}

async function applyDate(start: string | null, end: string | null): Promise<void> {
  const count = taskStore.batchSelectedIds.size;
  const taskIds = [...taskStore.batchSelectedIds];
  onVisibleChange(false);
  await taskStore.batchUpdateFields(taskIds, {
    dueStartAt: start,
    dueEndAt: end,
  });
  Message.success(start ? `已为 ${count} 项设置截止日期` : `已清除 ${count} 项的截止日期`);
}

async function clearDate(): Promise<void> {
  await applyDate(null, null);
}

async function applyToggleDone(done: boolean): Promise<void> {
  const count = taskStore.batchSelectedIds.size;
  const taskIds = [...taskStore.batchSelectedIds];
  onVisibleChange(false);
  await taskStore.batchToggleDone(taskIds, done);
  Message.success(done ? `已标记 ${count} 项为完成` : `已恢复 ${count} 项为未完成`);
}

async function applyDelete(): Promise<void> {
  // 不直接执行，先请求确认（弹确认对话框），由用户确认后实际删除
  const taskIds = [...taskStore.batchSelectedIds];
  onVisibleChange(false);
  taskStore.requestBatchDelete(taskIds);
}

/** AI 总结选中的任务：快照 id → 关菜单 → 设置 scope（AppLayout watch 自动打开弹窗） */
function applyAiSummary(): void {
  const taskIds = [...taskStore.batchSelectedIds];
  onVisibleChange(false);
  taskStore.pendingSummaryScope = { type: "tasks", ids: taskIds };
}
</script>

<template>
  <ContextMenu :visible="visible" :x="x" :y="y" @update:visible="onVisibleChange">
    <!-- 标题：已选数量（文案随 kind：任务/笔记） -->
    <div class="batch-menu__title">已选 {{ selectedCount }} 个{{ isNote ? "笔记" : "任务" }}</div>
    <div class="batch-menu__divider" />

    <!-- 标记完成（任务专属，笔记隐藏） -->
    <MenuPopoverItem v-if="!isNote" @click="applyToggleDone(true)">
      <icon-check :size="15" />
      <span>标记完成</span>
    </MenuPopoverItem>
    <!-- 取消完成（任务专属，笔记隐藏） -->
    <MenuPopoverItem v-if="!isNote" @click="applyToggleDone(false)">
      <icon-refresh :size="15" />
      <span>取消完成</span>
    </MenuPopoverItem>

    <!-- 移到清单/笔记本（hover 弹右侧子菜单，数据源按 kind 切换） -->
    <MenuPopoverItem
      @mouseenter="(e: MouseEvent) => showSubmenu('list', e.currentTarget as HTMLElement)"
      @mouseleave="scheduleCloseSubmenu"
    >
      <icon-folder :size="15" />
      <span>{{ isNote ? "移到笔记本" : "移到清单" }}</span>
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

    <!-- 改优先级（任务专属，笔记隐藏） -->
    <MenuPopoverItem
      v-if="!isNote"
      @mouseenter="(e: MouseEvent) => showSubmenu('priority', e.currentTarget as HTMLElement)"
      @mouseleave="scheduleCloseSubmenu"
    >
      <icon-fire :size="15" />
      <span>改优先级</span>
      <icon-right class="batch-menu__arrow" :size="12" />
    </MenuPopoverItem>

    <!-- 改截止日期（任务专属，笔记隐藏） -->
    <MenuPopoverItem
      v-if="!isNote"
      @mouseenter="(e: MouseEvent) => showSubmenu('date', e.currentTarget as HTMLElement)"
      @mouseleave="scheduleCloseSubmenu"
    >
      <icon-calendar :size="15" />
      <span>改截止日期</span>
      <icon-right class="batch-menu__arrow" :size="12" />
    </MenuPopoverItem>

    <div class="batch-menu__divider" />

    <!-- AI 总结（仅 AI 启用时显示）：总结选中的任务 -->
    <MenuPopoverItem v-if="aiEnabled" @click="applyAiSummary">
      <icon-robot :size="15" />
      <span>AI 总结</span>
    </MenuPopoverItem>

    <MenuPopoverItem danger @click="applyDelete">
      <icon-delete :size="15" />
      <span>删除（{{ selectedCount }}）</span>
    </MenuPopoverItem>

    <!-- 级联子菜单：Teleport 到 body，position:fixed 定位在主菜单项右侧 -->
    <Teleport to="body">
      <div
        v-if="submenuStyle.display"
        class="batch-submenu context-menu"
        :class="{ 'batch-submenu--date': openSubmenu === 'date' }"
        :style="{ position: 'fixed', top: submenuStyle.top, bottom: submenuStyle.bottom, left: submenuStyle.left, zIndex: '10010' }"
        @mouseenter="cancelCloseSubmenu"
        @mouseleave="scheduleCloseSubmenu"
      >
        <!-- 移到清单子菜单 -->
        <template v-if="openSubmenu === 'list'">
          <div class="batch-menu__scroll">
            <MenuPopoverItem v-for="l in listOptions" :key="l.id" @click="applyList(l.id, l.name)">
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

        <!-- 加标签子菜单（点击即应用，不关菜单，可连续加多个标签） -->
        <template v-else-if="openSubmenu === 'tag'">
          <div class="batch-menu__scroll">
            <MenuPopoverItem
              v-for="t in tagOptions"
              :key="t.id"
              :active="appliedTagIds.has(t.id)"
              @click="applySingleTag(t.id)"
            >
              <icon-tag :size="14" class="batch-menu__tag-icon" />
              <span>{{ t.name }}</span>
            </MenuPopoverItem>
          </div>
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

/* 日期子菜单：DatePopover 本身就是完整卡片（248px 白底圆角），
 * 去掉外层菜单卡片的宽度限制/padding/背景/阴影，避免出现双重面板框。
 * 外层仅保留透明定位容器，供 hover 保持打开与边界定位。 */
.batch-submenu--date {
  max-width: none;
  width: max-content;
  padding: 0;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
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

/* 标签图标：弱化视觉，次要色，不抢文字焦点 */
.batch-menu__tag-icon {
  color: var(--jt-text-tertiary);
}

/* 长列表滚动（清单/标签多时） */
.batch-menu__scroll {
  max-height: 240px;
  overflow-y: auto;
}
</style>
