<script setup lang="ts">
// 添加任务栏 —— 底部常驻，聚焦后展开优先级/日期属性行
import { ref, computed, nextTick } from "vue";
import { PRIORITY_LABELS, PRIORITY_COLORS, type Priority } from "@/types";
import PriorityDot from "./PriorityDot.vue";

defineProps<{
  listId: string;
}>();

const emit = defineEmits<{
  add: [payload: { title: string; priority: Priority; dueStartAt: string | null; dueEndAt: string | null }];
}>();

const title = ref("");
const focused = ref(false);
const priority = ref<Priority>(0);
const showPriorityMenu = ref(false);
const dueStartAt = ref<string | null>(null);
const dueEndAt = ref<string | null>(null);

const inputRef = ref<HTMLInputElement | null>(null);

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

const priorityLabel = computed(
  () => PRIORITY_LABELS[priority.value] || "无",
);
const priorityColor = computed(() => PRIORITY_COLORS[priority.value]);
/** 将 PRIORITY_COLORS token 映射为可用于 inline style 的 CSS 变量值 */
const priorityStyle = computed(() => {
  const token = priorityColor.value;
  if (token === "priority-none") return { color: "var(--jt-text-tertiary)" };
  if (token === "info") return { color: "#3B82F6" };
  if (token === "warning") return { color: "var(--jt-warning)" };
  if (token === "error") return { color: "var(--jt-error)" };
  return {};
});

function selectPriority(p: Priority) {
  priority.value = p;
  showPriorityMenu.value = false;
  // 选完优先级后回到输入框
  refocusInput();
}

function submit() {
  const trimmed = title.value.trim();
  if (!trimmed) return;
  emit("add", { title: trimmed, priority: priority.value, dueStartAt: dueStartAt.value, dueEndAt: dueEndAt.value });
  // 重置（保持面板打开便于连续录入）
  title.value = "";
  priority.value = 0;
  dueStartAt.value = null;
  dueEndAt.value = null;
}

/** 把焦点拉回输入框 */
function refocusInput() {
  nextTick(() => {
    inputRef.value?.focus();
  });
}

/** 输入框失焦处理 —— 延迟检查，避免点击属性行/下拉项时过早关闭 */
function handleBlur() {
  setTimeout(() => {
    // 如果此时焦点已经回到输入框（refocusInput 起效），保持聚焦
    if (document.activeElement === inputRef.value) {
      return;
    }
    // 如果优先级下拉还开着，保持聚焦
    if (showPriorityMenu.value) {
      focused.value = true;
      return;
    }
    focused.value = false;
  }, 150);
}

/** 属性行 mousedown：始终阻止默认行为，防止输入框失焦 */
function onAttrMousedown(e: MouseEvent) {
  e.preventDefault();
  if (!focused.value) {
    focused.value = true;
    refocusInput();
  }
}
</script>

<template>
  <div class="add-task-bar" :class="{ 'add-task-bar--focused': focused }">
    <icon-plus :size="18" class="add-task-bar__icon" />
    <input
      ref="inputRef"
      v-model="title"
      class="add-task-bar__input"
      placeholder="添加任务"
      @focus="focused = true"
      @blur="handleBlur"
      @keydown.enter="submit"
    />
    <!-- 优先级 + 日期（flex-wrap 宽度不够时自动换行） -->
    <div
      class="add-task-bar__attrs"
      :class="{ 'add-task-bar__attrs--hidden': !focused }"
      @mousedown="onAttrMousedown"
    >
      <a-dropdown
        v-model:popup-visible="showPriorityMenu"
        trigger="click"
        position="br"
        :popup-offset="4"
      >
        <a-button
          type="text"
          size="mini"
          :style="priorityStyle"
        >
          <template #icon><icon-fire /></template>
          {{ priorityLabel }}
        </a-button>
        <template #content>
          <a-menu
            class="add-task-priority-menu"
            :selected-keys="[String(priority)]"
            @menu-item-click="(key: string) => selectPriority(Number(key) as Priority)"
          >
            <a-menu-item v-for="(label, p) in PRIORITY_LABELS" :key="p">
              <PriorityDot :priority="Number(p) as Priority" :size="10" />
              <span style="margin-left: 8px">{{ label }}</span>
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>

      <a-range-picker
        v-model="dueRangeModel"
        size="mini"
        style="width: 250px"
        format="YYYY-MM-DD"
        :allow-clear="true"
        @popup-visible-change="(v: boolean) => { if (v) { focused = true; } else { refocusInput(); } }"
      />

      <span class="add-task-bar__hint font-mono">⏎</span>
    </div>
  </div>
</template>

<style scoped>
.add-task-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 16px;
  background-color: var(--jt-surface-sunken);
  border-radius: 12px;
  margin: 0 16px 16px;
  transition: all 0.2s ease;
}

.add-task-bar--focused {
  background-color: var(--jt-surface);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--jt-primary) 30%, transparent);
}

.add-task-bar__icon {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}

.add-task-bar__input {
  flex: 1;
  min-width: 120px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: inherit;
  font-family: var(--font-body);
}

.add-task-bar__attrs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
  opacity: 1;
  transition: opacity 0.2s ease;
  pointer-events: auto;
}

/* 未聚焦时隐藏属性行（仅视觉隐藏，仍占位 → 高度不变）
   pointer-events 保持 auto，让用户可以点击属性区来聚焦 */
.add-task-bar__attrs--hidden {
  opacity: 0;
}

.add-task-bar__hint {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  margin-left: 4px;
}
</style>

<!-- 优先级菜单（非 scoped，弹层渲染到 body） -->
<style>
.add-task-priority-menu {
  min-width: 100px;
}
</style>
