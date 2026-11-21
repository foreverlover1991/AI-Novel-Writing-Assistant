import type { BaseMessageChunk } from "@langchain/core/messages";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type {
  AssistantHistoryMessage,
  AssistantIntentCategory,
  AssistantStreamFrame,
} from "@ai-novel/shared/types/assistant";

import { runStructuredPrompt, streamTextPrompt } from "../../prompting/core/promptRunner";
import {
  assistantAnswerComposePrompt,
  assistantDocsSelectPrompt,
  assistantIntentRoutePrompt,
  type AssistantIntentRouteOutput,
} from "../../prompting/prompts/assistant/assistant.prompts";
import {
  collectDiagnostics,
  listDocsCatalog,
  listNovelSummaries,
  novelContext,
  readDocs,
  writingGlossary,
} from "./assistantTools";

export interface AssistantChatInput {
  message: string;
  history: AssistantHistoryMessage[];
  novelId?: string | null;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

export type AssistantFrameEmitter = (frame: AssistantStreamFrame) => void;

function chunkToText(content: BaseMessageChunk["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** 最近 6 轮历史（12 条消息）用于意图路由，避免上下文过长。 */
function recentHistory(history: AssistantHistoryMessage[]): AssistantHistoryMessage[] {
  return history.slice(-12);
}

/**
 * AI 助手编排：意图路由 → 只读工具取证 → 流式作答。
 * 每一步都通过 emit 产出 SSE 帧；意图要求澄清时直接流式反问，不调用任何工具。
 * 全程只读：工具层不含写操作，助手不修改任何业务数据。
 */
export async function runAssistantChat(input: AssistantChatInput, emit: AssistantFrameEmitter): Promise<void> {
  const history = recentHistory(input.history);
  const novels = await listNovelSummaries();

  // 1. 意图路由（纯 AI 结构化输出，无关键词 fallback）。
  const intentResult = await runStructuredPrompt({
    asset: assistantIntentRoutePrompt,
    promptInput: { message: input.message, history, novels },
    options: { provider: input.provider, model: input.model, signal: input.signal, entrypoint: "assistant.intent" },
  });
  const intent: AssistantIntentRouteOutput = intentResult.output;
  emit({
    event: "assistant/intent",
    data: {
      category: intent.category,
      novelId: intent.novelId,
      retrievalQuery: intent.retrievalQuery,
      logSources: intent.logSources,
      needDocSelect: intent.needDocSelect,
      clarification: intent.clarification,
    },
  });

  // 2. 澄清反问：直接流式输出，不调用工具。
  if (intent.clarification) {
    emit({ event: "assistant/delta", data: { text: intent.clarification } });
    emit({ event: "assistant/done", data: { category: intent.category } });
    return;
  }

  // 3. 按分类采集只读证据。
  let evidence = "";
  try {
    evidence = await gatherEvidence(input, intent, emit);
  } catch (error) {
    emit({
      event: "assistant/tool",
      data: { tool: "evidence", status: "error", summary: error instanceof Error ? error.message : "取证失败" },
    });
  }

  // 4. 流式作答。
  const streamed = await streamTextPrompt({
    asset: assistantAnswerComposePrompt,
    promptInput: {
      message: input.message,
      history,
      category: intent.category as AssistantIntentCategory,
      evidence,
    },
    options: {
      provider: input.provider,
      model: input.model,
      temperature: input.temperature,
      signal: input.signal,
      novelId: intent.novelId ?? undefined,
      entrypoint: "assistant.answer",
    },
  });

  for await (const chunk of streamed.stream as AsyncIterable<BaseMessageChunk>) {
    const text = chunkToText(chunk.content);
    if (text) {
      emit({ event: "assistant/delta", data: { text } });
    }
  }
  // 触发完成态（内部做校验/用量结算），失败不阻断已发送内容。
  await streamed.complete.catch(() => undefined);
  emit({ event: "assistant/done", data: { category: intent.category } });
}

async function gatherEvidence(
  input: AssistantChatInput,
  intent: AssistantIntentRouteOutput,
  emit: AssistantFrameEmitter,
): Promise<string> {
  switch (intent.category) {
    case "product_usage": {
      emit({ event: "assistant/tool", data: { tool: "docs", status: "running", summary: "正在检索产品文档" } });
      if (!intent.needDocSelect) {
        emit({ event: "assistant/tool", data: { tool: "docs", status: "skipped", summary: "无需定位具体文档" } });
        return "";
      }
      const catalog = listDocsCatalog();
      const selection = await runStructuredPrompt({
        asset: assistantDocsSelectPrompt,
        promptInput: { message: input.message, catalog },
        options: { provider: input.provider, model: input.model, signal: input.signal, entrypoint: "assistant.docs" },
      });
      const files = selection.output.files;
      if (files.length === 0) {
        emit({ event: "assistant/tool", data: { tool: "docs", status: "done", summary: "未找到相关文档" } });
        return "";
      }
      const docs = readDocs(files);
      emit({ event: "assistant/tool", data: { tool: "docs", status: "done", summary: `已读取 ${files.length} 篇文档` } });
      return docs;
    }
    case "system_diagnosis": {
      const sources = intent.logSources.length > 0 ? intent.logSources : ["runtime_errors", "task_records", "llm_sessions"];
      emit({ event: "assistant/tool", data: { tool: "diagnostics", status: "running", summary: "正在检索日志与任务记录" } });
      const diagnostics = await collectDiagnostics(sources as AssistantIntentRouteOutput["logSources"]);
      emit({
        event: "assistant/tool",
        data: { tool: "diagnostics", status: "done", summary: diagnostics ? "已采集诊断证据" : "近 24 小时未发现错误记录" },
      });
      return diagnostics;
    }
    case "novel_content": {
      const novelId = input.novelId?.trim() || intent.novelId;
      emit({ event: "assistant/tool", data: { tool: "novel", status: "running", summary: "正在读取小说内容" } });
      if (!novelId) {
        emit({ event: "assistant/tool", data: { tool: "novel", status: "skipped", summary: "未指定目标小说" } });
        return "";
      }
      const context = await novelContext(novelId, intent.retrievalQuery);
      emit({ event: "assistant/tool", data: { tool: "novel", status: "done", summary: context ? "已采集小说证据" : "未找到相关内容" } });
      return context;
    }
    case "writing_knowledge": {
      emit({ event: "assistant/tool", data: { tool: "glossary", status: "running", summary: "正在查阅写作术语与指南" } });
      const glossary = writingGlossary();
      emit({ event: "assistant/tool", data: { tool: "glossary", status: "done", summary: glossary ? "已加载写作知识" : "术语表不可用" } });
      return glossary;
    }
    case "chitchat":
    default:
      return "";
  }
}
