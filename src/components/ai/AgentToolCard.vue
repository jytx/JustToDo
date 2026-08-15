<script setup lang="ts">
// Agent 工具步骤卡 —— 展示一次工具调用的名称/参数/结果摘要
// 运行态转圈；结束后 ✓/✗ + 一句话结果；点击可展开参数 JSON
import { ref, computed } from "vue";
import type { ToolStep } from "@/types/agent";

const props = defineProps<{ step: ToolStep }>();

/** 工具名的中文标签（无映射时原样显示） */
const TOOL_LABELS: Record<string, string> = {
  query_tasks: "查询任务",
  search_items: "搜索",
  get_task: "查看详情",
  list_folders: "查看清单",
  get_stats: "统计",
  create_task: "创建任务",
  create_note: "创建笔记",
  update_task: "更新任务",
  set_task_done: "完成任务",
};
const label = computed(() => TOOL_LABELS[props.step.name] ?? props.step.name);

const expanded = ref(false);
/** 参数摘要：取常用字段拼一句话，避免整块 JSON 刷屏 */
const argBrief = computed(() => {
  const a = props.step.args as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return "";
  const parts: string[] = [];
  if (typeof a.query === "string") parts.push(`「${a.query}」`);
  if (typeof a.list_name === "string") parts.push(a.list_name);
  if (typeof a.title === "string") parts.push(`「${a.title}」`);
  if (typeof a.due === "string") parts.push(a.due);
  if (typeof a.status === "string" && a.status !== "undone") parts.push(a.status);
  if (typeof a.kind === "string" && a.kind === "note") parts.push("笔记");
  return parts.join(" · ");
});

function onToggle(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="agent-tool" :class="{ 'agent-tool--err': step.ok === false }" @click="onToggle">
    <div class="agent-tool__row">
      <span v-if="step.ok === null" class="agent-tool__spin"><a-spin :size="10" /></span>
      <span v-else class="agent-tool__mark">{{ step.ok ? "✓" : "✗" }}</span>
      <span class="agent-tool__label">{{ label }}</span>
      <span v-if="argBrief" class="agent-tool__args">{{ argBrief }}</span>
      <span class="agent-tool__chevron">{{ expanded ? "▾" : "▸" }}</span>
    </div>
    <div v-if="step.ok !== null && step.summary" class="agent-tool__summary">{{ step.summary }}</div>
    <pre v-if="expanded" class="agent-tool__json">{{ JSON.stringify(step.args, null, 2) }}</pre>
  </div>
</template>

<style scoped>
.agent-tool {
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--jt-text-secondary);
  cursor: pointer;
  margin: 2px 0;
  background: var(--jt-surface);
}
.agent-tool--err {
  border-color: var(--jt-error);
  color: var(--jt-error);
}
.agent-tool__row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.agent-tool__spin,
.agent-tool__mark {
  width: 14px;
  display: inline-flex;
  justify-content: center;
  flex-shrink: 0;
}
.agent-tool__label {
  flex-shrink: 0;
}
.agent-tool__args {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--jt-text-tertiary);
}
.agent-tool__chevron {
  margin-left: auto;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}
.agent-tool__summary {
  margin-top: 2px;
  padding-top: 2px;
  border-top: 1px dashed var(--jt-border);
  color: var(--jt-text-secondary);
}
.agent-tool__json {
  margin: 4px 0 0;
  padding: 6px;
  background: var(--jt-bg-secondary, rgba(0, 0, 0, 0.04));
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
