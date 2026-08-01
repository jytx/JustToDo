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
} from "@/api/ai";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import type { Priority } from "@/types";

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
}

const TOOLS: AiTool[] = [
  { value: "daily", label: "每日小结", desc: "汇总今天完成的任务和待办", needInput: false },
  { value: "weekly", label: "周报", desc: "汇总本周任务完成情况", needInput: false },
  { value: "list", label: "总结当前清单", desc: "总结当前所在清单的所有任务", needInput: false },
  { value: "tasks", label: "总结选中任务", desc: "总结多选的任务", needInput: false },
  { value: "create", label: "创建条目", desc: "根据当前清单类型自动创建任务或笔记", needInput: true },
];

/** 当前选中的工具 */
const selectedTool = ref<string>("daily");
/** 当前工具对象 */
const currentTool = computed(() => TOOLS.find((t) => t.value === selectedTool.value) ?? TOOLS[0]);

/** 用户输入 */
const userInput = ref("");
/** 加载状态 */
const loading = ref(false);
/** 生成的 Markdown 结果 */
const content = ref("");
/** 错误信息 */
const errorMsg = ref("");
/** 渲染后的 HTML */
const renderedHtml = ref("");
/** 是否正在保存为笔记 */
const saving = ref(false);

watch(content, async (md) => {
  renderedHtml.value = md ? await marked.parse(md) : "";
});

/** 弹窗标题 */
const title = computed(() => "✨ AI 助手");

/** 执行当前工具 */
async function execute(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  content.value = "";

  const tool = currentTool.value;
  try {
    switch (tool.value) {
      case "daily":
      case "weekly": {
        const res = await generateSummary(tool.value as "daily" | "weekly");
        if (res.ok && res.content) content.value = res.content;
        else errorMsg.value = res.message ?? "生成失败";
        break;
      }
      case "list": {
        const listId = taskStore.currentListId;
        const list = listStore.getById(listId);
        if (!list) {
          errorMsg.value = "无法获取当前清单";
          break;
        }
        const scope: SummaryScope = {
          type: "list",
          id: listId,
          name: list.name,
          kind: (list.kind ?? "task") as "task" | "note",
        };
        const res = await generateScopeSummary(scope, false);
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
        const ids = taskStore.batchSelectedIdsArr;
        if (ids.length === 0) {
          errorMsg.value = "请先多选任务";
          break;
        }
        const scope: SummaryScope = { type: "tasks", ids };
        const res = await generateScopeSummary(scope, false);
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
              const created_tag = await tagStore.createTag(trimmed);
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
    }
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    loading.value = false;
    taskStore.aiLoading = false;
  }
}

/** 保存为笔记 */
async function onSaveAsNote(): Promise<void> {
  if (!content.value || saving.value) return;
  saving.value = true;
  try {
    const html = await marked.parse(content.value);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const tool = currentTool.value;
    const noteTitle = `${tool.label} ${dateStr}`;
    const note = await taskStore.createTask({
      title: noteTitle,
      listId: "default-notebook",
      kind: "note",
    });
    await taskStore.updateTask(note.id, { note: html });
    Message.success(`已保存为笔记「${noteTitle}」`);
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
}

// 打开时：读取入口设置的默认工具，不自动执行（用户点生成按钮才跑）
watch(
  () => props.visible,
  (v) => {
    if (v) {
      selectedTool.value = taskStore.aiSelectedTool || "daily";
      content.value = "";
      errorMsg.value = "";
      userInput.value = "";
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
      <!-- 工具选择 + 输入区 -->

      <!-- 工具选择 + 输入区 -->
      <div class="ai-assistant__controls">
        <a-select
          v-model="selectedTool"
          size="small"
          style="width: 160px"
          @change="(v: any) => onToolChange(String(v))"
        >
          <a-option v-for="t in TOOLS" :key="t.value" :value="t.value">
            {{ t.label }}
          </a-option>
        </a-select>

        <!-- 不需要输入的工具：选择器右侧直接放生成按钮 -->
        <a-button
          v-if="!currentTool.needInput"
          type="primary"
          size="small"
          :loading="loading"
          @click="execute"
        >
          <template #icon><icon-robot :size="14" /></template>
          生成
        </a-button>

        <span v-if="!currentTool.needInput" class="ai-assistant__tool-desc">{{ currentTool.desc }}</span>

        <!-- 输入框（需要输入的工具才显示） -->
        <div v-if="currentTool.needInput" class="ai-assistant__input-row">
          <a-input
            v-model="userInput"
            :placeholder="currentTool.desc"
            allow-clear
            @keydown.enter="execute"
          />
          <a-button type="primary" size="small" :loading="loading" @click="execute">
            <template #icon><icon-robot :size="14" /></template>
            生成
          </a-button>
        </div>
      </div>

      <!-- 结果区 -->
      <div class="ai-assistant__body">
        <!-- 加载中 -->
        <div v-if="loading" class="ai-assistant__loading">
          <a-spin />
          <span class="ai-assistant__loading-text">AI 正在生成...</span>
        </div>

        <!-- 错误 -->
        <div v-else-if="errorMsg" class="ai-assistant__error">
          <p>{{ errorMsg }}</p>
          <a-button type="outline" size="small" @click="execute">重试</a-button>
        </div>

        <!-- 结果 -->
        <div v-else-if="content" class="ai-assistant__content" v-html="renderedHtml"></div>

        <!-- 空状态（需要输入但还没执行） -->
        <div v-else class="ai-assistant__empty">
          <p v-if="currentTool.needInput">在上方输入内容后点「执行」</p>
        </div>
      </div>

      <!-- 底部操作 -->
      <div v-if="!loading && content" class="ai-assistant__footer">
        <a-button type="outline" size="small" :loading="saving" @click="onSaveAsNote">
          保存为笔记
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
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.ai-assistant__tool-desc {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.ai-assistant__input-row {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
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
