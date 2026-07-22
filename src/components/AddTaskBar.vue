<script setup lang="ts">
// 添加任务栏 —— 底部常驻，聚焦后展开优先级/日期属性行
// 日期入口已统一为 DueDateChip（与详情面板/快捷新建面板使用同一份 DatePopover）
// 属性行还提供「模板」快捷入口：点选模板后直接创建任务（走全局默认清单）
import { ref, computed, nextTick } from "vue";
import { Message } from "@arco-design/web-vue";
import { PRIORITY_LABELS, PRIORITY_COLORS, type Priority } from "@/types";
import { useSettingsStore } from "@/stores/settings";
import { useTemplateStore } from "@/stores/template";
import { todayRange } from "@/utils/date";
import PriorityDot from "./PriorityDot.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import DueDateChip from "./DueDateChip.vue";

defineProps<{
  listId: string;
}>();

const emit = defineEmits<{
  add: [payload: { title: string; priority: Priority; dueStartAt: string | null; dueEndAt: string | null }];
}>();

const settings = useSettingsStore();
const templateStore = useTemplateStore();

/** 模板菜单可见态 */
const showTemplateMenu = ref(false);

/** 内置模板的 emoji 图标（与 TemplateCard 一致；用户自建用 📄）*/
function templateIcon(tpl: { id: string }): string {
  switch (tpl.id) {
    case "tpl-meeting":
      return "📝";
    case "tpl-weekly":
      return "📊";
    case "tpl-codereview":
      return "👀";
    case "tpl-reading":
      return "📖";
    default:
      return "📄";
  }
}

/** 开关开启时，新建任务的默认日期预填为今天（所见即所得，与 store 兜底保持一致）。 */
function defaultDueRange(): [string, string] | [null, null] {
  if (!settings.newTasksDueToday) return [null, null];
  return todayRange();
}

const title = ref("");
const focused = ref(false);
const priority = ref<Priority>(0);
const showPriorityMenu = ref(false);
const [initialStart, initialEnd] = defaultDueRange();
const dueStartAt = ref<string | null>(initialStart);
const dueEndAt = ref<string | null>(initialEnd);

const inputRef = ref<HTMLInputElement | null>(null);

const priorityLabel = computed(() => PRIORITY_LABELS[priority.value] || "无");

/** 把 PRIORITY_COLORS token 映射为可用于 inline style 的 CSS 变量值 */
const priorityStyle = computed(() => {
  const token = PRIORITY_COLORS[priority.value];
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
  emit("add", {
    title: trimmed,
    priority: priority.value,
    dueStartAt: dueStartAt.value,
    dueEndAt: dueEndAt.value,
  });
  // 重置（保持面板打开便于连续录入）
  title.value = "";
  priority.value = 0;
  const [resetStart, resetEnd] = defaultDueRange();
  dueStartAt.value = resetStart;
  dueEndAt.value = resetEnd;
}

/**
 * 快捷应用模板：用模板当前内容直接创建任务（走全局默认清单）
 *
 * 与设置页「应用模板」语义一致：占位符替换 + 创建任务 + 写 note + 打开详情。
 * 不走 AddTaskBar 的 emit add（add 只传 title/priority/due，不带 note）。
 */
async function applyTemplate(tplId: string) {
  showTemplateMenu.value = false;
  const tpl = templateStore.templates.find((t) => t.id === tplId);
  if (!tpl) return;
  try {
    await templateStore.applyTemplate({
      id: tpl.id,
      name: tpl.name,
      title: tpl.title,
      note: tpl.note,
    });
    Message.success("已创建任务");
    // 应用模板后收起属性行（任务已创建并打开详情面板）
    focused.value = false;
  } catch (e) {
    Message.error("应用模板失败：" + String(e));
  }
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
    // 如果优先级/模板下拉还开着，保持聚焦
    if (showPriorityMenu.value || showTemplateMenu.value) {
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

/** DueDateChip 关闭时把焦点拉回输入框 */
function onDateClose() {
  refocusInput();
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
      <MenuPopover v-model:visible="showPriorityMenu">
        <template #trigger>
          <a-button
            type="text"
            size="mini"
            :style="priorityStyle"
            @click="showPriorityMenu = !showPriorityMenu"
          >
            <template #icon><icon-fire /></template>
            {{ priorityLabel }}
          </a-button>
        </template>
        <MenuPopoverItem
          v-for="(label, p) in PRIORITY_LABELS"
          :key="p"
          :active="Number(p) === priority"
          @click="selectPriority(Number(p) as Priority)"
        >
          <PriorityDot :priority="Number(p) as Priority" :size="10" />
          <span>{{ label }}</span>
        </MenuPopoverItem>
      </MenuPopover>

      <!-- 模板快捷入口：popover 弹模板列表，选某项直接应用模板创建任务 -->
      <MenuPopover v-model:visible="showTemplateMenu">
        <template #trigger>
          <a-button
            type="text"
            size="mini"
            :disabled="templateStore.templates.length === 0"
            @click="showTemplateMenu = !showTemplateMenu"
          >
            <template #icon><icon-copy /></template>
            模板
          </a-button>
        </template>
        <MenuPopoverItem
          v-for="tpl in templateStore.sortedTemplates"
          :key="tpl.id"
          @click="applyTemplate(tpl.id)"
        >
          <span class="add-task-bar__tpl-icon">{{ templateIcon(tpl) }}</span>
          <span>{{ tpl.name }}</span>
        </MenuPopoverItem>
      </MenuPopover>

      <DueDateChip
        compact
        :start-iso="dueStartAt"
        :end-iso="dueEndAt"
        @confirm="(s, e) => { dueStartAt = s; dueEndAt = e; onDateClose(); }"
        @clear="() => { dueStartAt = null; dueEndAt = null; onDateClose(); }"
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

/* 模板菜单项的 emoji 图标 */
.add-task-bar__tpl-icon {
  font-size: 14px;
  line-height: 1;
}
</style>