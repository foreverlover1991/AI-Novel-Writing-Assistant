import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  AssistantChatRequest,
  AssistantStreamFrame,
} from "@ai-novel/shared/types/assistant";
import { API_BASE_URL } from "@/lib/constants";
import type { ApiHttpError } from "./client";

/**
 * 以 fetch 流式解析 AI 助手 SSE 帧（镜像 streamCreativeHubRun 实现）。
 * 逐帧 yield，调用方按 event 分派更新 UI；abortSignal 用于停止。
 */
export async function* streamAssistantChat(
  payload: AssistantChatRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AssistantStreamFrame> {
  const requestBody: Record<string, unknown> = {
    message: payload.message,
    history: payload.history ?? [],
  };
  if (payload.novelId) {
    requestBody.novelId = payload.novelId;
  }

  const response = await fetch(`${API_BASE_URL}/assistant/chat`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: abortSignal,
  });

  if (!response.ok || !response.body) {
    const details = await response.json().catch(() => undefined) as ApiResponse<unknown> | undefined;
    const title = details?.error || `AI 助手请求失败，状态码 ${response.status}`;
    const message = details?.message && details.message !== title ? `${title} ${details.message}` : title;
    const error = new Error(message) as ApiHttpError;
    error.status = response.status;
    error.details = details;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const rawFrame of frames) {
      const payloadLine = rawFrame.split("\n").find((line) => line.startsWith("data:"));
      if (!payloadLine) {
        continue;
      }
      const rawData = payloadLine.replace("data:", "").trim();
      if (!rawData) {
        continue;
      }
      yield JSON.parse(rawData) as AssistantStreamFrame;
    }
  }
}
