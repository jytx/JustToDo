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

/** a-date-picker 的 v-model 桥接 —— 单日期同时写入 start/end（快速添加场景） */
const dueDateModel = computed({
  get: (): string | undefined => {
    if (!dueStartAt.value && !dueEndAt.value) return undefined;
    return (dueStartAt.value ?? dueEndAt.value!).split("T")[0];
  },
  set: (v: string | undefined) => {
    if (!v) {
      dueStartAt.value = null;
      dueEndAt.value = null;
    } else {
      // 单日期：start = end = 当天
      dueStartAt.value = new Date(v).toISOString();
      dueEndAt.value = new Date(v).toISOString();
    }
  },
});

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
      <!-- 主输入行：单一焦点，无前缀图标 -->
      <div class="quick-add__input-row">
        <input
          ref="inputRef"
          v-model="title"
          @keydown="onKeyDown"
          class="quick-add__input"
          placeholder="添加任务，按 Enter 保存"
        />
      </div>

      <!-- 分隔线 -->
      <div class="quick-add__divider" />

      <!-- 属性行：三个属性 inline 排在一行 -->
      <div class="quick-add__attrs">
        <!-- 优先级 —— 用 a-trigger 包 button 自定义触发器外观，popup 是 a-select 的纵向选项 -->
        <a-trigger trigger="click" position="bl" :popup-translate="[0, 4]">
          <button
            type="button"
            class="quick-add__trigger"
            :class="{ 'quick-add__trigger--active': priority > 0 }"
            :style="priority > 0 ? { color: priorityColor } : {}"
          >
            <icon-fire :size="14" />
            <span>{{ priorityLabel }}</span>
          </button>
          <template #content>
            <div class="quick-add__popup">
              <button
                v-for="(label, p) in PRIORITY_LABELS"
                :key="p"
                type="button"
                class="quick-add__popup-item"
                :class="{ 'quick-add__popup-item--active': Number(p) === priority }"
                @click="priority = Number(p) as Priority"
              >
                <PriorityDot :priority="(Number(p) as Priority)" :size="10" />
                <span>{{ label }}</span>
              </button>
            </div>
          </template>
        </a-trigger>

        <!-- 清单 —— 同样 a-trigger + 自定义 popup -->
        <a-trigger trigger="click" position="bl" :popup-translate="[0, 4]">
          <button type="button" class="quick-add__trigger">
            <span
              class="quick-add__list-dot"
              :style="{ backgroundColor: selectedListColor ?? 'var(--jt-text-tertiary)' }"
            />
            <span>{{ selectedListName }}</span>
          </button>
          <template #content>
            <div class="quick-add__popup quick-add__popup--list">
              <button
                v-for="list in listStore.sortedLists"
                :key="list.id"
                type="button"
                class="quick-add__popup-item"
                :class="{ 'quick-add__popup-item--active': list.id === selectedListId }"
                @click="selectedListId = list.id"
              >
                <span
                  class="quick-add__list-dot"
                  :style="{ backgroundColor: list.color }"
                />
                <span>{{ list.name }}</span>
              </button>
            </div>
          </template>
        </a-trigger>

        <!-- 日期 —— 单个 a-date-picker，紧凑、跟优先级/清单 trigger 同等大小 -->
        <a-date-picker
          v-model="dueDateModel"
          size="mini"
          class="quick-add__date"
          format="YYYY-MM-DD"
          :allow-clear="true"
        >
          <template #prefix>
            <icon-calendar :size="14" />
          </template>
        </a-date-picker>

        <span class="quick-add__spacer" />
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
}

/* 主输入行 —— 紧凑、单一焦点 */
.quick-add__input-row {
  display: flex;
  align-items: center;
  padding: 10px 16px 16px;
}

.quick-add__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  line-height: 1.4;
}

.quick-add__input::placeholder {
  color: var(--jt-text-tertiary);
}

/* 分割线 —— 让输入区和属性区分开 */
.quick-add__divider {
  height: 1px;
  background: var(--jt-border);
  margin: 0 16px;
}

/* 属性行 —— 三个属性 inline 排开（不再独占一行） */
.quick-add__attrs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 10px;
}

.quick-add__spacer {
  flex: 1;
}

/* 通用 trigger 按钮 —— 跟顶部输入框一样简洁（无边框，hover 才显示） */
.quick-add__trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--jt-text-secondary);
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.quick-add__trigger:hover,
.quick-add__trigger[aria-expanded="true"] {
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.quick-add__trigger--active {
  color: var(--jt-text-primary);
}

/* 列表色点 */
.quick-add__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 日期 picker —— 单日期，跟优先级/清单 trigger 同等大小 */
.quick-add__date.arco-picker {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0 10px;
  height: 26px;
  font-size: 12px;
  color: var(--jt-text-secondary);
  border-radius: 6px;
  white-space: nowrap;
  flex-shrink: 0;
  width: 130px !important;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.quick-add__date.arco-picker:hover,
.quick-add__date.arco-picker:focus-within,
.quick-add__date.arco-picker.arco-picker-focused {
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
  border: none;
  box-shadow: none;
}

.quick-add__date :deep(.arco-picker-input) {
  font-size: 12px !important;
  height: 22px !important;
}

.quick-add__date :deep(.arco-picker-input)::placeholder {
  color: var(--jt-text-tertiary);
}

/* 隐藏右侧日历 icon（我们用 prefix 已经有了） */
.quick-add__date :deep(.arco-picker-suffix) {
  display: none;
}

.quick-add__date :deep(.arco-picker-prefix) {
  margin-right: 4px;
  color: inherit;
  display: inline-flex;
}

/* 反馈条 */
.quick-add__feedback {
  padding: 6px 16px;
  font-size: 12px;
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
  top: 60px;
  vertical-align: top;
}
.quick-add-modal .arco-modal-body {
  padding: 0;
}

/* 日期 popup 内嵌 */
.quick-add__date-popup {
  padding: 8px;
  background: var(--jt-surface);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
}

.quick-add__trigger--icon {
  padding: 0 8px;
  min-width: 28px;
  justify-content: center;
}

.quick-add__trigger--icon :deep(svg) {
  color: inherit;
}

/* 自定义 popup 容器（优先级/清单 trigger 弹出内容） */
.quick-add__popup {
  min-width: 120px;
  background: var(--jt-surface);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
  padding: 4px;
}

.quick-add__popup--list {
  min-width: 160px;
  max-height: 280px;
  overflow-y: auto;
}

/* popup 内的选项按钮 —— 纵向单列 */
.quick-add__popup-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--jt-text-primary);
  font-family: var(--font-body);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.quick-add__popup-item:hover {
  background-color: var(--jt-surface-sunken);
}

.quick-add__popup-item--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

/* 深色模式 */
body[arco-theme="dark"] .quick-add__popup {
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}
</style>