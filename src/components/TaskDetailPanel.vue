<script setup lang="ts">
// 任务详情面板 —— 滴答清单风格沉浸式
// 顶部 chips 行 + 大标题 + 无边框 Tiptap 描述/检查项 + 底部 footer
import { ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import {
  PRIORITY_LABELS,
  RECURRENCE_FREQS,
  type Priority,
  type Task,
  type RecurrenceFreq,
} from "@/types";
import { formatDueDate, parseLocalIso } from "@/utils/date";
import TaskCheckbox from "./TaskCheckbox.vue";
import PriorityDot from "./PriorityDot.vue";
import RichTextEditor from "./RichTextEditor.vue";
import RichTextToolbar from "./RichTextToolbar.vue";
import PropertyChip from "./PropertyChip.vue";
import Popover from "./Popover.vue";
import DatePopover from "./DatePopover.vue";
import ReminderPopover from "./ReminderPopover.vue";
import RecurrencePopover from "./RecurrencePopover.vue";
import * as db from "@/api/db";

const taskStore = useTaskStore();
const listStore = useListStore();
const tagStore = useTagStore();

const props = defineProps<{
  panelWidth?: number;
}>();

const emit = defineEmits<{
  "update:panelWidth": [value: number];
}>();

const task = computed(() => taskStore.selectedTask);
const titleDraft = ref("");
const noteDraft = ref("");

/** 当前任务的关联标签 */
const taskTags = ref<db.Tag[]>([]);

/** 父任务链（面包屑导航）—— 从直接父级到根级 */
const parentChain = ref<Task[]>([]);

/** 加载父任务链 */
async function loadParentChain() {
  parentChain.value = [];
  if (!task.value?.parentId) return;
  let currentParentId: string | null = task.value.parentId;
  const chain: Task[] = [];
  while (currentParentId) {
    const parent = await db.getTaskById(currentParentId);
    if (!parent) break;
    chain.unshift(parent);
    currentParentId = parent.parentId;
  }
  parentChain.value = chain;
}

/** 加载当前任务的标签 */
async function loadTaskTags() {
  if (!task.value) {
    taskTags.value = [];
    return;
  }
  try {
    taskTags.value = await db.getTaskTags(task.value.id);
  } catch (e) {
    console.error("[TaskDetail] 加载任务标签失败:", e);
  }
}

// 拖拽调宽
function startResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = props.panelWidth ?? 360;

  function onMouseMove(ev: MouseEvent) {
    const delta = startX - ev.clientX;
    const newWidth = Math.max(320, Math.min(720, startWidth + delta));
    emit("update:panelWidth", newWidth);
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

watch(
  () => task.value?.id,
  async (id) => {
    titleDraft.value = task.value?.title ?? "";
    noteDraft.value = task.value?.note ?? "";
    if (id) {
      await tagStore.loadTags();
      await loadTaskTags();
      await loadParentChain();
    } else {
      taskTags.value = [];
      parentChain.value = [];
    }
  },
  { immediate: true },
);

// ─── 标题编辑 ─────────────────────────────────────
async function saveTitle() {
  if (!task.value) return;
  const trimmed = titleDraft.value.trim();
  if (trimmed && trimmed !== task.value.title) {
    await taskStore.updateTask(task.value.id, { title: trimmed });
  }
}

// ─── 描述编辑 ─────────────────────────────────────
async function saveNote(value: string) {
  if (!task.value) return;
  if (value !== task.value.note) {
    await taskStore.updateTask(task.value.id, { note: value });
  }
}

// ─── 优先级 ───────────────────────────────────────
const priority = computed<Priority>(() => task.value?.priority ?? 0);
const priorityColorValue = computed(() => {
  const map: Record<number, string> = {
    0: "var(--jt-text-tertiary)",
    1: "#3B82F6",
    2: "var(--jt-warning)",
    3: "var(--jt-error)",
  };
  return map[priority.value] ?? "var(--jt-text-tertiary)";
});
const priorityLabel = computed(() => {
  if (!task.value || task.value.priority === 0) return "优先级";
  return PRIORITY_LABELS[task.value.priority];
});

async function setPriority(p: Priority) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, { priority: p });
}

// ─── 清单 ─────────────────────────────────────────
const listOptions = computed(() =>
  listStore.sortedLists.map((l) => ({ id: l.id, name: l.name, color: l.color })),
);
const currentList = computed(() =>
  listOptions.value.find((l) => l.id === task.value?.listId) ?? null,
);

async function moveToList(listId: string) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, { listId });
}

// ─── 日期 ─────────────────────────────────────────
const dueInfo = computed(() => {
  if (!task.value) return null;
  return formatDueDate(task.value.dueStartAt, task.value.dueEndAt);
});

/** 顶部 chip 标签：支持范围 "今天 09:00 - 11:00" */
const dueLabel = computed(() => {
  if (!task.value) return "设置日期";
  const start = task.value.dueStartAt;
  const end = task.value.dueEndAt;
  if (!start && !end) return "设置日期";

  // 范围（有 start + end）
  if (start && end) {
    const s = parseLocalIso(start);
    const e = parseLocalIso(end);
    if (!s || !e) return dueInfo.value?.text ?? "设置日期";

    // 同一天
    const sameDay =
      s.getFullYear() === e.getFullYear() &&
      s.getMonth() === e.getMonth() &&
      s.getDate() === e.getDate();

    if (sameDay) {
      // 用 dueInfo.text 作为日期部分（同一天 fallback）
      const dayText = dueInfo.value?.text ?? "";
      const sHasTime = !isMidnight(s);
      const eHasTime = !isMidnight(e);
      if (sHasTime || eHasTime) {
        const sStr = sHasTime ? ` ${pad(s.getHours())}:${pad(s.getMinutes())}` : "";
        const eStr = eHasTime ? ` - ${pad(e.getHours())}:${pad(e.getMinutes())}` : "";
        return `${dayText}${sStr}${eStr}`;
      }
      return dayText;
    }
    // 跨天：保留 dueInfo.text（它会展示 "开始 ~ 结束"）
    return dueInfo.value?.text ?? "设置日期";
  }

  // 单点（只有 end 或只有 start）
  return dueInfo.value?.text ?? "设置日期";
});

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function isMidnight(d: Date) {
  return d.getHours() === 0 && d.getMinutes() === 0;
}

async function onDateConfirm(start: string | null, end: string | null) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    dueStartAt: start,
    dueEndAt: end,
  });
  // 重置 notified_at：Tiptap 任务列表提醒依赖 dueEndAt 变化时重新触发
  await db.updateTask(task.value.id, { notifiedAt: null } as any);
  dateVisible.value = false;
}

async function onDateClear() {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    dueStartAt: null,
    dueEndAt: null,
  });
  dateVisible.value = false;
}

// ─── 提醒 ─────────────────────────────────────────
const remindLabel = computed(() => {
  if (!task.value || task.value.remindOffsetMinutes == null) return "提醒";
  const offset = task.value.remindOffsetMinutes;
  if (offset === 0) return "准点";
  if (offset < 60) return `提前 ${offset} 分钟`;
  if (offset < 1440) return `提前 ${Math.floor(offset / 60)} 小时`;
  return `提前 ${Math.floor(offset / 1440)} 天`;
});

async function onReminderConfirm(value: number | null) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    remindOffsetMinutes: value,
  });
  await db.updateTask(task.value.id, { notifiedAt: null } as any);
  reminderVisible.value = false;
}

async function onReminderClear() {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    remindOffsetMinutes: null,
  });
  reminderVisible.value = false;
}

// ─── 重复 ─────────────────────────────────────────
const recurrenceLabel = computed(() => {
  if (!task.value?.recurrenceFreq) return "重复";
  const unit = RECURRENCE_FREQS.find(
    (f) => f.value === task.value!.recurrenceFreq,
  )?.label ?? "";
  // 去掉 label 自带的"每"前缀，避免"每每天"
  const cleanUnit = unit.replace(/^每/, "");
  if (task.value.recurrenceInterval === 1) return `每${cleanUnit}`;
  return `每 ${task.value.recurrenceInterval} ${cleanUnit}`;
});

async function onRecurrenceConfirm(freq: RecurrenceFreq | null, interval: number) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, {
    recurrenceFreq: freq,
    recurrenceInterval: interval,
  });
  recurrenceVisible.value = false;
}

// ─── 标签 ─────────────────────────────────────────
const availableTagOptions = computed(() =>
  tagStore.tags
    .filter((t) => !taskTags.value.some((tt) => tt.id === t.id))
    .map((t) => ({ id: t.id, name: t.name })),
);
const tagLabel = computed(() => {
  if (taskTags.value.length === 0) return "标签";
  if (taskTags.value.length === 1) return taskTags.value[0].name;
  return `${taskTags.value[0].name} +${taskTags.value.length - 1}`;
});

async function addExistingTag(tagId: string) {
  if (!task.value || !tagId) return;
  await db.addTaskTag(task.value.id, tagId);
  await loadTaskTags();
}

async function createNewTag(name: string) {
  const trimmed = (name || "").trim();
  if (!trimmed || !task.value) return;
  let tag = tagStore.getByName(trimmed);
  if (!tag) {
    tag = await tagStore.createTag(trimmed);
  }
  await db.addTaskTag(task.value.id, tag.id);
  await loadTaskTags();
}

async function removeTaskTag(tagId: string) {
  if (!task.value) return;
  await db.removeTaskTag(task.value.id, tagId);
  await loadTaskTags();
}

// ─── 弹层显隐状态 ───────────────────────────────
const dateVisible = ref(false);
const reminderVisible = ref(false);
const recurrenceVisible = ref(false);
const priorityVisible = ref(false);
const tagVisible = ref(false);
const listVisible = ref(false);
const moreVisible = ref(false);
/** 富文本工具条浮窗（footer "A" 按钮控制） */
const formatToolbarVisible = ref(false);
/** 删除二次确认弹窗 */
const deleteConfirmVisible = ref(false);
/** RichTextEditor 实例引用（用于工具条调用命令） */
const richTextEditorRef = ref<InstanceType<typeof RichTextEditor> | null>(null);

// ─── 完成切换 ─────────────────────────────────────
async function onToggle() {
  if (!task.value) return;
  await taskStore.toggleTask(task.value.id, !task.value.done);
}

// ─── 删除（二次确认）──────────────────────────────
/** 打开删除确认弹窗（更多菜单点击"删除任务"时调用） */
function askDelete() {
  if (!task.value) return;
  deleteConfirmVisible.value = true;
}

/** 实际执行删除（用户在确认弹窗里点"删除"时调用） */
async function doDelete() {
  if (!task.value) return;
  await taskStore.deleteTask(task.value.id);
  deleteConfirmVisible.value = false;
}

/** 取消删除 */
function cancelDelete() {
  deleteConfirmVisible.value = false;
}

// ─── 更多菜单操作 ─────────────────────────────────

/**
 * 在描述末尾插入一个空的 taskList（检查项）
/** 添加一个新检查项（独立字段 task.checklist） */
async function insertChecklistItem() {
  if (!task.value) return;
  await taskStore.addChecklistItem(task.value.id, "");
  // 滚动到新加的检查项
  await nextTick();
  const inputs = document.querySelectorAll<HTMLInputElement>(
    '.detail-panel__checklist-input',
  );
  const last = inputs[inputs.length - 1];
  if (last) {
    last.focus();
    last.select();
  }
}

/** 切换检查项完成态 */
async function toggleChecklistItem(itemId: string) {
  if (!task.value) return;
  await taskStore.toggleChecklistItem(task.value.id, itemId);
}

/** 删除检查项 */
async function removeChecklistItem(itemId: string) {
  if (!task.value) return;
  await taskStore.removeChecklistItem(task.value.id, itemId);
}

/** 失焦保存检查项的 title 改动 */
async function saveChecklistItem(itemId: string) {
  if (!task.value) return;
  const item = task.value.checklist.find((it) => it.id === itemId);
  if (!item) return;
  const trimmed = item.title.trim();
  if (!trimmed) {
    // 空标题 = 删除该项
    await removeChecklistItem(itemId);
    return;
  }
  if (trimmed !== item.title) {
    await taskStore.updateChecklistItem(task.value.id, itemId, { title: trimmed });
  }
}

/** 按 order 排序的检查项 */
const sortedChecklist = computed(() => {
  if (!task.value) return [];
  return [...task.value.checklist].sort((a, b) => a.order - b.order);
});

/** 创建任务副本 */
async function duplicateTask() {
  if (!task.value) return;
  const t = task.value;
  // createTask 只支持基础字段，recurrence/reminder/note 走 update
  const newTask = await taskStore.createTask({
    title: `${t.title}（副本）`,
    listId: t.listId,
    priority: t.priority,
    dueStartAt: t.dueStartAt,
    dueEndAt: t.dueEndAt,
  });
  if (newTask) {
    await taskStore.updateTask(newTask.id, {
      note: t.note ?? "",
      recurrenceFreq: t.recurrenceFreq,
      recurrenceInterval: t.recurrenceInterval,
      remindOffsetMinutes: t.remindOffsetMinutes,
    });
  }
}

/** 添加子任务：在当前任务下创建一条新任务（子任务会出现在主面板树形列表里） */
async function addSubtask() {
  if (!task.value) return;
  await taskStore.createSubtask(task.value, "");
  // 重新加载当前任务的子任务，确保详情面板能拉到
  await taskStore.loadSubtasks(task.value.id);
  // 选中新建的子任务，方便用户直接输入标题
  const sub = taskStore.subtasks[taskStore.subtasks.length - 1];
  if (sub) taskStore.selectTask(sub.id);
}


// ─── 标题编辑：textarea（无边框、自动撑高；Enter 保存 / Esc 还原） ───
const titleEl = ref<HTMLTextAreaElement | null>(null);

function onTitleBlur() {
  if (!task.value) return;
  if (titleDraft.value !== (task.value.title ?? "")) {
    saveTitle();
  }
}

function onTitleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    (e.target as HTMLTextAreaElement).blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    titleDraft.value = task.value?.title ?? "";
    (e.target as HTMLTextAreaElement).blur();
  }
}

// ─── 优先级下拉渲染（已用 <PriorityDot> 替代） ───────
// PRIORITY_DOT_COLORS 由 PriorityDot 组件内部处理

// ─── 窄屏检测（次要 chip 塌缩为纯图标） ───────────
const panelEl = ref<HTMLElement | null>(null);
const narrow = ref(false);
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  if (!panelEl.value || typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (panelEl.value) {
        narrow.value = panelEl.value.clientWidth < 480;
      }
    }, 100);
  });
  resizeObserver.observe(panelEl.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (resizeTimer) clearTimeout(resizeTimer);
});
</script>

<template>
  <div
    v-if="task"
    ref="panelEl"
    class="detail-panel"
    :style="{ width: (panelWidth ?? 360) + 'px' }"
  >
    <!-- 拖拽手柄 -->
    <div class="detail-panel__resizer" @mousedown="startResize" />

    <!-- 顶部 chips 行 -->
    <div class="detail-panel__chips">
      <div class="detail-panel__checkbox-wrap">
        <TaskCheckbox
          v-if="task"
          :done="task.done"
          @toggle="onToggle"
          :size="20"
        />
      </div>

      <a-divider v-if="!narrow" direction="vertical" :margin="6" />

      <!-- 日期（关键属性，窄屏仍显示文字） -->
      <Popover v-model:visible="dateVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip
            :active="!!(task.dueStartAt || task.dueEndAt)"
            :style="dueInfo ? (dueInfo.overdue ? { color: 'var(--jt-error)' } : (dueInfo.isToday ? { color: 'var(--jt-error)', fontWeight: '600' } : {})) : {}"
            @click="dateVisible = !dateVisible"
          >
            <template #icon>
              <icon-calendar :size="14" />
            </template>
            {{ dueLabel }}
          </PropertyChip>
        </template>
        <DatePopover
          :start-iso="task.dueStartAt"
          :end-iso="task.dueEndAt"
          @confirm="onDateConfirm"
          @clear="onDateClear"
        />
      </Popover>

      <!-- 提醒（默认只图标 + tooltip） -->
      <a-tooltip :content="remindLabel" position="bottom">
        <Popover v-model:visible="reminderVisible" placement="bottom-left">
          <template #trigger>
            <PropertyChip
              :active="task.remindOffsetMinutes != null"
              icon-only
              @click="reminderVisible = !reminderVisible"
            >
              <template #icon>
                <icon-notification :size="14" />
              </template>
              {{ remindLabel }}
            </PropertyChip>
          </template>
          <ReminderPopover
            :value="task.remindOffsetMinutes"
            @confirm="onReminderConfirm"
            @clear="onReminderClear"
          />
        </Popover>
      </a-tooltip>

      <!-- 重复 -->
      <a-tooltip :content="recurrenceLabel" position="bottom">
        <Popover v-model:visible="recurrenceVisible" placement="bottom-left">
          <template #trigger>
            <PropertyChip
              :active="!!task.recurrenceFreq"
              icon-only
              @click="recurrenceVisible = !recurrenceVisible"
            >
              <template #icon>
                <icon-refresh :size="14" />
              </template>
              {{ recurrenceLabel }}
            </PropertyChip>
          </template>
          <RecurrencePopover
            :freq="task.recurrenceFreq"
            :interval="task.recurrenceInterval"
            @confirm="onRecurrenceConfirm"
          />
        </Popover>
      </a-tooltip>

      <!-- 优先级 -->
      <a-tooltip :content="priorityLabel" position="bottom">
        <Popover v-model:visible="priorityVisible" placement="bottom-left">
          <template #trigger>
            <PropertyChip
              :active="task.priority > 0"
              icon-only
              :style="task.priority > 0 ? { color: priorityColorValue } : {}"
              @click="priorityVisible = !priorityVisible"
            >
              <template #icon>
                <icon-fire :size="14" />
              </template>
              {{ priorityLabel }}
            </PropertyChip>
          </template>
          <div class="detail-panel__popup">
            <button
              v-for="(label, p) in PRIORITY_LABELS"
              :key="p"
              type="button"
              class="detail-panel__popup-item"
              :class="{ 'detail-panel__popup-item--active': Number(p) === task.priority }"
              @click="setPriority(Number(p) as Priority); priorityVisible = false"
            >
              <PriorityDot :priority="(Number(p) as Priority)" :size="10" />
              <span>{{ label }}</span>
            </button>
          </div>
        </Popover>
      </a-tooltip>

      <!-- 标签 -->
      <a-tooltip :content="tagLabel" position="bottom">
        <Popover v-model:visible="tagVisible" placement="bottom-left">
          <template #trigger>
            <PropertyChip
              :active="taskTags.length > 0"
              icon-only
              @click="tagVisible = !tagVisible"
            >
              <template #icon>
                <icon-tag :size="14" />
              </template>
              {{ tagLabel }}
            </PropertyChip>
          </template>
          <div class="detail-panel__popup detail-panel__popup--tag">
            <button
              v-for="opt in availableTagOptions"
              :key="opt.id"
              type="button"
              class="detail-panel__popup-item"
              @click="addExistingTag(opt.id); tagVisible = false"
            >
              <icon-tag :size="12" />
              <span>{{ opt.name }}</span>
            </button>
            <a-input
              placeholder="+ 新建标签"
              size="mini"
              allow-clear
              style="margin-top: 4px"
              @keydown.enter="(e: any) => { createNewTag(e.target.value); (e.target as HTMLInputElement).value = ''; tagVisible = false; }"
            />
          </div>
        </Popover>
      </a-tooltip>

      <!-- 行末：添加检查项（用 margin-left: auto 推至行最右，替代原"更多"按钮位置） -->
      <div class="detail-panel__chips-tail">
        <button
          class="detail-panel__more-btn"
          title="添加检查项"
          @click="insertChecklistItem()"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <rect x="2" y="3.5" width="12" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="7.25" width="9" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="11" width="6" height="1.5" rx="0.75" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 标签 chip 列表（已关联的） -->
    <div v-if="taskTags.length" class="detail-panel__tag-list">
      <a-tag
        v-for="tag in taskTags"
        :key="tag.id"
        size="small"
        closable
        @close="removeTaskTag(tag.id)"
      >
        {{ tag.name }}
      </a-tag>
    </div>

    <!-- 面包屑（父任务链）
         整条链路显示在一个胶囊里：祖父 / 父 / 父亲名
         整胶囊可点击 → 返回到直接父任务
         每段单独可点击 → 跳到该祖辈 -->
    <div v-if="parentChain.length" class="detail-panel__breadcrumb">
      <div class="detail-panel__breadcrumb-back">
        <template v-for="(p, i) in parentChain" :key="p.id">
          <button
            class="detail-panel__breadcrumb-back-item"
            :title="i === parentChain.length - 1 ? `返回：${p.title}` : `跳转到：${p.title}`"
            @click="taskStore.selectTask(p.id)"
          >
            <span class="detail-panel__breadcrumb-text">{{ p.title }}</span>
          </button>
          <span v-if="i < parentChain.length - 1" class="detail-panel__breadcrumb-sep">/</span>
        </template>
      </div>
    </div>

    <!-- 主区：标题 + 描述 -->
    <div class="detail-panel__main">
      <!-- 大标题（textarea，无边框，自动撑高；空时显示 placeholder） -->
      <textarea
        ref="titleEl"
        v-model="titleDraft"
        class="detail-panel__title"
        :class="{ 'detail-panel__title--done': task.done }"
        rows="1"
        placeholder="准备做什么?"
        spellcheck="false"
        @blur="onTitleBlur"
        @keydown="onTitleKeydown"
      />

      <!-- 描述（无边框 Tiptap；工具条由 footer "A" 按钮浮出） -->
      <RichTextEditor
        ref="richTextEditorRef"
        :model-value="noteDraft"
        borderless
        placeholder="输入内容或使用 / 快速插入"
        @update:model-value="(v) => { noteDraft = v; saveNote(v); }"
      />

      <!-- 检查项区（独立于描述） -->
      <div class="detail-panel__checklist">
        <div
          v-for="item in sortedChecklist"
          :key="item.id"
          class="detail-panel__checklist-item"
          :class="{ 'detail-panel__checklist-item--done': item.done }"
        >
          <button
            class="detail-panel__checklist-check"
            :aria-label="item.done ? '取消完成' : '标记完成'"
            @click="toggleChecklistItem(item.id)"
          >
            <icon-check v-if="item.done" :size="12" />
          </button>
          <input
            v-model="item.title"
            class="detail-panel__checklist-input"
            :class="{ 'detail-panel__checklist-input--done': item.done }"
            placeholder="检查项"
            @blur="saveChecklistItem(item.id)"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          />
          <button
            class="detail-panel__checklist-remove"
            title="删除"
            @click="removeChecklistItem(item.id)"
          >
            <icon-close :size="12" />
          </button>
        </div>
      </div>
    </div>

    <!-- 底部 footer -->
    <div class="detail-panel__footer">
      <!-- 当前清单 -->
      <Popover v-model:visible="listVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip compact :active="!!currentList" @click="listVisible = !listVisible">
            <template #icon>
              <icon-folder :size="12" />
            </template>
            {{ currentList?.name ?? "选择清单" }}
          </PropertyChip>
        </template>
        <div class="detail-panel__popup detail-panel__popup--list">
          <button
            v-for="opt in listOptions"
            :key="opt.id"
            type="button"
            class="detail-panel__popup-item"
            :class="{ 'detail-panel__popup-item--active': opt.id === task.listId }"
            @click="moveToList(opt.id); listVisible = false"
          >
            <span
              class="detail-panel__list-dot"
              :style="{ backgroundColor: opt.color }"
            />
            <span>{{ opt.name }}</span>
          </button>
        </div>
      </Popover>

      <span style="flex: 1" />

      <span class="detail-panel__meta">
        {{ formatMeta(task.createdAt) }}
      </span>

      <!-- 富文本工具条入口（滴答清单风格：footer "A" 按钮 + 浮出工具条） -->
      <Popover v-model:visible="formatToolbarVisible" placement="top-right" :offset="48">
        <template #trigger>
          <button
            class="detail-panel__format-btn"
            :class="{ 'detail-panel__format-btn--active': formatToolbarVisible }"
            title="文字格式"
            @click="formatToolbarVisible = !formatToolbarVisible"
          >
            <span class="detail-panel__format-btn-text">A</span>
          </button>
        </template>
        <div class="detail-panel__format-popup">
          <RichTextToolbar
            v-if="richTextEditorRef"
            :editor="richTextEditorRef.editor"
            compact
          />
        </div>
      </Popover>

      <!-- 更多菜单（从顶部 chip 行移到 footer） -->
      <Popover v-model:visible="moreVisible" placement="top-right">
        <template #trigger>
          <button class="detail-panel__more-btn" title="更多" @click="moreVisible = !moreVisible">
            <icon-more :size="16" />
          </button>
        </template>
        <div class="detail-panel__popup detail-panel__popup--more">
          <button
            type="button"
            class="detail-panel__popup-item"
            @click="addSubtask(); moreVisible = false"
          >
            <icon-plus :size="14" />
            <span>添加子任务</span>
          </button>
          <button
            type="button"
            class="detail-panel__popup-item"
            @click="duplicateTask(); moreVisible = false"
          >
            <icon-copy :size="14" />
            <span>创建副本</span>
          </button>
          <a-divider style="margin: 4px 0" />
          <button
            type="button"
            class="detail-panel__popup-item detail-panel__popup-item--danger"
            @click="askDelete(); moreVisible = false"
          >
            <icon-delete :size="14" />
            <span>删除任务</span>
          </button>
        </div>
      </Popover>
    </div>

    <!-- 删除二次确认弹窗 -->
    <a-modal
      :visible="deleteConfirmVisible"
      title="删除任务"
      :ok-text="'删除'"
      :cancel-text="'取消'"
      :ok-button-props="{ status: 'danger' }"
      :width="380"
      :modal-style="{ maxWidth: 'calc(100vw - 32px)' }"
      @ok="doDelete"
      @cancel="cancelDelete"
    >
      <p style="margin: 0; color: var(--jt-text-secondary); line-height: 1.6;">
        确定要删除任务「<strong style="color: var(--jt-text-primary);">{{ task?.title }}</strong>」吗？此操作无法撤销。
      </p>
    </a-modal>
  </div>
</template>

<script lang="ts">
// 辅助函数：格式化元信息日期
function formatMeta(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return "";
  }
}
</script>

<style scoped>
.detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  background: var(--jt-surface);
  border-left: 1px solid var(--jt-border);
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-panel__resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 1;
  transition: background-color 0.15s ease;
}

.detail-panel__resizer:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 30%, transparent);
}

/* ─── 顶部 chips ───────────────────────────────── */
.detail-panel__chips {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 12px 16px 8px;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.detail-panel__chips::-webkit-scrollbar {
  display: none;
}
.detail-panel__chips > * {
  flex-shrink: 0;
}
/* 更多按钮推到最右 */
.detail-panel__chips-tail {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
}
.detail-panel__more-btn {
  flex-shrink: 0;
}

.detail-panel__checkbox-wrap {
  padding-right: 4px;
  display: flex;
  align-items: center;
}

/* ─── 标签列表（已关联） ────────────────────────── */
.detail-panel__tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 16px 4px;
}

/* ─── 面包屑（子任务返回区） ─────────────── */
.detail-panel__breadcrumb {
  padding: 6px 16px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-family: var(--font-body);
}

/* 整条链在一个胶囊里（祖父 / 父 / 父亲名）
   胶囊作为载体，文字默认用浅一档的主色，hover 时加深；不再 hover 变背景。 */
.detail-panel__breadcrumb-back {
  display: inline-flex;
  align-items: center;
  gap: 0;
  max-width: 100%;
  height: 28px;
  padding: 0 4px 0 12px;
  border: none;
  border-radius: 14px;
  background-color: color-mix(in srgb, var(--jt-primary) 8%, transparent);
  /* 默认文字色：主色 + 60% 透明（颜色相对浅） */
  color: color-mix(in srgb, var(--jt-primary) 60%, transparent);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
  overflow: hidden;
  white-space: nowrap;
}

/* 整胶囊 hover：只把内部文字加深，背景几乎不变 */
.detail-panel__breadcrumb-back:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 10%, transparent);
  color: var(--jt-primary);
}

/* 胶囊内每段：可独立点击（跳转到对应父任务）
   默认沿用胶囊的颜色（继承），hover 时只加深文字。 */
.detail-panel__breadcrumb-back-item {
  display: inline-flex;
  align-items: center;
  height: 100%;
  padding: 0 4px;
  border: none;
  background: transparent;
  /* 颜色继承父胶囊（默认浅一档） */
  font-size: 13px;
  font-family: var(--font-body);
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.12s;
  white-space: nowrap;
  max-width: 160px;
}

.detail-panel__breadcrumb-back-item:last-child {
  /* 最后一段（直接父任务）加粗 */
  font-weight: 600;
}

/* 单段 hover：仅文字颜色加深到主色，不改变背景 */
.detail-panel__breadcrumb-back-item:hover {
  color: var(--jt-primary);
}

.detail-panel__breadcrumb-back-item:focus-visible {
  outline: 2px solid var(--jt-primary);
  outline-offset: 1px;
}

.detail-panel__breadcrumb-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

/* 链段间分隔符：跟胶囊默认文字色一致（浅一档） */
.detail-panel__breadcrumb-sep {
  color: color-mix(in srgb, var(--jt-primary) 40%, transparent);
  font-size: 12px;
  user-select: none;
  padding: 0 2px;
  flex-shrink: 0;
  transition: color 0.12s;
}

/* 鼠标 hover 在任意单段时，分隔符也跟着加深 */
.detail-panel__breadcrumb-back:hover .detail-panel__breadcrumb-sep {
  color: color-mix(in srgb, var(--jt-primary) 60%, transparent);
}

/* ─── 主区 ─────────────────────────────────────── */
.detail-panel__main {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px 20px;
  scrollbar-width: none;
}
.detail-panel__main::-webkit-scrollbar {
  display: none;
}

/* ─── 检查项区（独立于描述） ─────────────────── */
.detail-panel__checklist {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-panel__checklist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  transition: opacity 0.12s;
}

.detail-panel__checklist-item--done {
  opacity: 0.5;
}

.detail-panel__checklist-check {
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--jt-text-tertiary);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  transition: all 0.12s;
  padding: 0;
}

.detail-panel__checklist-check:hover {
  border-color: var(--jt-primary);
}

.detail-panel__checklist-item--done .detail-panel__checklist-check {
  background: var(--jt-primary);
  border-color: var(--jt-primary);
}

.detail-panel__checklist-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--jt-text-primary);
  padding: 4px 0;
  min-width: 0;
}

.detail-panel__checklist-input--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

.detail-panel__checklist-remove {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.12s;
  flex-shrink: 0;
  padding: 0;
}

.detail-panel__checklist-item:hover .detail-panel__checklist-remove {
  opacity: 1;
}

.detail-panel__checklist-remove:hover {
  background: var(--jt-surface-sunken);
  color: var(--jt-error);
}

.detail-panel__title {
  /* 与主页 AddTaskBar 一致的"无边框输入框"风格 */
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.5;
  color: var(--jt-text-primary);
  margin: 0 0 16px;
  cursor: text;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background-color: transparent;
  outline: none;
  resize: none;
  overflow: hidden;
  /* textarea 自动撑高（现代浏览器支持，fallback：rows=1 也能容下单行） */
  field-sizing: content;
  /* placeholder 样式 */
  &::placeholder {
    color: var(--jt-text-tertiary);
    font-weight: 400;
  }
}

.detail-panel__title:hover {
  background-color: var(--jt-surface-hover);
}

.detail-panel__title:focus {
  background-color: var(--jt-surface-sunken);
}

.detail-panel__title--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

/* ─── 底部 footer ──────────────────────────────── */
.detail-panel__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--jt-border);
  background: var(--jt-surface);
}

.detail-panel__meta {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  font-family: var(--font-mono);
  margin-right: 4px;
}

/* ─── 弹层（共享） ────────────────────────────── */
.detail-panel__popup {
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 6px;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
}

.detail-panel__popup--list {
  min-width: 200px;
}

.detail-panel__popup--tag {
  min-width: 200px;
}

.detail-panel__popup-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  background: transparent;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--jt-text-primary);
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
}

.detail-panel__popup-item:hover {
  background: var(--jt-surface-sunken);
}

.detail-panel__popup-item--active {
  background: var(--jt-accent-soft);
  color: var(--jt-primary);
}

.detail-panel__popup-item--danger {
  color: var(--jt-error);
}

.detail-panel__popup-item--danger:hover {
  background: color-mix(in srgb, var(--jt-error) 10%, transparent);
}

.detail-panel__popup--more {
  min-width: 180px;
}

.detail-panel__more-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
}

.detail-panel__more-btn:hover {
  color: var(--jt-text-primary);
}

/* ─── 富文本工具条入口（A 按钮 + 浮窗） ─────────── */
.detail-panel__format-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
  margin-right: 2px;
  font-family: var(--font-mono, monospace);
}

.detail-panel__format-btn:hover,
.detail-panel__format-btn--active {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.detail-panel__format-btn-text {
  font-size: 14px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.detail-panel__format-popup {
  padding: 6px 8px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
  max-width: calc(100vw - 16px);
  display: flex;
  align-items: center;
}

body[arco-theme="dark"] .detail-panel__format-popup {
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}

.detail-panel__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
