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
  /** 消息时间（HH:mm；user 为发送时刻，assistant 为完成时刻） */
  time?: string;
  /** 出错信息（assistant 消息专用） */
  error?: string;
  /** 结束统计（轮数/累计 token） */
  stat?: string;
}

/** 格式化为 HH:mm（入参兼容 Date 或本地字面量时间串） */
function fmtTime(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
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
    case "done": {
      // 用量为 0（端点未回传 usage）时只显示轮数，不显示误导性的 0 tokens
      const tokens = ev.promptTokens + ev.completionTokens;
      last.stat = tokens > 0 ? `${ev.rounds} 轮 · ${tokens} tokens` : `${ev.rounds} 轮`;
      last.time = fmtTime(new Date());
      break;
    }
    case "error":
      last.error = ev.message;
      last.time = fmtTime(new Date());
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
  messages.value.push({ role: "user", content: text, tools: [], time: fmtTime(new Date()) });
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
    // 兜底：异常路径（invoke 抛错）不走 done/error 事件，这里补上完成时间
    const last = messages.value[messages.value.length - 1];
    if (last?.role === "assistant" && !last.time) last.time = fmtTime(new Date());
    scheduleRender(messages.value.length - 1);
    scrollToBottom();
  }
}

/** 开始新对话（旧会话保留在历史里，本地切换为空会话）。
 *  公开给外层（AiAssistantModal 顶栏「新对话」按钮）调用 */
function newChat(): void {
  sessionId.value = null;
  messages.value = [];
  renderedHtml.value = [];
  historyOpen.value = false;
}

/** 切换侧边历史会话列（公开给外层「历史会话」按钮调用） */
function toggleHistory(): void {
  historyOpen.value = !historyOpen.value;
}

defineExpose({ newChat, toggleHistory });

/** 从历史选中会话：加载完整消息（含工具步骤）并切换为续聊模式 */
async function onSelectSession(session: AgentSessionSummary): Promise<void> {
  const res = await getAgentHistory(session.id).catch(() => null);
  if (!res?.ok || !res.messages) return;
  sessionId.value = session.id;
  messages.value = res.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tools: m.tools,
    time: m.createdAt ? fmtTime(m.createdAt) : undefined,
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
    <!-- 侧边历史会话列（列表 → 选择续聊 / 删除；开合由外层「历史会话」按钮控制） -->
    <AgentHistoryPanel v-if="historyOpen" @select="onSelectSession" @close="historyOpen = false" />

    <!-- 对话主体 -->
    <div class="agent-chat__main">
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
        <!-- 用户消息：气泡 + 发送时间 -->
        <div v-if="msg.role === 'user'">
          <div class="agent-chat__bubble">{{ msg.content }}</div>
          <div v-if="msg.time" class="agent-chat__time agent-chat__time--user">{{ msg.time }}</div>
        </div>

        <!-- AI 消息：工具步骤卡 + markdown 正文 -->
        <template v-else>
          <AgentToolCard v-for="step in msg.tools" :key="step.callId" :step="step" />
          <div v-if="renderedHtml[i]" class="agent-chat__md" v-html="renderedHtml[i]"></div>
          <div v-else-if="!msg.tools.length && !msg.error" class="agent-chat__loading">
            <a-spin :size="12" />
          </div>
          <div v-if="msg.error" class="agent-chat__error">{{ msg.error }}</div>
          <!-- 底部信息行：时间 · 轮数/用量 -->
          <div v-if="msg.time || msg.stat" class="agent-chat__stat">
            <template v-if="msg.time">{{ msg.time }}</template>
            <template v-if="msg.time && msg.stat"> · </template>
            <template v-if="msg.stat">{{ msg.stat }}</template>
          </div>
        </template>
      </div>
    </div>

    <!-- 输入区：细边框容器（多行输入 + 底部操作行）；Enter 发送，Shift+Enter 换行 -->
    <div class="agent-chat__input-box">
      <a-textarea
        v-model="input"
        class="agent-chat__textarea"
        placeholder="问我任何关于任务的问题，或让我帮你安排…"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :disabled="loading"
        @keydown.enter.exact.prevent="send()"
      />
      <div class="agent-chat__input-actions">
        <a-button
          type="primary"
          size="small"
          class="agent-chat__send"
          title="发送（Enter）"
          :loading="loading"
          @click="send()"
        >
          <template #icon><icon-send :size="16" :stroke-width="3" /></template>
        </a-button>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.agent-chat {
  display: flex;
  flex-direction: row;
  min-height: 440px;
  max-height: 72vh;
}
.agent-chat__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
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
.agent-chat__time {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  margin-top: 2px;
}
.agent-chat__time--user {
  text-align: right;
}
.agent-chat__input-box {
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  padding: 8px 4px 6px 10px;
  background: var(--jt-surface);
  margin-top: 8px;
}
/* textarea 自身边框去掉，统一用容器边框 */
.agent-chat__input-box :deep(.arco-textarea-wrapper),
.agent-chat__input-box :deep(.arco-textarea) {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 15px;
  line-height: 1.6;
  box-shadow: none;
}
.agent-chat__input-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}
.agent-chat__send {
  flex-shrink: 0;
  height: 30px;
  width: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
