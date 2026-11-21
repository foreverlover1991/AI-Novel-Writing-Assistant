import { useCallback, useRef, useState } from "react";
import type {
  AssistantHistoryMessage,
  AssistantIntentCategory,
  AssistantToolProgress,
} from "@ai-novel/shared/types/assistant";
import { streamAssistantChat } from "@/api/assistant";

export interface AssistantChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  category?: AssistantIntentCategory;
  tools?: AssistantToolProgress[];
  streaming?: boolean;
  error?: boolean;
}

interface UseAssistantChatResult {
  messages: AssistantChatMessage[];
  isStreaming: boolean;
  send: (text: string, novelId?: string | null) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

let idSeed = 0;
function nextId(): string {
  idSeed += 1;
  return `assistant-msg-${idSeed}`;
}

/**
 * AI 助手对话状态机（MVP：无持久化，历史存组件 state，随请求发送）。
 * 逐帧消费 SSE：intent 定分类、tool 更新进度行、delta 累加正文、done 收尾、error 兜底。
 */
export function useAssistantChat(): UseAssistantChatResult {
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setMessages((current) => current.map((message) => (message.streaming ? { ...message, streaming: false } : message)));
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setMessages([]);
  }, []);

  const send = useCallback(async (text: string, novelId?: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    // 组装历史（不含本轮），上限 12 条。
    const history: AssistantHistoryMessage[] = messages
      .filter((message) => message.content.trim())
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.content }));

    const userMessage: AssistantChatMessage = { id: nextId(), role: "user", content: trimmed };
    const assistantMessage: AssistantChatMessage = { id: nextId(), role: "assistant", content: "", tools: [], streaming: true };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (updater: (message: AssistantChatMessage) => AssistantChatMessage) => {
      setMessages((current) => current.map((message) => (message.id === assistantMessage.id ? updater(message) : message)));
    };

    try {
      for await (const frame of streamAssistantChat({ message: trimmed, history, novelId }, controller.signal)) {
        switch (frame.event) {
          case "assistant/intent":
            patch((message) => ({ ...message, category: frame.data.category }));
            break;
          case "assistant/tool":
            patch((message) => {
              const tools = [...(message.tools ?? [])];
              const index = tools.findIndex((tool) => tool.tool === frame.data.tool);
              if (index >= 0) {
                tools[index] = frame.data;
              } else {
                tools.push(frame.data);
              }
              return { ...message, tools };
            });
            break;
          case "assistant/delta":
            patch((message) => ({ ...message, content: message.content + frame.data.text }));
            break;
          case "assistant/done":
            patch((message) => ({ ...message, streaming: false }));
            break;
          case "assistant/error":
            patch((message) => ({ ...message, streaming: false, error: true, content: message.content || frame.data.message }));
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        patch((message) => ({
          ...message,
          streaming: false,
          error: true,
          content: message.content || (error instanceof Error ? error.message : "AI 助手请求失败。"),
        }));
      } else {
        patch((message) => ({ ...message, streaming: false }));
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      setMessages((current) => current.map((message) => (message.id === assistantMessage.id && message.streaming ? { ...message, streaming: false } : message)));
    }
  }, [messages]);

  return { messages, isStreaming, send, stop, clear };
}
