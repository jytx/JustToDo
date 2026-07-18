<script setup lang="ts">
// 全局快速添加 —— 顶部命令面板风格
// 快捷键 Cmd+Shift+A / Ctrl+Shift+A 唤起
// 设计参考 Linear / Things：单一焦点输入 + 紧凑属性 chip + 底部 hint
// 日期入口已统一为 DueDateChip（与详情面板/主面板添加栏使用同一份 DatePopover）
import { ref, watch, nextTick, computed } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { PRIORITY_LABELS, PRIORITY_COLORS, type Priority } from "@/types";
import PriorityDot from "./PriorityDot.vue";
import DueDateChip from "./DueDateChip.vue";

const props = defineProps<{
  modelValue: boolean;
  /** 可选：默认选中的清单 ID（外部指定时优先） */
  defaultListId?: string;
  /** 可选：默认日期（YYYY-MM-DD），会同时作为开始和结束日期（同一天全天） */
  defaultDate?: string | null;
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
/** 优先级 / 清单 popup 开关 —— 点击选项后立即关闭 */
const priorityPopupVisible = ref(false);
const listPopupVisible = ref(false);

function selectPriority(p: Priority) {
  priority.value = p;
  priorityPopupVisible.value = false;
}

function selectList(id: string) {
  selectedListId.value = id;
  listPopupVisible.value = false;
}

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

watch(open, async (isOpen) => {
  if (isOpen) {
    title.value = "";
    priority.value = 0;
    // 优先使用外部传入的默认清单（如果是目录，自动 fallback 到它下面第一个子清单）
    let defaultId: string | null = null;
    if (props.defaultListId) {
      const node = listStore.getById(props.defaultListId);
      if (node) {
        if (node.isFolder) {
          // 目录：递归穿透多层目录，找第一个真实清单
          let cur: string | null = node.id;
          while (cur) {
            const child = actualLists.value.find((l) => l.parentId === cur);
            if (child) {
              defaultId = child.id;
              break;
            }
            // 没有真实清单子节点，尝试下钻到第一个目录子节点
            const folderChild = listStore.sortedLists.find(
              (l) => l.parentId === cur && l.isFolder,
            );
            if (folderChild) cur = folderChild.id;
            else break;
          }
        } else {
          defaultId = node.id;
        }
      }
    }
    selectedListId.value = defaultId ?? firstActualListId();
    // 外部传入默认日期时，作为当天全天任务（start=end=date）；否则无日期
    if (props.defaultDate) {
      dueStartAt.value = props.defaultDate;
      dueEndAt.value = props.defaultDate;
    } else {
      dueStartAt.value = null;
      dueEndAt.value = null;
    }
    feedback.value = null;
    await nextTick();
    inputRef.value?.focus();
  }
});

/** a-range-picker 已退役 —— DueDateChip 直接 emit confirm/clear，这里只保留 state */

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

/** 仅真实清单（排除目录）—— 任务只能附加到清单，不能附加到目录 */
const actualLists = computed(() =>
  listStore.sortedLists.filter((l) => !l.isFolder),
);

/** 在真实清单里查找第一个（按 sortOrder） */
function firstActualListId(): string {
  return actualLists.value[0]?.id ?? "inbox";
}

async function submit(keepOpen: boolean) {
  const trimmed = title.value.trim();
  if (!trimmed) return;

  // 防御：确保 listId 是真实清单而非目录（任务只能附加到清单）
  let targetListId = selectedListId.value;
  const node = listStore.getById(targetListId);
  if (!node || node.isFolder) {
    targetListId = firstActualListId();
    selectedListId.value = targetListId;
  }

  await taskStore.createTask({
    title: trimmed,
    listId: targetListId,
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
        <a-trigger
          v-model:popup-visible="priorityPopupVisible"
          trigger="click"
          position="bl"
          :popup-translate="[0, 4]"
        >
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
                @click="selectPriority(Number(p) as Priority)"
              >
                <PriorityDot :priority="(Number(p) as Priority)" :size="10" />
                <span>{{ label }}</span>
              </button>
            </div>
          </template>
        </a-trigger>

        <!-- 清单 —— 扁平下拉选择（不支持目录嵌套，纯简单列表） -->
        <a-trigger
          v-model:popup-visible="listPopupVisible"
          trigger="click"
          position="bl"
          :popup-translate="[0, 4]"
        >
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
                v-for="list in actualLists"
                :key="list.id"
                type="button"
                class="quick-add__popup-item"
                :class="{ 'quick-add__popup-item--active': list.id === selectedListId }"
                @click="selectList(list.id)"
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

        <!-- 日期 —— 与详情面板一致的 DueDateChip
   chip 在弹窗底部属性行，弹层朝上开避免超出窗口顶部 -->
        <DueDateChip
          compact
          placement="top-left"
          :start-iso="dueStartAt"
          :end-iso="dueEndAt"
          @confirm="(s, e) => { dueStartAt = s; dueEndAt = e; }"
          @clear="() => { dueStartAt = null; dueEndAt = null; }"
        />

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
  flex-wrap: nowrap;
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
