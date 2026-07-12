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
const showPriorityMenu = ref(false);
const showListMenu = ref(false);
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

const priorityLabel = computed(() => PRIORITY_LABELS[priority.value]);
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
        <!-- 优先级 -->
        <a-dropdown v-model:popup-visible="showPriorityMenu" trigger="click">
          <a-button type="text" size="small" :style="priorityStyle">
            <template #icon><icon-fire /></template>
            {{ priorityLabel }}
          </a-button>
          <template #content>
            <a-dropdown-option
              v-for="(label, p) in PRIORITY_LABELS"
              :key="p"
              @click="priority = Number(p) as Priority"
            >
              <PriorityDot :priority="Number(p) as Priority" :size="10" />
              <span style="margin-left: 6px">{{ label }}</span>
            </a-dropdown-option>
          </template>
        </a-dropdown>

        <!-- 清单选择 -->
        <a-dropdown v-model:popup-visible="showListMenu" trigger="click">
          <a-button type="text" size="small">
            {{ selectedListName }}
          </a-button>
          <template #content>
            <a-dropdown-option
              v-for="list in listStore.sortedLists"
              :key="list.id"
              @click="selectedListId = list.id"
            >
              <span
                class="quick-add__list-dot"
                :style="{ backgroundColor: list.color }"
              />
              <span style="margin-left: 6px">{{ list.name }}</span>
            </a-dropdown-option>
          </template>
        </a-dropdown>

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
  gap: 4px;
  padding: 0 12px 12px;
}

.quick-add__list-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
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
</style>
