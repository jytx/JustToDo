<script setup lang="ts">
// 全局快速添加 —— 顶部居中浮出的迷你输入面板
// 快捷键 Cmd+Shift+A / Ctrl+Shift+A 唤起
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
    feedback.value = null;
    await nextTick();
    inputRef.value?.focus();
  }
});

const priorityColor = computed(() => PRIORITY_COLORS[priority.value]);
/** 将 PRIORITY_COLORS token 映射为可用于 inline style 的颜色值 */
const priorityStyle = computed(() => {
  const token = priorityColor.value;
  if (token === "priority-none") return { color: "var(--jt-text-tertiary)" };
  if (token === "info") return { color: "#3B82F6" };
  if (token === "warning") return { color: "var(--jt-warning)" };
  if (token === "error") return { color: "var(--jt-error)" };
  return {};
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
  });

  feedback.value = `✓ 已添加到「${selectedListName.value}」`;

  if (keepOpen) {
    title.value = "";
    priority.value = 0;
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
    :width="480"
    :footer="false"
    :mask-closable="true"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.4)' }"
    modal-class="quick-add-modal"
    wrap-class="quick-add-wrap"
  >
    <div class="quick-add">
      <!-- 主输入行 -->
      <div class="quick-add__input-row">
        <icon-plus :size="20" class="quick-add__icon" />
        <input
          ref="inputRef"
          v-model="title"
          @keydown="onKeyDown"
          class="quick-add__input"
          placeholder="添加任务..."
        />
      </div>

      <!-- 属性行 -->
      <div class="quick-add__attrs">
        <!-- 优先级（纵向 a-select 下拉，参考详情面板） -->
        <a-select
          v-model="priority"
          size="small"
          :trigger-props="{ autoFitPopupMinWidth: true }"
          class="quick-add__select quick-add__select--priority"
          :style="priorityStyle"
        >
          <template #prefix>
            <icon-fire :size="13" />
          </template>
          <a-option v-for="(label, p) in PRIORITY_LABELS" :key="p" :value="Number(p)">
            <span class="quick-add__select-row">
              <PriorityDot :priority="Number(p) as Priority" :size="10" />
              <span>{{ label }}</span>
            </span>
          </a-option>
        </a-select>

        <!-- 清单选择（纵向 a-select 下拉，参考详情面板） -->
        <a-select
          v-model="selectedListId"
          size="small"
          :trigger-props="{ autoFitPopupMinWidth: true }"
          class="quick-add__select quick-add__select--list"
        >
          <template #prefix>
            <span
              v-if="selectedListColor"
              class="quick-add__list-dot"
              :style="{ backgroundColor: selectedListColor }"
            />
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

        <span class="quick-add__hint font-mono">
          ↵ 保存 · ⌘↵ 继续
        </span>
      </div>

      <!-- 反馈条 -->
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
  gap: 12px;
  padding: 16px 20px;
}

.quick-add__icon {
  color: var(--jt-text-tertiary);
}

.quick-add__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 18px;
  font-family: var(--font-body);
  color: inherit;
}

.quick-add__attrs {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 12px;
}

/* QuickAddDialog 内的两个属性 select —— 模仿顶部输入框的简洁风
   （无厚边框、transparent 背景），与 QuickAddDialog 整体调性一致 */
.quick-add__select.arco-select {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0 8px;
  height: 28px;
  font-size: 13px;
  color: var(--jt-text-secondary);
  transition: background-color 0.15s ease, color 0.15s ease;
}

.quick-add__select.arco-select:hover,
.quick-add__select.arco-select.arco-select-focused {
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
  border: none;
  box-shadow: none;
}

/* 触发器内部 prefix 颜色继承父级（用于优先级色点 icon） */
.quick-add__select :deep(.arco-select-view-prefix) {
  color: inherit;
  margin-right: 4px;
  display: inline-flex;
  align-items: center;
}

/* 选项内的色点 + 文字 行内排列（纵向 dropdown 中每项的内容） */
.quick-add__select-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.quick-add__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 让优先级 select 宽度贴合最长项 */
.quick-add__select--priority.arco-select {
  width: auto;
  min-width: 92px;
}
/* 让清单 select 宽度贴合最长清单名 */
.quick-add__select--list.arco-select {
  width: auto;
  min-width: 110px;
  max-width: 200px;
}
.quick-add__select--list :deep(.arco-select-view-value),
.quick-add__select--list :deep(.arco-select-view-input) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.quick-add__hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--jt-text-tertiary);
}

.quick-add__feedback {
  padding: 8px 20px;
  font-size: 13px;
  color: var(--jt-success);
  background-color: rgba(5, 150, 105, 0.08);
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
/* 顶部对齐的命令面板外观 */
.quick-add-wrap .arco-modal {
  top: 80px;
  vertical-align: top;
}
.quick-add-modal .arco-modal-body {
  padding: 0;
}

/* QuickAddDialog 内部 select 弹层 —— 简约、紧凑，与面板风格统一
   select 的 popup 渲染到 body，弹层外层是 .arco-select-dropdown */
.quick-add__select ~ .arco-select-dropdown,
.arco-select-dropdown:has(.quick-add__select-row) {
  border-radius: 10px;
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.06),
    0 1px 2px rgba(0, 0, 0, 0.04);
}

/* popup 内部 list 紧凑 padding */
.quick-add__select ~ .arco-select-dropdown .arco-select-popup-inner,
.arco-select-dropdown:has(.quick-add__select-row) .arco-select-popup-inner {
  padding: 4px !important;
}

/* 选项的视觉（纵向单列） */
.quick-add__select-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* 深色模式适配 */
body[arco-theme="dark"] .quick-add__select ~ .arco-select-dropdown,
body[arco-theme="dark"] .arco-select-dropdown:has(.quick-add__select-row) {
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.4),
    0 1px 2px rgba(0, 0, 0, 0.3);
}
</style>
