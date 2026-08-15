<script setup lang="ts">
// AI 助手弹窗 —— 统一所有 AI 入口
// 用户打开弹窗 → 选择工具/操作 → 输入指令（部分工具）→ 执行 → 查看结果
// 替换原有的 DailySummaryModal，整合总结 + 建任务 + 创建笔记等能力。
//
// 工具复用现有后端命令（ai_summary / ai_summary_scope / ai_parse_task）。
// 入口通过 taskStore.aiSelectedTool 控制默认选中工具。
import { ref, watch, computed } from "vue";
import { Message } from "@arco-design/web-vue";
import { marked } from "marked";
import {
  generateSummary,
  generateScopeSummary,
  parseTask,
  type SummaryScope,
  type ParsedSubtask,
} from "@/api/ai";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import { copyText } from "@/api/db";
import { LIST_COLORS } from "@/utils/colors";
import type { Priority } from "@/types";
import AiBreakdownPreview from "@/components/AiBreakdownPreview.vue";
import AgentChat from "@/components/ai/AgentChat.vue";
import SelectPopover from "@/components/SelectPopover.vue";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ "update:visible": [v: boolean] }>();

const taskStore = useTaskStore();
const listStore = useListStore();
const tagStore = useTagStore();

/** 工具定义 */
interface AiTool {
  value: string;
  label: string;
  desc: string;
  /** 是否需要输入框 */
  needInput: boolean;
  /** 输入框是否多行（extract 粘贴长文本用 textarea） */
  multiline: boolean;
}

const TOOLS: AiTool[] = [
  { value: "agent", label: "智能对话", desc: "像助手一样自由对话，可查询任务、统计分析、管理待办", needInput: false, multiline: false },
  { value: "daily", label: "每日小结", desc: "汇总今天完成的任务和待办", needInput: false, multiline: false },
  { value: "weekly", label: "周报", desc: "汇总本周任务完成情况", needInput: false, multiline: false },
  { value: "list", label: "总结当前清单", desc: "总结当前所在清单的所有任务", needInput: false, multiline: false },
  { value: "tasks", label: "总结选中任务", desc: "总结多选的任务", needInput: false, multiline: false },
  { value: "create", label: "创建条目", desc: "根据当前清单类型自动创建任务或笔记", needInput: true, multiline: false },
  { value: "extract", label: "提取任务", desc: "粘贴会议纪要/邮件，AI 提取行动项", needInput: true, multiline: true },
];

/** 当前选中的工具 */
const selectedTool = ref<string>("agent");
/** 工具下拉选项（SelectPopover 需要 { value, label } 结构） */
const toolOptions = computed(() =>
  TOOLS.map((t) => ({ value: t.value, label: t.label })),
);
/** 当前工具对象 */
const currentTool = computed(() => TOOLS.find((t) => t.value === selectedTool.value) ?? TOOLS[0]);

/** 用户输入 */
const userInput = ref("");
/** 加载状态 */
const loading = ref(false);
/** 流式生成中（loading 期间但有内容在逐字出现） */
const streaming = ref(false);
/** 生成的 Markdown 结果 */
const content = ref("");
/** 错误信息 */
const errorMsg = ref("");
/** 渲染后的 HTML */
const renderedHtml = ref("");
/** 是否正在保存 */
const saving = ref(false);
/** 提取任务预览是否显示（extract 工具专用，嵌入 AiBreakdownPreview） */
const extractPreview = ref(false);

/** 保存按钮文案：跟随当前清单类型 */
const saveLabel = computed(() => {
  const list = listStore.getById(taskStore.currentListId);
  return list?.kind === "note" ? "保存到当前笔记本" : "保存到当前清单";
});

/** 复制按钮状态：复制后短暂显示「已复制」 */
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

/** 复制生成的 Markdown 源文本到系统剪贴板（带图标文字按钮，参考设置页样式） */
async function onCopyResult(): Promise<void> {
  try {
    await copyText(content.value);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
    Message.success("已复制到剪贴板");
  } catch {
    Message.error("复制失败");
  }
}

/** marked 渲染节流：流式期间高频增量全量 parse 会卡，用 150ms 防抖。
 *  流结束后立即渲染一次（拿到完整 content）。 */
let renderTimer: ReturnType<typeof setTimeout> | null = null;
async function renderMarkdown(): Promise<void> {
  const md = content.value;
  renderedHtml.value = md ? await marked.parse(md) : "";
}
function scheduleRender(): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(renderMarkdown, 150);
}
watch(content, () => {
  // 流式期间节流渲染；非流式（一次性赋值）立即渲染
  if (streaming.value) scheduleRender();
  else renderMarkdown();
});

/** 弹窗标题 */
const title = computed(() => "✨ AI 助手");

/** 流式增量回调：累加到 content，触发节流渲染 */
function onStreamDelta(delta: string): void {
  streaming.value = true;
  content.value += delta;
}

/** 执行当前工具 */
async function execute(): Promise<void> {
  loading.value = true;
  streaming.value = false;
  errorMsg.value = "";
  content.value = "";

  const tool = currentTool.value;
  // 智能对话由 AgentChat 组件自治（多轮循环 + 事件流），不走单轮执行流
  if (tool.value === "agent") return;
  try {
    switch (tool.value) {
      case "daily":
      case "weekly": {
        const res = await generateSummary(tool.value as "daily" | "weekly", onStreamDelta);
        if (res.ok && res.content) content.value = res.content;
        else errorMsg.value = res.message ?? "生成失败";
        break;
      }
      case "list": {
        // 优先用 pendingSummaryScope（侧边栏右键传入的具体清单），
        // 没有才用当前视图清单
        const scopeFromCtx = taskStore.pendingSummaryScope;
        let scope: SummaryScope;
        if (scopeFromCtx && (scopeFromCtx.type === "list" || scopeFromCtx.type === "folder")) {
          scope = scopeFromCtx;
        } else {
          const listId = taskStore.currentListId;
          const list = listStore.getById(listId);
          if (!list) {
            errorMsg.value = "无法获取当前清单";
            break;
          }
          scope = {
            type: "list",
            id: listId,
            name: list.name,
            kind: (list.kind ?? "task") as "task" | "note",
          };
        }
        const res = await generateScopeSummary(scope, false, onStreamDelta);
        if (res.empty) {
          errorMsg.value = res.message ?? "该清单暂无内容";
        } else if (res.ok && res.content) {
          content.value = res.content;
        } else {
          errorMsg.value = res.message ?? "生成失败";
        }
        break;
      }
      case "tasks": {
        const scopeFromCtx = taskStore.pendingSummaryScope;
        let scope: SummaryScope;
        if (scopeFromCtx && scopeFromCtx.type === "tasks") {
          scope = scopeFromCtx;
        } else {
          const ids = taskStore.batchSelectedIdsArr;
          if (ids.length === 0) {
            errorMsg.value = "请先多选任务";
            break;
          }
          scope = { type: "tasks", ids };
        }
        const res = await generateScopeSummary(scope, false, onStreamDelta);
        if (res.ok && res.content) content.value = res.content;
        else errorMsg.value = res.message ?? "生成失败";
        break;
      }
      case "create": {
        const input = userInput.value.trim();
        if (!input) {
          errorMsg.value = "请输入内容";
          break;
        }
        // 根据当前清单类型决定建任务还是笔记
        const listId = taskStore.currentListId;
        const currentList = listStore.getById(listId);
        const isNote = currentList?.kind === "note";
        const res = await parseTask(input);
        if (res.ok && res.parsed) {
          const p = res.parsed;
          // 标签按名匹配，不存在自动创建
          const tagIds: string[] = [];
          for (const name of p.tagNames) {
            const trimmed = name.trim();
            if (!trimmed) continue;
            const existing = tagStore.tags.find((t) => t.name === trimmed);
            if (existing) {
              tagIds.push(existing.id);
            } else {
              const created_tag = await tagStore.createTag(trimmed, LIST_COLORS[0]);
              if (created_tag) tagIds.push(created_tag.id);
            }
          }
          // 创建到当前清单/笔记本
          const created = await taskStore.createTask({
            title: p.title || input,
            listId,
            kind: isNote ? "note" : "task",
            priority: isNote ? undefined : (p.priority as Priority) ?? 0,
            dueStartAt: isNote ? undefined : p.dueStartAt,
            dueEndAt: isNote ? undefined : p.dueEndAt,
            tagIds,
          });
          // 写入 note
          if (p.note) {
            await taskStore.updateTask(created.id, { note: p.note });
          }
          content.value = `已创建${isNote ? "笔记" : "任务"}「${p.title || input}」到「${currentList?.name ?? "当前"}」`;
        } else if (res.ok && res.intent === "summarize_list") {
          content.value = "检测到你想总结清单，请选择「总结当前清单」工具";
        } else if (res.ok && res.intent === "smart_summary") {
          content.value = "检测到你想看每日/周报，请选择对应工具";
        } else {
          errorMsg.value = res.message ?? "解析失败";
        }
        break;
      }
      case "extract": {
        const input = userInput.value.trim();
        if (!input) {
          errorMsg.value = "请粘贴要提取的文本";
          break;
        }
        // 显示 AiBreakdownPreview 预览组件（内部自动调 extractTasks）
        extractPreview.value = true;
        break;
      }
    }
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    streaming.value = false;
    loading.value = false;
    taskStore.aiLoading = false;
    // 流式结束/出错后立即渲染一次完整内容（确保最终结果正确显示）
    renderMarkdown();
  }
}

/** 保存结果到当前清单/笔记本（根据清单类型创建任务或笔记） */
async function onSaveAsNote(): Promise<void> {
  if (!content.value || saving.value) return;
  saving.value = true;
  try {
    const html = await marked.parse(content.value);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const tool = currentTool.value;
    const itemTitle = `${tool.label} ${dateStr}`;
    // 保存到当前清单（kind 跟随清单类型）
    const listId = taskStore.currentListId;
    const currentList = listStore.getById(listId);
    const isNote = currentList?.kind === "note";
    const item = await taskStore.createTask({
      title: itemTitle,
      listId,
      kind: isNote ? "note" : "task",
    });
    await taskStore.updateTask(item.id, { note: html });
    Message.success(`已保存到「${currentList?.name ?? "当前清单"}」`);
    emit("update:visible", false);
  } catch (e) {
    Message.error(`保存失败：${String(e)}`);
  } finally {
    saving.value = false;
  }
}

/** 工具切换：清空结果，不自动执行 */
function onToolChange(v: string): void {
  selectedTool.value = v;
  content.value = "";
  errorMsg.value = "";
  userInput.value = "";
  extractPreview.value = false;
}

/** 提取任务确认：把草稿批量创建为独立任务到当前清单（无 parentId） */
async function onExtractConfirm(subs: ParsedSubtask[]): Promise<void> {
  // 智能视图（今天/全部）无 currentListId，兜底用收件箱
  const listId = taskStore.currentListId || "inbox";
  const currentList = listStore.getById(listId);
  const isNote = currentList?.kind === "note";
  for (const sub of subs) {
    const created = await taskStore.createTask({
      title: sub.title.trim(),
      listId,
      kind: isNote ? "note" : "task",
      priority: isNote ? undefined : (sub.priority as Priority),
      dueStartAt: isNote ? undefined : sub.dueStartAt,
      dueEndAt: isNote ? undefined : sub.dueEndAt,
    });
    if (sub.note) {
      await taskStore.updateTask(created.id, { note: sub.note });
    }
  }
  Message.success(`已创建 ${subs.length} 个任务到「${currentList?.name ?? "当前清单"}」`);
  extractPreview.value = false;
  emit("update:visible", false);
}

/** 提取任务取消 */
function onExtractCancel(): void {
  extractPreview.value = false;
}

// 打开时：读取入口设置的默认工具，不自动执行（用户点生成按钮才跑）
watch(
  () => props.visible,
  (v) => {
    if (v) {
      selectedTool.value = taskStore.aiSelectedTool || "agent";
      content.value = "";
      errorMsg.value = "";
      userInput.value = "";
      extractPreview.value = false;
    }
  },
);
</script>

<template>
  <a-modal
    :visible="visible"
    :width="600"
    :footer="false"
    :mask-closable="true"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="ai-assistant-modal"
    wrap-class="ai-assistant-wrap"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <template #title>{{ title }}</template>
    <div class="ai-assistant">
      <!-- 第一行：工具选择（左）+ 生成按钮（右，始终在这一行） -->
      <div class="ai-assistant__controls">
        <div class="ai-assistant__tool-left">
          <SelectPopover
            v-model="selectedTool"
            :options="toolOptions"
            :width="160"
            @update:model-value="onToolChange"
          />
        </div>
        <a-button
          type="outline"
          size="small"
          :loading="loading"
          @click="execute"
        >
          <template #icon><icon-robot :size="14" /></template>
          生成
        </a-button>
      </div>

      <!-- 工具描述 -->
      <p class="ai-assistant__tool-desc">{{ currentTool.desc }}</p>

      <!-- 智能对话（多轮工具循环，独立组件渲染） -->
      <AgentChat v-if="currentTool.value === 'agent'" />

      <!-- 输入框（需要输入的工具才显示，单独一行） -->
      <!-- 多行（extract 粘贴长文本）用 textarea；单行（create 短指令）用 input -->
      <a-textarea
        v-if="currentTool.value !== 'agent' && currentTool.needInput && currentTool.multiline"
        v-model="userInput"
        :placeholder="currentTool.desc"
        :auto-size="{ minRows: 3, maxRows: 8 }"
        allow-clear
        style="margin-bottom: 16px"
      />
      <a-input
        v-else-if="currentTool.value !== 'agent' && currentTool.needInput"
        v-model="userInput"
        :placeholder="currentTool.desc"
        allow-clear
        style="margin-bottom: 16px"
        @keydown.enter="execute"
      />

      <!-- 结果区（智能对话模式由 AgentChat 全权渲染，隐藏单轮结果区） -->
      <div v-if="currentTool.value !== 'agent'" class="ai-assistant__body">
        <!-- 提取任务预览（extract 工具，嵌入 AiBreakdownPreview 组件） -->
        <AiBreakdownPreview
          v-if="extractPreview"
          :source="{ type: 'extract', text: userInput }"
          @confirm="onExtractConfirm"
          @cancel="onExtractCancel"
        />

        <!-- 纯加载中（尚未收到任何流式内容） -->
        <div v-else-if="loading && !content" class="ai-assistant__loading">
          <a-spin />
          <span class="ai-assistant__loading-text">AI 正在生成...</span>
        </div>

        <!-- 错误 -->
        <div v-else-if="errorMsg" class="ai-assistant__error">
          <p>{{ errorMsg }}</p>
          <a-button type="outline" size="small" @click="execute">重试</a-button>
        </div>

        <!-- 结果（含流式生成中：内容 + 角标转圈） -->
        <div v-else-if="content" class="ai-assistant__content">
          <div v-if="streaming" class="ai-assistant__streaming-badge">
            <a-spin :size="12" />
          </div>
          <div v-html="renderedHtml"></div>
        </div>

        <!-- 空状态（需要输入但还没执行） -->
        <div v-else class="ai-assistant__empty">
          <p v-if="currentTool.needInput">在上方输入内容后点「执行」</p>
        </div>
      </div>

      <!-- 底部操作 -->
      <div v-if="!loading && content" class="ai-assistant__footer">
        <a-button type="text" size="small" @click="onCopyResult">
          <template #icon><icon-copy :size="14" /></template>
          {{ copied ? "已复制" : "复制" }}
        </a-button>
        <a-button type="outline" size="small" :loading="saving" @click="onSaveAsNote">
          <template #icon><icon-save :size="14" /></template>
          {{ saveLabel }}
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.ai-assistant {
  padding: 0;
}

.ai-assistant__controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.ai-assistant__tool-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-assistant__tool-desc {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  margin: 0 0 12px;
}

.ai-assistant__input-row {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-bottom: 16px;
}

.ai-assistant__body {
  min-height: 200px;
  max-height: 50vh;
  overflow-y: auto;
}

.ai-assistant__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 0;
}

.ai-assistant__loading-text {
  font-size: 13px;
  color: var(--jt-text-secondary);
}

.ai-assistant__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
  color: var(--jt-error);
  font-size: 13px;
}

.ai-assistant__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--jt-text-tertiary);
  font-size: 13px;
}

/* Markdown 内容渲染 */
.ai-assistant__content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--jt-text-primary);
  position: relative;
}

/* 流式生成中的转圈角标（右上角小 spinner，提示还在生成） */
.ai-assistant__streaming-badge {
  position: absolute;
  top: 0;
  right: 0;
  opacity: 0.5;
}

.ai-assistant__content :deep(h2) {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  margin: 16px 0 8px;
}

.ai-assistant__content :deep(h2:first-child) {
  margin-top: 0;
}

.ai-assistant__content :deep(p) {
  margin: 6px 0;
}

.ai-assistant__content :deep(ul),
.ai-assistant__content :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}

.ai-assistant__content :deep(li) {
  margin: 2px 0;
}

.ai-assistant__content :deep(strong) {
  font-weight: 600;
}

.ai-assistant__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--jt-border);
  margin-top: 12px;
}
</style>
