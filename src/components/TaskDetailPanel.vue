<script setup lang="ts">
// 任务详情面板 —— 右栏常驻面板，可拖拽调整宽度
// 含：标题编辑、优先级、截止日期、清单切换、备注、子任务、标签
import { ref, watch, computed, onMounted, onUnmounted, h } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import {
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  type Priority,
  type Task,
} from "@/types";
import TaskCheckbox from "./TaskCheckbox.vue";
import PriorityDot from "./PriorityDot.vue";
import RichTextEditor from "./RichTextEditor.vue";
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
const newSubtaskName = ref("");

/** 当前任务的关联标签 */
const taskTags = ref<db.Tag[]>([]);

/** 可选标签列表（排除已关联的） */
const availableTagOptions = computed(() =>
  tagStore.tags
    .filter((t) => !taskTags.value.some((tt) => tt.id === t.id))
    .map((t) => ({ id: t.id, name: t.name })),
);

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
    chain.unshift(parent); // 头部插入，保证根任务在前
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
    const newWidth = Math.max(280, Math.min(800, startWidth + delta));
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

// ESC 键关闭面板
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && task.value) {
    // 输入框聚焦时先让输入框失焦，不关闭面板
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) {
      (active as HTMLElement).blur();
      return;
    }
    taskStore.selectTask(null);
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});

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

const subtasks = computed(() =>
  task.value ? taskStore.getSubtasks(task.value.id) : [],
);

const priorityColor = computed(() =>
  task.value ? PRIORITY_COLORS[task.value.priority] : "priority-none",
);

const priorityColorValue = computed(() => {
  const c = priorityColor.value;
  if (c === "error") return "var(--jt-error)";
  if (c === "warning") return "var(--jt-warning)";
  if (c === "info") return "#3B82F6";
  return "var(--jt-text-tertiary)";
});

// 清单下拉选项

async function saveTitle() {
  if (!task.value) return;
  const trimmed = titleDraft.value.trim();
  if (trimmed && trimmed !== task.value.title) {
    await taskStore.updateTask(task.value.id, { title: trimmed });
  }
}

async function saveNote() {
  if (!task.value) return;
  if (noteDraft.value !== task.value.note) {
    await taskStore.updateTask(task.value.id, { note: noteDraft.value });
  }
}

async function setPriority(p: Priority) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, { priority: p });
}

async function moveToList(listId: string) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, { listId });
}

/** 子任务 checkbox 切换 —— 不触发 selectTask */
async function onSubtaskToggle(sub: Task) {
  await taskStore.toggleTask(sub.id, !sub.done);
}

/** 点击子任务行 —— 进入该子任务的详情 */
function onSubtaskClick(sub: Task) {
  taskStore.selectTask(sub.id);
}

async function setDueRange(start: string | null, end: string | null) {
  if (!task.value) return;
  await taskStore.updateTask(task.value.id, { dueStartAt: start, dueEndAt: end });
}

async function createSubtask() {
  if (!task.value) return;
  const title = newSubtaskName.value.trim();
  if (!title) return;
  await taskStore.createSubtask(task.value, title);
  newSubtaskName.value = "";
}

/** 添加已存在的标签 */
async function addExistingTag(tagId: string) {
  if (!task.value || !tagId) return;
  await db.addTaskTag(task.value.id, tagId);
  await loadTaskTags();
}

/** 创建新标签并关联（a-select allow-create 触发） */
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

// 优先级下拉选项
const priorityOptions = Object.entries(PRIORITY_LABELS).map(([k, v]) => ({
  value: Number(k),
  label: v,
}));

// 开始日期（Date ↔ ISO 字符串）
const dueStartModel = computed({
  get: () => (task.value?.dueStartAt ? task.value.dueStartAt.split("T")[0] : undefined),
  set: (v: string | undefined) => {
    setDueRange(v ? new Date(v).toISOString() : null, task.value?.dueEndAt ?? null);
  },
});

// 结束日期（Date ↔ ISO 字符串）
const dueEndModel = computed({
  get: () => (task.value?.dueEndAt ? task.value.dueEndAt.split("T")[0] : undefined),
  set: (v: string | undefined) => {
    setDueRange(task.value?.dueStartAt ?? null, v ? new Date(v).toISOString() : null);
  },
});

// 清单下拉选项
const listOptions = computed(() =>
  listStore.sortedLists.map((l) => ({ value: l.id, label: l.name, color: l.color })),
);

/** 优先级颜色 → CSS 值 */
const PRIORITY_DOT_COLORS: Record<number, string> = {
  0: "var(--jt-text-tertiary)",
  1: "#3B82F6",
  2: "var(--jt-warning)",
  3: "var(--jt-error)",
};

/** select 选中值的自定义渲染：彩色圆点 + 文字 */
function formatPriorityLabel(data: any) {
  const color = PRIORITY_DOT_COLORS[data.value as number] ?? "var(--jt-text-tertiary)";
  const isNone = data.value === 0;
  return h("span", { style: "display: inline-flex; align-items: center; gap: 6px;" }, [
    h("span", {
      style: `width:9px;height:9px;border-radius:50%;background-color:${isNone ? "transparent" : color};border:2px solid ${color};box-sizing:border-box;display:inline-block;flex-shrink:0;`,
    }),
    data.label,
  ]);
}
</script>

<template>
    <div
      v-if="task"
      class="detail-panel"
      :style="{ width: (panelWidth ?? 360) + 'px' }"
    >
    <!-- 拖拽手柄 -->
    <div class="detail-panel__resizer" @mousedown="startResize"></div>

    <!-- 顶栏 -->
    <div class="detail-panel__header">
      <!-- 面包屑：父任务链 -->
      <div v-if="parentChain.length" class="detail-panel__breadcrumb">
        <a-button
          v-for="(parent, i) in parentChain"
          :key="parent.id"
          type="text"
          size="mini"
          class="detail-panel__breadcrumb-item"
          @click="taskStore.selectTask(parent.id)"
        >
          <icon-left v-if="i === 0" :size="12" />
          {{ parent.title }}
        </a-button>
      </div>
    </div>

    <div class="detail-panel__body">
      <!-- 标题区 -->
      <div class="detail-panel__title-row">
        <TaskCheckbox
          :done="task.done"
          @toggle="taskStore.toggleTask(task.id, !task.done)"
        />
        <input
          v-model="titleDraft"
          class="detail-panel__title-input"
          @blur="saveTitle"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
      </div>

      <a-divider class="my-2" />

      <!-- 属性区 -->
      <div class="detail-panel__attrs">
        <!-- 优先级 -->
        <div class="detail-panel__attr">
          <icon-fire :size="16" :style="{ color: priorityColorValue }" />
          <span class="detail-panel__attr-label">优先级</span>
          <a-select
            :model-value="task.priority"
            size="small"
            style="width: 130px"
            :format-label="formatPriorityLabel as any"
            @change="(v: any) => setPriority(v as Priority)"
          >
            <a-option
              v-for="opt in priorityOptions"
              :key="opt.value"
              :value="opt.value"
            >
              <PriorityDot :priority="opt.value as Priority" :size="8" />
              <span style="margin-left: 6px">{{ opt.label }}</span>
            </a-option>
          </a-select>
        </div>

        <!-- 清单 -->
        <div class="detail-panel__attr">
          <icon-folder :size="16" />
          <span class="detail-panel__attr-label">清单</span>
          <a-select
            :model-value="task.listId"
            size="small"
            style="width: 130px"
            @change="(v: any) => moveToList(v)"
          >
            <a-option
              v-for="opt in listOptions"
              :key="opt.value"
              :value="opt.value"
            >
              <span
                class="detail-panel__list-dot"
                :style="{ backgroundColor: opt.color }"
              />
              <span style="margin-left: 6px">{{ opt.label }}</span>
            </a-option>
          </a-select>
        </div>

        <!-- 开始日期 -->
        <div class="detail-panel__attr">
          <icon-calendar :size="16" />
          <span class="detail-panel__attr-label">开始日期</span>
          <a-date-picker
            v-model="dueStartModel"
            size="small"
            style="width: 130px"
            :allow-clear="true"
          />
        </div>

        <!-- 结束日期 -->
        <div class="detail-panel__attr">
          <icon-clock-circle :size="16" />
          <span class="detail-panel__attr-label">结束日期</span>
          <a-date-picker
            v-model="dueEndModel"
            size="small"
            style="width: 130px"
            :allow-clear="true"
          />
        </div>
      </div>

      <a-divider class="my-2" />

      <!-- 备注区（富文本） -->
      <div class="detail-panel__section">
        <span class="detail-panel__section-title">备注</span>
        <RichTextEditor
          :model-value="noteDraft"
          @update:model-value="(v) => { noteDraft = v; saveNote(); }"
        />
      </div>

      <a-divider class="my-2" />

      <!-- 子任务区 -->
      <div class="detail-panel__section">
        <span class="detail-panel__section-title">
          子任务 ({{ subtasks.filter((t: Task) => t.done).length }}/{{ subtasks.length }})
        </span>
        <div class="detail-panel__subtasks">
          <div
            v-for="sub in subtasks"
            :key="sub.id"
            class="detail-panel__subtask"
            @click="onSubtaskClick(sub)"
          >
            <TaskCheckbox
              :done="sub.done"
              @toggle="onSubtaskToggle(sub)"
            />
            <span
              class="detail-panel__subtask-title"
              :class="{ 'detail-panel__subtask-title--done': sub.done }"
            >
              {{ sub.title }}
            </span>
          </div>
          <div class="detail-panel__add-subtask">
            <icon-plus :size="16" />
            <input
              v-model="newSubtaskName"
              @keydown.enter="createSubtask"
              class="detail-panel__subtask-input"
              placeholder="添加子任务..."
            />
          </div>
        </div>
      </div>

      <a-divider class="my-2" />

      <!-- 标签区 -->
      <div class="detail-panel__section">
        <span class="detail-panel__section-title">标签</span>
        <div class="detail-panel__tags">
          <a-tag
            v-for="tag in taskTags"
            :key="tag.id"
            size="small"
            closable
            @close="removeTaskTag(tag.id)"
          >
            {{ tag.name }}
          </a-tag>
          <a-select
            :model-value="[]"
            size="mini"
            allow-create
            allow-search
            :style="{ minWidth: '100px', flex: 1 }"
            placeholder="选择或创建标签..."
            :bordered="false"
            :options="availableTagOptions"
            :field-names="{ value: 'id', label: 'name' }"
            @create="createNewTag"
            @change="(v: any) => addExistingTag(v)"
          />
        </div>
      </div>

      <a-divider class="my-2" />

      <!-- 元信息 -->
      <div class="detail-panel__meta">
        创建于 {{ new Date(task.createdAt).toLocaleDateString("zh-CN") }}
        · 更新于 {{ new Date(task.updatedAt).toLocaleDateString("zh-CN") }}
      </div>
    </div>
    </div>
</template>

<style scoped>
.detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  background-color: var(--jt-surface);
  border-left: 1px solid var(--jt-border);
  z-index: 1000;
  overflow-y: auto;
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.06);
}

.detail-panel__resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 10;
  transition: background-color 0.15s;
}

.detail-panel__resizer:hover {
  background-color: rgba(79, 70, 229, 0.3);
}

.detail-panel__header {
  display: flex;
  align-items: center;
  padding: 6px 8px 0;
  gap: 4px;
  min-height: 32px;
}

.detail-panel__breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  overflow: hidden;
}

.detail-panel__breadcrumb-item {
  font-size: 12px !important;
  color: var(--jt-text-tertiary);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-panel__breadcrumb-item:hover {
  color: var(--jt-primary);
}

.detail-panel__body {
  padding: 0 16px 16px;
}

.detail-panel__title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.detail-panel__title-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  font-weight: 600;
  color: var(--jt-text-primary);
  font-family: var(--font-body);
  padding: 2px 0;
}

.detail-panel__attrs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.detail-panel__attr {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.detail-panel__attr-label {
  font-size: 13px;
  color: var(--jt-text-secondary);
  min-width: 72px;
}

.detail-panel__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

.detail-panel__section {
  margin-bottom: 2px;
}

.detail-panel__section-title {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.detail-panel__subtasks {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.detail-panel__subtask {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.detail-panel__subtask:hover {
  background-color: var(--jt-surface-hover);
}

.detail-panel__subtask-title {
  font-size: 12px;
}

.detail-panel__subtask-title--done {
  text-decoration: line-through;
  color: var(--jt-text-tertiary);
}

.detail-panel__add-subtask {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  color: var(--jt-text-tertiary);
}

.detail-panel__subtask-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: inherit;
  font-family: var(--font-body);
}

.detail-panel__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.detail-panel__tags :deep(.arco-tag) {
  font-size: 11px;
  padding: 0 6px;
  height: 20px;
  line-height: 18px;
}

.detail-panel__tags :deep(.arco-tag .arco-icon) {
  font-size: 10px;
}

.detail-panel__tags :deep(.arco-select-view) {
  background: transparent;
}

.detail-panel__tags :deep(.arco-select-view-input) {
  font-size: 13px;
}

.detail-panel__meta {
  font-size: 11px;
  color: var(--jt-text-tertiary);
}
</style>
