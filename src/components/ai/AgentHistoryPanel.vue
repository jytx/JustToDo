<script setup lang="ts">
// Agent 历史会话面板 —— 会话列表（标题/时间/消息数），选择续聊、删除
import { ref, onMounted } from "vue";
import { Message } from "@arco-design/web-vue";
import {
  listAgentSessions,
  deleteAgentSession,
  type AgentSessionSummary,
} from "@/api/agent";

const emit = defineEmits<{
  /** 选中某个会话（父组件加载消息并切换为续聊模式） */
  select: [session: AgentSessionSummary];
  /** 关闭面板 */
  close: [];
}>();

/** 会话列表 */
const sessions = ref<AgentSessionSummary[]>([]);
/** 加载中 */
const loading = ref(false);

/** 相对时间：今天显示 HH:mm，今年显示 MM-DD，往年带年份 */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 拉取会话列表 */
async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await listAgentSessions();
    if (res.ok && res.sessions) sessions.value = res.sessions;
    else if (res.message) Message.error(res.message);
  } catch (e) {
    Message.error(`加载历史会话失败：${String(e)}`);
  } finally {
    loading.value = false;
  }
}

/** 选中会话 → 通知父组件加载并续聊 */
function onSelect(s: AgentSessionSummary): void {
  emit("select", s);
  emit("close");
}

/** 删除会话（列表内即时移除，不弹确认——会话价值低，误删可重开话题） */
async function onDelete(s: AgentSessionSummary, ev: Event): Promise<void> {
  ev.stopPropagation();
  try {
    const res = await deleteAgentSession(s.id);
    if (res.ok) {
      sessions.value = sessions.value.filter((x) => x.id !== s.id);
    }
  } catch (e) {
    Message.error(`删除会话失败：${String(e)}`);
  }
}

onMounted(load);
</script>

<template>
  <div class="agent-history">
    <div class="agent-history__head">
      <span class="agent-history__title">历史会话</span>
      <a-button type="text" size="mini" @click="emit('close')">
        <template #icon><icon-close :size="13" /></template>
      </a-button>
    </div>

    <div class="agent-history__list">
      <div v-if="loading && !sessions.length" class="agent-history__empty">
        <a-spin :size="14" />
      </div>
      <p v-else-if="!sessions.length" class="agent-history__empty">暂无历史会话</p>

      <div
        v-for="s in sessions"
        :key="s.id"
        class="agent-history__item"
        @click="onSelect(s)"
      >
        <div class="agent-history__item-title">{{ s.title || "（未命名会话）" }}</div>
        <div class="agent-history__item-meta">
          <span>{{ fmtTime(s.updatedAt) }}</span>
          <span>{{ s.messageCount }} 条消息</span>
        </div>
        <button class="agent-history__del" title="删除会话" @click="onDelete(s, $event)">
          <icon-delete :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-history {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--jt-border);
  padding: 4px 6px 8px 2px;
  background: var(--jt-surface-sunken, var(--jt-surface));
}
.agent-history__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.agent-history__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
}
.agent-history__list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.agent-history__empty {
  display: flex;
  justify-content: center;
  padding: 24px 0;
  color: var(--jt-text-tertiary);
  font-size: 12px;
}
.agent-history__item {
  position: relative;
  padding: 6px 26px 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.agent-history__item:hover {
  background: var(--jt-bg-secondary, rgba(0, 0, 0, 0.04));
}
.agent-history__item-title {
  font-size: 13px;
  color: var(--jt-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-history__item-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--jt-text-tertiary);
  margin-top: 2px;
}
.agent-history__del {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: none;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
  opacity: 0;
  display: flex;
}
.agent-history__item:hover .agent-history__del {
  opacity: 1;
}
.agent-history__del:hover {
  color: var(--jt-error);
  background: var(--jt-bg-secondary, rgba(0, 0, 0, 0.06));
}
</style>
