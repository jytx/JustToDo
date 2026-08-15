// AI 智能体前端类型（与 api/agent.ts、AgentChat/AgentToolCard 共用）

/** 一次工具调用的展示状态（随 agent 事件流更新） */
export interface ToolStep {
  /** 调用 id（与后端 tool_call_id 配对） */
  callId: string;
  /** 工具名（query_tasks 等） */
  name: string;
  /** 模型传的参数（展开查看用） */
  args: unknown;
  /** null=运行中；true/false=执行结果 */
  ok: boolean | null;
  /** 一句话结果摘要（工具卡直接展示） */
  summary: string;
}
