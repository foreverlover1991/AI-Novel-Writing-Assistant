/**
 * AI 助手（只读问答）的共享类型：意图分类、SSE 帧合同、历史消息。
 * 服务端 `server/src/services/assistant` 与前端 `client/src/components/assistant` 共用。
 */

/** 五类助手能力。 */
export type AssistantIntentCategory =
  | "product_usage"
  | "system_diagnosis"
  | "novel_content"
  | "writing_knowledge"
  | "chitchat";

/** 诊断证据来源。 */
export type AssistantLogSource = "runtime_errors" | "task_records" | "llm_sessions";

/** 助手对话历史消息（无持久化，随请求携带）。 */
export interface AssistantHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** 意图路由结果（对应 assistant/intent 帧的 data）。 */
export interface AssistantIntentResult {
  category: AssistantIntentCategory;
  novelId: string | null;
  retrievalQuery: string | null;
  logSources: AssistantLogSource[];
  needDocSelect: boolean;
  clarification: string | null;
}

/** 工具执行进度（对应 assistant/tool 帧的 data）。 */
export interface AssistantToolProgress {
  tool: string;
  status: "running" | "done" | "skipped" | "error";
  summary: string;
}

/** 助手 SSE 帧合同。 */
export type AssistantStreamFrame =
  | { event: "assistant/intent"; data: AssistantIntentResult }
  | { event: "assistant/tool"; data: AssistantToolProgress }
  | { event: "assistant/delta"; data: { text: string } }
  | { event: "assistant/done"; data: { category: AssistantIntentCategory } }
  | { event: "assistant/error"; data: { message: string } }
  | { event: "metadata"; data: Record<string, unknown> };

/** POST /api/assistant/chat 请求体。 */
export interface AssistantChatRequest {
  message: string;
  history?: AssistantHistoryMessage[];
  novelId?: string | null;
}
