import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import type { AssistantStreamFrame } from "@ai-novel/shared/types/assistant";

import { llmProviderSchema } from "../llm/providerSchema";
import { authMiddleware } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { runAssistantChat } from "../services/assistant/assistantService";

const router = Router();

router.use(authMiddleware);

const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
});

const assistantChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(historyMessageSchema).max(12).default([]),
  novelId: z.string().trim().optional().nullable(),
  provider: llmProviderSchema.optional(),
  model: z.string().trim().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

function writeAssistantFrame(res: Response, frame: AssistantStreamFrame): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function initAssistantSSE(res: Response): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const heartbeat = setInterval(() => {
    writeAssistantFrame(res, { event: "metadata", data: { ping: true } });
  }, 15000);
  return () => clearInterval(heartbeat);
}

/**
 * 只读 AI 助手对话入口。SSE 帧合同见 shared/types/assistant.ts。
 * 助手不修改任何业务数据；创作类请求由回答 Prompt 引导去对应工作台。
 */
router.post("/chat", validate({ body: assistantChatSchema }), async (req, res) => {
  const abortController = new AbortController();
  // POST 流式响应用 res 的 close 事件感知客户端断开（req 的 close 会在请求体读完后立即触发，误中止模型调用）。
  res.once("close", () => abortController.abort());
  const disposeHeartbeat = initAssistantSSE(res);
  try {
    const body = req.body as z.infer<typeof assistantChatSchema>;
    await runAssistantChat(
      {
        message: body.message,
        history: body.history,
        novelId: body.novelId ?? null,
        provider: body.provider,
        model: body.model,
        temperature: body.temperature,
        signal: abortController.signal,
      },
      (frame) => writeAssistantFrame(res, frame),
    );
  } catch (error) {
    writeAssistantFrame(res, {
      event: "assistant/error",
      data: { message: error instanceof Error ? error.message : "AI 助手运行失败。" },
    });
  } finally {
    disposeHeartbeat();
    if (!res.writableEnded) {
      res.end();
    }
  }
});

export default router;
