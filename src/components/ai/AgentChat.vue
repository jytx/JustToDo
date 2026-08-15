<script setup lang="ts">
// Agent 智能对话组件 —— 消息流 + 工具步骤卡 + 流式渲染
// 嵌在 AiAssistantModal 的「智能对话」模式下；会话为后端内存态（P1）
import { ref, watch, nextTick, computed } from "vue";
import { marked } from "marked";
import {
  agentChat,
  getAgentHistory,
  type AgentEvent,
  type AgentContext,
  type AgentSessionSummary,
} from "@/api/agent";
import type { ToolStep } from "@/types/agent";
import AgentToolCard from "@/components/ai/AgentToolCard.vue";
import AgentHistoryPanel from "@/components/ai/AgentHistoryPanel.vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";

/** 单条消息（assistant 消息可携带工具步骤序列） */
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  tools: ToolStep[];
  /** 出错信息（assistant 消息专用） */
  error?: string;
  /** 结束统计（轮数/累计 token） */
  stat?: string;
}

const taskStore = useTaskStore();
const listStore = useListStore();

/** 消息列表 */
const messages = ref<ChatMsg[]>([]);
/** 输入框内容 */
const input = ref("");
/** 请求进行中 */
const loading = ref(false);
/** 会话 id（null = 尚未开始，首轮由后端生成） */
const sessionId = ref<string | null>(null);
/** 消息流容器（自动滚动用） */
const listEl = ref<HTMLElement | null>(null);
/** 历史会话面板开关 */
const historyOpen = ref(false);

/** 快捷指令（点击即发送预设消息） */
const QUICK_PROMPTS: string[] = ["今天有什么任务？", "本周完成了多少任务？", "总结一下这个清单"];

/** 当前上下文：所在清单名 + 多选任务标题（拼进后端 system 提示词） */
const context = computed<AgentContext>(() => {
  const list = listStore.getById(taskStore.currentListId);
  const selected = taskStore.selectedTask ? [taskStore.selectedTask.title] : [];
  return {
    currentListName: list?.name,
    selectedTitles: selected,
  };
});

/** 每条 assistant 消息的渲染缓存（key=消息索引，流式期间节流更新） */
const renderedHtml = ref<Record<number, string>>([]);
let renderTimer: ReturnType<typeof setTimeout> | null = null;

/** 流式 markdown 渲染：150ms 防抖全量 parse（与 AiAssistantModal 同模式） */
function scheduleRender(idx: number): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(async () => {
    const md = messages.value[idx]?.content ?? "";
    renderedHtml.value[idx] = md ? await marked.parse(md) : "";
  }, 150);
}

/** 事件回调：把 AgentEvent 流更新到最后一条 assistant 消息上 */
function onEvent(ev: AgentEvent): void {
  const last = messages.value[messages.value.length - 1];
  if (!last || last.role !== "assistant") return;
  switch (ev.type) {
    case "delta":
      last.content += ev.text;
      scheduleRender(messages.value.length - 1);
      break;
    case "tool_start":
      last.tools.push({ callId: ev.callId, name: ev.name, args: ev.args, ok: null, summary: "" });
      break;
    case "tool_end": {
      const step = last.tools.find((t) => t.callId === ev.callId);
      if (step) {
        step.ok = ev.ok;
        step.summary = ev.summary;
      }
      break;
    }
    case "done":
      last.stat = `${ev.rounds} 轮 · ${ev.promptTokens + ev.completionTokens} tokens`;
      break;
    case "error":
      last.error = ev.message;
      break;
  }
}

/** 滚动到底部（新消息/流式增量时） */
async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
}
watch(
  () => messages.value.map((m) => m.content.length + m.tools.length).join(","),
  () => scrollToBottom(),
);

/** 发送一轮对话 */
async function send(preset?: string): Promise<void> {
  const text = (preset ?? input.value).trim();
  if (!text || loading.value) return;
  input.value = "";
  loading.value = true;
  messages.value.push({ role: "user", content: text, tools: [] });
  messages.value.push({ role: "assistant", content: "", tools: [] });
  renderedHtml.value[messages.value.length - 1] = "";

  try {
    const res = await agentChat(text, sessionId.value, context.value, onEvent);
    if (res.ok && res.sessionId) sessionId.value = res.sessionId;
    if (!res.ok && res.message) {
      const last = messages.value[messages.value.length - 1];
      if (!last.error) last.error = res.message;
    }
  } catch (e) {
    const last = messages.value[messages.value.length - 1];
    last.error = String(e);
  } finally {
    loading.value = false;
    scheduleRender(messages.value.length - 1);
    scrollToBottom();
  }
}

/** 开始新对话（旧会话保留在历史里，本地切换为空会话） */
function onNewChat(): void {
  sessionId.value = null;
  messages.value = [];
  renderedHtml.value = [];
  historyOpen.value = false;
}

/** 从历史选中会话：加载完整消息（含工具步骤）并切换为续聊模式 */
async function onSelectSession(session: AgentSessionSummary): Promise<void> {
  const res = await getAgentHistory(session.id).catch(() => null);
  if (!res?.ok || !res.messages) return;
  sessionId.value = session.id;
  messages.value = res.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tools: m.tools,
  }));
  // 历史消息一次性渲染（无流式）
  renderedHtml.value = {};
  for (let i = 0; i < messages.value.length; i++) {
    const m = messages.value[i];
    if (m.role === "assistant" && m.content) {
      renderedHtml.value[i] = await marked.parse(m.content);
    }
  }
  await scrollToBottom();
}
</script>

<template>
  <div class="agent-chat">
    <!-- 顶部：历史会话 + 新对话 -->
    <div class="agent-chat__bar">
      <a-button type="text" size="mini" @click="historyOpen = !historyOpen">
        <template #icon><icon-history :size="13" /></template>
        历史会话
      </a-button>
      <a-button v-if="messages.length" type="text" size="mini" @click="onNewChat">
        <template #icon><icon-refresh :size="13" /></template>
        新对话
      </a-button>
    </div>

    <!-- 历史会话面板（列表 → 选择续聊 / 删除） -->
    <AgentHistoryPanel v-if="historyOpen" @select="onSelectSession" @close="historyOpen = false" />

    <!-- 消息流 -->
    <div ref="listEl" class="agent-chat__list">
      <!-- 空状态：快捷指令 -->
      <div v-if="!messages.length" class="agent-chat__empty">
        <p>我是智能助手，可以查询任务、统计分析、管理待办。</p>
        <div class="agent-chat__quick">
          <a-button
            v-for="q in QUICK_PROMPTS"
            :key="q"
            type="outline"
            size="mini"
            @click="send(q)"
          >
            {{ q }}
          </a-button>
        </div>
      </div>

      <div v-for="(msg, i) in messages" :key="i" class="agent-chat__msg" :class="`agent-chat__msg--${msg.role}`">
        <!-- 用户消息：气泡 -->
        <div v-if="msg.role === 'user'" class="agent-chat__bubble">{{ msg.content }}</div>

        <!-- AI 消息：工具步骤卡 + markdown 正文 -->
        <template v-else>
          <AgentToolCard v-for="step in msg.tools" :key="step.callId" :step="step" />
          <div v-if="renderedHtml[i]" class="agent-chat__md" v-html="renderedHtml[i]"></div>
          <div v-else-if="!msg.tools.length && !msg.error" class="agent-chat__loading">
            <a-spin :size="12" />
          </div>
          <div v-if="msg.error" class="agent-chat__error">{{ msg.error }}</div>
          <div v-if="msg.stat" class="agent-chat__stat">{{ msg.stat }}</div>
        </template>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="agent-chat__input">
      <a-input
        v-model="input"
        placeholder="问我任何关于任务的问题，或让我帮你安排…"
        :disabled="loading"
        allow-clear
        @keydown.enter="send()"
      />
      <a-button type="primary" size="small" :loading="loading" @click="send()">发送</a-button>
    </div>
  </div>
</template>

<style scoped>
.agent-chat {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  max-height: 55vh;
}
.agent-chat__bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 4px;
}
.agent-chat__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 2px;
  min-height: 220px;
}
.agent-chat__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 0;
  color: var(--jt-text-tertiary);
  font-size: 13px;
}
.agent-chat__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.agent-chat__msg {
  margin: 8px 0;
}
.agent-chat__bubble {
  display: inline-block;
  background: var(--jt-accent, #4f46e5);
  color: #fff;
  border-radius: 10px 10px 2px 10px;
  padding: 6px 12px;
  font-size: 13px;
  max-width: 85%;
  margin-left: auto;
  display: block;
  width: fit-content;
  margin-left: auto;
  word-break: break-word;
}
.agent-chat__md {
  font-size: 14px;
  line-height: 1.7;
  color: var(--jt-text-primary);
}
.agent-chat__md :deep(h2),
.agent-chat__md :deep(h3) {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  margin: 12px 0 6px;
}
.agent-chat__md :deep(p) {
  margin: 6px 0;
}
.agent-chat__md :deep(ul),
.agent-chat__md :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}
.agent-chat__md :deep(li) {
  margin: 2px 0;
}
.agent-chat__loading {
  padding: 8px 0;
}
.agent-chat__error {
  color: var(--jt-error);
  font-size: 13px;
  padding: 4px 0;
}
.agent-chat__stat {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  margin-top: 4px;
}
.agent-chat__input {
  display: flex;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--jt-border);
  margin-top: 4px;
}
</style>
