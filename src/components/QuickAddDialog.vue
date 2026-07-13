<script setup lang="ts">
// 全局快速添加 —— 顶部命令面板风格
// 快捷键 Cmd+Shift+A / Ctrl+Shift+A 唤起
// 设计参考 Linear / Things：单一焦点输入 + 紧凑属性 chip + 底部 hint
import { ref, watch, nextTick, computed } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { PRIORITY_LABELS, PRIORITY_COLORS, type Priority } from "@/types";
import PriorityDot from "./PriorityDot.vue";

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const taskStore = useTaskStore();
const listStore = useListStore();

const title = ref("");
const priority = ref<Priority>(0);
const selectedListId = ref("inbox");
const dueStartAt = ref<string | null>(null);
const dueEndAt = ref<string | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const feedback = ref<string | null>(null);

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

watch(open, async (isOpen) => {
  if (isOpen) {
    title.value = "";
    priority.value = 0;
    selectedListId.value = listStore.sortedLists[0]?.id ?? "inbox";
    dueStartAt.value = null;
    dueEndAt.value = null;
    feedback.value = null;
    await nextTick();
    inputRef.value?.focus();
  }
});

/** a-range-picker 的 v-model 桥接 */
const dueRangeModel = computed({
  get: (): [string, string] | undefined => {
    if (!dueStartAt.value && !dueEndAt.value) return undefined;
    return [dueStartAt.value ?? dueEndAt.value!, dueEndAt.value ?? dueStartAt.value!];
  },
  set: (v: [string, string] | undefined) => {
    if (!v) {
      dueStartAt.value = null;
      dueEndAt.value = null;
    } else {
      dueStartAt.value = v[0] ? new Date(v[0]).toISOString() : null;
      dueEndAt.value = v[1] ? new Date(v[1]).toISOString() : null;
    }
  },
});

const hasDate = computed(() => !!(dueStartAt.value || dueEndAt.value));

const priorityLabel = computed(() => {
  if (priority.value === 0) return "优先级";
  return PRIORITY_LABELS[priority.value];
});

const priorityColor = computed(() => {
  const c = PRIORITY_COLORS[priority.value];
  if (c === "info") return "#3B82F6";
  if (c === "warning") return "var(--jt-warning)";
  if (c === "error") return "var(--jt-error)";
  return "var(--jt-text-tertiary)";
});

const selectedListName = computed(
  () => listStore.getById(selectedListId.value)?.name ?? "收件箱",
);
const selectedListColor = computed(
  () => listStore.getById(selectedListId.value)?.color ?? null,
);

const dateLabel = computed(() => {
  if (!hasDate.value) return "日期";
  const fmt = (s: string | null) =>
    s ? new Date(s).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : "";
  return `${fmt(dueStartAt.value)} – ${fmt(dueEndAt.value)}`;
});

async function submit(keepOpen: boolean) {
  const trimmed = title.value.trim();
  if (!trimmed) return;

  await taskStore.createTask({
    title: trimmed,
    listId: selectedListId.value,
    priority: priority.value,
    dueStartAt: dueStartAt.value,
    dueEndAt: dueEndAt.value,
  });

  feedback.value = `已添加到「${selectedListName.value}」`;

  if (keepOpen) {
    title.value = "";
    priority.value = 0;
    dueStartAt.value = null;
    dueEndAt.value = null;
    setTimeout(() => feedback.value = null, 1500);
    await nextTick();
    inputRef.value?.focus();
  } else {
    setTimeout(() => {
      open.value = false;
    }, 800);
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    submit(false);
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit(true);
  } else if (e.key === "Escape") {
    open.value = false;
  }
}
</script>

<template>
  <a-modal
    :visible="open"
    @update:visible="(v) => (open = v)"
    :width="440"
    :footer="false"
    :mask-closable="true"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="quick-add-modal"
    wrap-class="quick-add-wrap"
  >
    <div class="quick-add">
      <!-- 主输入行 -->
      <div class="quick-add__input-row">
        <input
          ref="inputRef"
          v-model="title"
          @keydown="onKeyDown"
          class="quick-add__input"
          placeholder="添加任务..."
        />
      </div>

      <!-- 属性行：紧凑 chip 形式 -->
      <div class="quick-add__attrs">
        <!-- 优先级 chip -->
        <a-select
          v-model="priority"
          size="mini"
          class="quick-add__chip"
        >
          <template #label>
            <span class="quick-add__chip-inner" :style="{ color: priorityColor }">
              <icon-fire :size="14" />
              <span>{{ priorityLabel }}</span>
            </span>
          </template>
          <a-option v-for="(label, p) in PRIORITY_LABELS" :key="p" :value="Number(p)">
            <span class="quick-add__select-row">
              <PriorityDot :priority="(Number(p) as Priority)" :size="10" />
              <span>{{ label }}</span>
            </span>
          </a-option>
        </a-select>

        <!-- 清单 chip -->
        <a-select
          v-model="selectedListId"
          size="mini"
          class="quick-add__chip"
        >
          <template #label>
            <span class="quick-add__chip-inner">
              <span
                v-if="selectedListColor"
                class="quick-add__list-dot"
                :style="{ backgroundColor: selectedListColor }"
              />
              <icon-folder v-else :size="14" />
              <span>{{ selectedListName }}</span>
            </span>
          </template>
          <a-option v-for="list in listStore.sortedLists" :key="list.id" :value="list.id">
            <span class="quick-add__select-row">
              <span
                class="quick-add__list-dot"
                :style="{ backgroundColor: list.color }"
              />
              <span>{{ list.name }}</span>
            </span>
          </a-option>
        </a-select>

        <!-- 日期 chip -->
        <a-trigger
          trigger="click"
          position="bl"
          :popup-translate="[0, 6]"
        >
          <button
            type="button"
            class="quick-add__chip-trigger"
            :class="{ 'quick-add__chip-trigger--active': hasDate }"
          >
            <span class="quick-add__chip-inner">
              <icon-calendar :size="14" />
              <span>{{ dateLabel }}</span>
            </span>
          </button>
          <template #content>
            <div class="quick-add__date-popup">
              <a-range-picker
                v-model="dueRangeModel"
                size="small"
                style="width: 240px"
                format="YYYY-MM-DD"
                :allow-clear="true"
              />
            </div>
          </template>
        </a-trigger>

        <span class="quick-add__spacer" />

        <span class="quick-add__hint font-mono">⏎</span>
      </div>

      <Transition name="fade">
        <div v-if="feedback" class="quick-add__feedback">
          {{ feedback }}
        </div>
      </Transition>
    </div>
  </a-modal>
</template>

<style scoped>
.quick-add {
  overflow: hidden;
  margin-top: 80px;
}

.quick-add__input-row {
  display: flex;
  align-items: center;
  padding: 14px 18px;
}

.quick-add__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 16px;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  line-height: 1.4;
}

.quick-add__input::placeholder {
  color: var(--jt-text-tertiary);
  font-weight: 400;
}

.quick-add__attrs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 14px 12px;
}

.quick-add__spacer {
  flex: 1;
}

/* chip trigger —— 圆角胶囊、有边界、hover 反馈 */
.quick-add__chip-trigger {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--jt-border);
  border-radius: 999px;
  background: transparent;
  color: var(--jt-text-secondary);
  font-size: 12px;
  font-family: var(--font-body);
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.quick-add__chip-trigger:hover {
  background-color: var(--jt-surface-sunken);
}

.quick-add__chip-trigger--active {
  border-color: var(--jt-primary);
  color: var(--jt-text-primary);
}

.quick-add__chip-inner {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* select 触发器也做成 chip 风格（圆角胶囊 + 细边） */
:deep(.quick-add__chip .arco-select-view) {
  border: 1px solid var(--jt-border);
  border-radius: 999px;
  background: transparent;
  padding: 0 22px 0 10px;
  height: 26px;
  font-size: 12px;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

:deep(.quick-add__chip .arco-select-view:hover) {
  background-color: var(--jt-surface-sunken);
}

.quick-add__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

.quick-add__hint {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  padding: 0 4px;
}

.quick-add__feedback {
  padding: 8px 18px;
  font-size: 13px;
  color: var(--jt-success);
  background-color: rgba(5, 150, 105, 0.08);
  border-top: 1px solid var(--jt-border);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

<style>
.quick-add-wrap .arco-modal {
  top: 80px;
  vertical-align: top;
}
.quick-add-modal .arco-modal-body {
  padding: 0;
}

.quick-add-modal ~ .arco-select-dropdown,
.quick-add-modal ~ .arco-trigger-popup {
  border-radius: 10px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
}

.quick-add-modal ~ .arco-select-dropdown .arco-select-popup-inner,
.quick-add-modal ~ .arco-trigger-popup .arco-trigger-popup-content {
  padding: 4px !important;
}

.quick-add__select-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.quick-add__date-popup {
  padding: 8px;
}

body[arco-theme="dark"] .quick-add-modal ~ .arco-select-dropdown,
body[arco-theme="dark"] .quick-add-modal ~ .arco-trigger-popup {
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}
</style>