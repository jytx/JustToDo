<script setup lang="ts">
// 添加任务栏 —— 底部常驻，聚焦后展开优先级/日期属性行
// 日期入口已统一为 DueDateChip（与详情面板/快捷新建面板使用同一份 DatePopover）
// 属性行还提供「模板」快捷入口：点选模板后直接创建任务（走全局默认清单）
import { ref, computed, nextTick } from "vue";
import { Message } from "@arco-design/web-vue";
import { PRIORITY_LABELS, PRIORITY_COLORS, type Priority } from "@/types";
import { useSettingsStore } from "@/stores/settings";
import { useTemplateStore } from "@/stores/template";
import { useTagStore } from "@/stores/tag";
import { useListStore } from "@/stores/list";
import { useTaskStore } from "@/stores/task";
import { todayRange } from "@/utils/date";
import { LIST_COLORS } from "@/utils/colors";
import { parseTask } from "@/api/ai";
import PriorityDot from "./PriorityDot.vue";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import DueDateChip from "./DueDateChip.vue";
import TagSelectPopover from "./TagSelectPopover.vue";

const props = defineProps<{
  listId: string;
  /** 实体类型：'task'（默认）渲染完整属性行；'note' 隐藏日期/模板，placeholder 改为笔记 */
  kind?: "task" | "note";
}>();

/** 笔记模式：隐藏日期，placeholder 改为「添加笔记」，模板列表只列笔记模板 */
const isNote = computed(() => props.kind === "note");

/** 当前模式下可用的模板列表（任务模式列任务模板，笔记模式列笔记模板） */
const availableTemplates = computed(() =>
  isNote.value ? templateStore.noteTemplates : templateStore.taskTemplates,
);

const emit = defineEmits<{
  add: [payload: { title: string; priority: Priority; dueStartAt: string | null; dueEndAt: string | null; tagIds: string[]; note?: string }];
}>();

const settings = useSettingsStore();
const templateStore = useTemplateStore();
const tagStore = useTagStore();
const listStore = useListStore();
const taskStore = useTaskStore();

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
/** 选中的标签 ID 数组 —— submit 时随 payload 一起提交，由父视图透传给 createTask */
const selectedTagIds = ref<string[]>([]);
/** AI 解析生成的任务详情（HTML），submit 时随 payload 一起提交。submit 后清空 */
const pendingNote = ref<string>("");
/** 标签下拉弹层是否打开 —— handleBlur 据此在打开时保持输入框聚焦 */
const tagPopoverVisible = ref(false);

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
    tagIds: [...selectedTagIds.value],
    note: pendingNote.value || undefined,
  });
  // 重置（保持面板打开便于连续录入）
  title.value = "";
  priority.value = 0;
  const [resetStart, resetEnd] = defaultDueRange();
  dueStartAt.value = resetStart;
  dueEndAt.value = resetEnd;
  selectedTagIds.value = [];
  pendingNote.value = "";
}

// ─── AI 自然语言解析（仅任务模式 + AI 启用时可用）───
/** 解析中状态（按钮 loading） */
const aiParsing = ref(false);

/** AI 是否可用（AI 启用 + 任务模式） */
const aiAvailable = computed(() => settings.aiEnabled && !isNote.value);

/**
 * AI 解析自然语言输入：调 parseTask → 填充属性 → 直接创建任务。
 * 解析失败时保留原输入，用户可手动回车创建。
 */
async function onAiParse(): Promise<void> {
  const trimmed = title.value.trim();
  if (!trimmed || aiParsing.value) return;
  aiParsing.value = true;
  try {
    const res = await parseTask(trimmed);
    if (res.ok && res.intent === "create_task" && res.parsed) {
      // 意图：建任务 → 填充属性 + 直接创建
      const p = res.parsed;
      if (p.title) title.value = p.title;
      priority.value = (p.priority as Priority) ?? 0;
      dueStartAt.value = p.dueStartAt ?? null;
      dueEndAt.value = p.dueEndAt ?? null;
      if (p.tagNames.length > 0) {
        const ids = await resolveTagIds(p.tagNames);
        selectedTagIds.value = ids;
      }
      pendingNote.value = p.note || "";
      submit();
    } else if (res.ok && res.intent === "summarize_list") {
      // 意图：总结当前清单 → 触发 AI 总结（复用已有链路）
      const list = listStore.getById(props.listId);
      if (list) {
        taskStore.pendingSummaryScope = {
          type: "list",
          id: props.listId,
          name: list.name,
          kind: (list.kind ?? "task") as "task" | "note",
        };
        Message.info("正在总结当前清单...");
      } else {
        Message.error("无法获取当前清单信息");
      }
      // 清空输入框（总结不是建任务）
      title.value = "";
    } else if (res.ok && res.intent === "smart_summary") {
      // 意图：每日/周报 → 清空 pendingSummaryScope（走 smart 模式）+ 触发总结
      taskStore.pendingSummaryScope = null;
      Message.info(res.mode === "weekly" ? "正在生成本周周报..." : "正在生成今日小结...");
      title.value = "";
    } else if (res.ok && res.intent === "create_note" && res.parsed) {
      // 意图：创建笔记 → 创建到默认笔记本 + 写入 note + 标签
      const p = res.parsed;
      const tagIds = p.tagNames.length > 0 ? await resolveTagIds(p.tagNames) : [];
      const note = await taskStore.createTask({
        title: p.title || trimmed,
        listId: "default-notebook",
        kind: "note",
        tagIds,
      });
      if (p.note) {
        await taskStore.updateTask(note.id, { note: p.note });
      }
      Message.success("笔记已创建");
      title.value = "";
    } else if (res.fallbackTitle) {
      Message.info(res.message ?? "暂不支持此操作，已保留原输入");
    } else {
      Message.error(res.message ?? "AI 解析失败");
    }
  } catch (e) {
    Message.error(`AI 解析失败：${String(e)}`);
  } finally {
    aiParsing.value = false;
    refocusInput();
  }
}

/**
 * 把标签名列表解析成 tagIds：已存在的按名匹配，不存在的自动创建。
 */
async function resolveTagIds(names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    // 先在已有标签里按名找
    const existing = tagStore.tags.find((t) => t.name === trimmed);
    if (existing) {
      ids.push(existing.id);
    } else {
      // 不存在则创建
      const created = await tagStore.createTag(trimmed, LIST_COLORS[0]);
      if (created) ids.push(created.id);
    }
  }
  return ids;
}

/**
 * 快捷应用模板：用模板当前内容直接创建条目（任务走全局默认清单，笔记走当前笔记本/默认笔记本）。
 *
 * 与设置页「应用模板」语义一致：占位符替换 + 创建条目 + 写 note + 打开详情。
 * 不走 AddTaskBar 的 emit add（add 只传 title/priority/due，不带 note）。
 */
async function applyTemplate(tplId: string) {
  showTemplateMenu.value = false;
  const tpl = templateStore.templates.find((t) => t.id === tplId);
  if (!tpl) return;
  try {
    // 笔记模板落到当前清单/笔记本（保持 UI 直觉）；
    // 任务模板仍走全局默认清单，避免覆盖用户设定的"任务模板默认清单"
    const targetListId = tpl.kind === "note" ? props.listId : undefined;
    await templateStore.applyTemplate(
      {
        id: tpl.id,
        name: tpl.name,
        title: tpl.title,
        note: tpl.note,
        kind: tpl.kind,
      },
      targetListId,
    );
    Message.success(isNote.value ? "已创建笔记" : "已创建任务");
    // 应用模板后收起属性行（条目已创建并打开详情面板）
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
    // 如果优先级/模板/标签下拉还开着，保持聚焦
    if (showPriorityMenu.value || showTemplateMenu.value || tagPopoverVisible.value) {
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
    <!-- 第一行：标题输入区（左侧 + 标记 + 输入框）。
         + 独立成元素以便放大字号（placeholder 内文字无法单独放大） -->
    <div class="add-task-bar__main">
      <span class="add-task-bar__plus" aria-hidden="true">+</span>
      <input
        ref="inputRef"
        v-model="title"
        class="add-task-bar__input"
        :placeholder="isNote ? '添加笔记' : '添加任务'"
        @focus="focused = true"
        @blur="handleBlur"
        @keydown.enter="submit"
      />
    </div>
    <!-- 第二行：功能性属性（AI 解析 / 优先级 / 模板 / 日期 / 标签），聚焦时显示 -->
    <div
      class="add-task-bar__attrs"
      :class="{ 'add-task-bar__attrs--hidden': !focused }"
      @mousedown="onAttrMousedown"
    >
      <!-- AI 自然语言解析按钮（仅任务模式 + AI 启用）。
           点击解析输入，填充属性栏待确认，不直接创建。 -->
      <button
        v-if="aiAvailable"
        class="add-task-bar__ai-btn"
        :class="{ 'add-task-bar__ai-btn--loading': aiParsing }"
        :disabled="aiParsing || !title.trim()"
        :title="'AI 解析（如：明天3点开会 #工作 高优）'"
        @click="onAiParse"
      >
        <icon-robot :size="16" />
      </button>

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

      <!-- 模板快捷入口：popover 弹模板列表，选某项直接应用模板创建条目。
           列表按当前 kind 过滤：任务模式只列任务模板，笔记模式只列笔记模板。 -->
      <MenuPopover v-model:visible="showTemplateMenu">
        <template #trigger>
          <a-button
            type="text"
            size="mini"
            :disabled="availableTemplates.length === 0"
            @click="showTemplateMenu = !showTemplateMenu"
          >
            <template #icon><icon-copy /></template>
            模板
          </a-button>
        </template>
        <MenuPopoverItem
          v-for="tpl in availableTemplates"
          :key="tpl.id"
          @click="applyTemplate(tpl.id)"
        >
          <span class="add-task-bar__tpl-icon">{{ templateIcon(tpl) }}</span>
          <span>{{ tpl.name }}</span>
        </MenuPopoverItem>
      </MenuPopover>

      <DueDateChip
        v-if="!isNote"
        compact
        :start-iso="dueStartAt"
        :end-iso="dueEndAt"
        @confirm="(s, e) => { dueStartAt = s; dueEndAt = e; onDateClose(); }"
        @clear="() => { dueStartAt = null; dueEndAt = null; onDateClose(); }"
      />

      <!-- 标签：点开选已有/新建，已选以小 chip 平铺在属性行 -->
      <TagSelectPopover
        v-model:selectedTagIds="selectedTagIds"
        variant="text"
        @open-change="(v) => (tagPopoverVisible = v)"
      />
    </div>
  </div>
</template>

<style scoped>
.add-task-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 16px;
  background-color: var(--jt-surface-sunken);
  border-radius: 12px;
  margin: 0 16px 16px;
  transition: all 0.2s ease;
}

/* 第一行：+ 标记叠加在输入框左侧（绝对定位、不占布局），输入框占满整行可输入 */
.add-task-bar__main {
  position: relative;
  display: flex;
  align-items: center;
}

.add-task-bar--focused {
  background-color: var(--jt-surface);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--jt-primary) 30%, transparent);
}

/* 左侧 + 标记：绝对定位叠加在输入框上方，pointer-events:none 让点击穿透到 input，
   这样 + 区域也可点击输入；字号偏大醒目，输入文字靠 input 的 padding-left 让位 */
.add-task-bar__plus {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  font-size: 22px;
  line-height: 1;
  font-weight: 300;
  color: var(--jt-text-tertiary);
  pointer-events: none;
  user-select: none;
}

.add-task-bar__input {
  flex: 1;
  min-width: 120px;
  /* 左侧给叠加的 + 让出视觉空间，避免输入文字与 + 重叠 */
  padding-left: 20px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: inherit;
  font-family: var(--font-body);
}

/* AI 自然语言解析按钮：紧贴输入框右侧，弱视觉，hover 强调 */
.add-task-bar__ai-btn {
  flex-shrink: 0;
  margin: 0;
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  border-radius: 6px;
  transition: all 0.15s ease;
}

.add-task-bar__ai-btn:hover:not(:disabled) {
  color: var(--jt-primary);
  background-color: var(--jt-accent-soft);
}

.add-task-bar__ai-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-task-bar__ai-btn--loading {
  animation: ai-btn-spin 1s linear infinite;
}

@keyframes ai-btn-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.add-task-bar__attrs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  /* 第一行已无前置图标，第二行与输入框文字左侧对齐 */
  padding-left: 0;
  opacity: 1;
  transition: opacity 0.2s ease;
  pointer-events: auto;
}

/* 未聚焦时隐藏属性行（仅视觉隐藏，仍占位 → 高度不变）
   pointer-events 保持 auto，让用户可以点击属性区来聚焦 */
.add-task-bar__attrs--hidden {
  opacity: 0;
}

/* 模板菜单项的 emoji 图标 */
.add-task-bar__tpl-icon {
  font-size: 14px;
  line-height: 1;
}
</style>