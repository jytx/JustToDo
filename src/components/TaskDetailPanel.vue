<script setup lang="ts">
// 任务详情面板 —— 滴答清单风格沉浸式
// 顶部 chips 行 + 大标题 + 无边框 Tiptap 描述/检查项 + 底部 footer
import { ref, watch, computed, nextTick } from "vue";
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

// ─── 完成切换 ─────────────────────────────────────
async function onToggle() {
  if (!task.value) return;
  await taskStore.toggleTask(task.value.id, !task.value.done);
}

// ─── 删除 ─────────────────────────────────────────
async function confirmDelete() {
  if (!task.value) return;
  if (!confirm("确定要删除这个任务吗？")) return;
  await taskStore.deleteTask(task.value.id);
}

// ─── 更多菜单操作 ─────────────────────────────────

/**
 * 在描述末尾插入一个空的 taskList（检查项）
/** 添加一个新检查项（独立字段 task.checklist） */
async function insertChecklistItem() {
  if (!task.value) return;
  await taskStore.addChecklistItem(task.value.id, "新检查项");
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

/** 复制任务链接到剪贴板 */
async function copyTaskLink() {
  if (!task.value) return;
  const url = `jtd://task/${task.value.id}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // fallback：弹窗
    prompt("复制任务 ID：", task.value.id);
  }
}

// ─── 标题编辑：使用 textarea 自动撑高 ─────────────
const titleEditing = ref(false);
const titleInputRef = ref<HTMLTextAreaElement | null>(null);
const titleHeight = ref(0);

function startEditTitle() {
  if (!task.value) return;
  titleEditing.value = true;
  // 下一帧聚焦并放到末尾
  setTimeout(() => {
    const el = titleInputRef.value;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, 0);
}

function finishEditTitle() {
  titleEditing.value = false;
  saveTitle();
}

function onTitleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    finishEditTitle();
  } else if (e.key === "Escape") {
    e.preventDefault();
    titleDraft.value = task.value?.title ?? "";
    titleEditing.value = false;
  }
}

watch(titleEditing, async (editing) => {
  if (editing) {
    await new Promise((r) => requestAnimationFrame(r));
    if (titleInputRef.value) {
      titleInputRef.value.style.height = "auto";
      titleInputRef.value.style.height = titleInputRef.value.scrollHeight + "px";
      titleHeight.value = titleInputRef.value.scrollHeight;
    }
  }
});

function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
  titleHeight.value = el.scrollHeight;
}

// ─── 优先级下拉渲染（已用 <PriorityDot> 替代） ───────
// PRIORITY_DOT_COLORS 由 PriorityDot 组件内部处理
</script>

<template>
  <div
    v-if="task"
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

      <a-divider direction="vertical" :margin="8" />

      <!-- 日期 -->
      <Popover v-model:visible="dateVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip
            :active="!!(task.dueStartAt || task.dueEndAt)"
            :style="dueInfo ? (dueInfo.overdue ? { color: 'var(--jt-error)' } : (dueInfo.isToday ? { color: 'var(--jt-primary)', fontWeight: '600' } : {})) : {}"
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

      <!-- 提醒 -->
      <Popover v-model:visible="reminderVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip :active="task.remindOffsetMinutes != null" @click="reminderVisible = !reminderVisible">
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

      <!-- 重复 -->
      <Popover v-model:visible="recurrenceVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip :active="!!task.recurrenceFreq" @click="recurrenceVisible = !recurrenceVisible">
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

      <!-- 优先级 -->
      <Popover v-model:visible="priorityVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip
            :active="task.priority > 0"
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

      <!-- 标签 -->
      <Popover v-model:visible="tagVisible" placement="bottom-left">
        <template #trigger>
          <PropertyChip :active="taskTags.length > 0" @click="tagVisible = !tagVisible">
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

      <span style="flex: 1" />

      <!-- 更多菜单 -->
      <Popover v-model:visible="moreVisible" placement="bottom-right">
        <template #trigger>
          <button class="detail-panel__more-btn" @click="moreVisible = !moreVisible">
            <icon-more :size="16" />
          </button>
        </template>
        <div class="detail-panel__popup detail-panel__popup--more">
          <button
            type="button"
            class="detail-panel__popup-item"
            @click="insertChecklistItem(); moreVisible = false"
          >
            <icon-check-square :size="14" />
            <span>添加检查项</span>
          </button>
          <button
            type="button"
            class="detail-panel__popup-item"
            @click="duplicateTask(); moreVisible = false"
          >
            <icon-copy :size="14" />
            <span>创建副本</span>
          </button>
          <button
            type="button"
            class="detail-panel__popup-item"
            @click="copyTaskLink(); moreVisible = false"
          >
            <icon-link :size="14" />
            <span>复制链接</span>
          </button>
          <a-divider style="margin: 4px 0" />
          <button
            type="button"
            class="detail-panel__popup-item detail-panel__popup-item--danger"
            @click="confirmDelete(); moreVisible = false"
          >
            <icon-delete :size="14" />
            <span>删除任务</span>
          </button>
        </div>
      </Popover>
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

    <!-- 面包屑（父任务链） -->
    <div v-if="parentChain.length" class="detail-panel__breadcrumb">
      <template v-for="(p, i) in parentChain" :key="p.id">
        <a-button
          type="text"
          size="mini"
          @click="taskStore.selectTask(p.id)"
        >
          <icon-left v-if="i === parentChain.length - 1" :size="12" />
          <span>{{ p.title }}</span>
        </a-button>
        <span v-if="i < parentChain.length - 1" class="detail-panel__breadcrumb-sep">/</span>
      </template>
    </div>

    <!-- 主区：标题 + 描述 -->
    <div class="detail-panel__main">
      <!-- 大标题 -->
      <textarea
        v-if="titleEditing"
        ref="titleInputRef"
        v-model="titleDraft"
        class="detail-panel__title-input"
        :style="{ minHeight: '40px' }"
        rows="1"
        @blur="finishEditTitle"
        @keydown="onTitleKeydown"
        @input="autoResize"
      />
      <h1
        v-else
        class="detail-panel__title"
        :class="{ 'detail-panel__title--done': task.done }"
        @click="startEditTitle"
      >
        {{ task.title }}
      </h1>

      <!-- 描述（无边框 Tiptap） -->
      <RichTextEditor
        :model-value="noteDraft"
        borderless
        hide-toolbar
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

      <a-button
        size="mini"
        type="text"
        status="danger"
        @click="confirmDelete"
      >
        <icon-delete :size="14" />
      </a-button>
    </div>
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
  flex-wrap: wrap;
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

/* ─── 面包屑 ───────────────────────────────────── */
.detail-panel__breadcrumb {
  padding: 0 16px 4px;
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
}

.detail-panel__breadcrumb-sep {
  color: var(--jt-text-tertiary);
  font-size: 11px;
  margin: 0 2px;
}

/* ─── 主区 ─────────────────────────────────────── */
.detail-panel__main {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px 20px;
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
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--jt-text-primary);
  margin: 0 0 16px;
  cursor: text;
  padding: 4px 0;
  border-radius: 4px;
  transition: background-color 0.12s;
  word-break: break-word;
}

.detail-panel__title:hover {
  background-color: var(--jt-surface-hover);
}

.detail-panel__title--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

.detail-panel__title-input {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--jt-text-primary);
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 4px 0;
  margin: 0 0 16px;
  background: transparent;
  font-family: var(--font-display), Georgia, serif;
  overflow: hidden;
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
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.detail-panel__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
