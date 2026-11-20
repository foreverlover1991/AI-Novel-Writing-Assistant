import { Router } from "express";
import { probeIfEnabled } from "../llm/compatibility/probing";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { PROVIDER_AUTH_MODES } from "@ai-novel/shared/types/llm";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { llmConnectivityService, probeEmbeddingEndpoint } from "../llm/connectivity";
import { getStructuredFallbackSettings, saveStructuredFallbackSettings } from "../llm/structuredFallbackSettings";
import { filterHiddenModels, getProviderModels, parseHiddenModels } from "../llm/modelCatalog";
import { listModelRouteConfigs, MODEL_ROUTE_TASK_TYPES, upsertModelRouteConfig } from "../llm/modelRouter";
import { llmProviderSchema } from "../llm/providerSchema";
import { getProviderEnvApiKey, getProviderEnvModel, isBuiltInProvider, PROVIDERS } from "../llm/providers";
import { authMiddleware } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { validate } from "../middleware/validate";

const router = Router();

const llmTestSchema = z.object({
  provider: llmProviderSchema,
  apiKey: z.string().trim().optional(),
  model: z.string().trim().optional(),
  baseURL: z.string().trim().url("API URL 格式不正确。").optional(),
  authMode: z.enum(PROVIDER_AUTH_MODES).optional(),
  probeMode: z.enum(["plain", "structured", "both"]).optional(),
});

const structuredFallbackSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.union([z.number().int().positive(), z.null()]).optional(),
  retryCount: z.number().int().min(0).max(3).optional(),
});

router.use(authMiddleware);

router.get("/providers", async (_req, res, next) => {
  try {
    const keys = await prisma.aPIKey.findMany({ orderBy: [{ createdAt: "asc" }] });
    const keyMap = new Map(keys.map((item) => [item.provider, item]));

    const builtInEntries = await Promise.all(
      Object.entries(PROVIDERS).map(async ([provider, config]) => {
        const keyConfig = keyMap.get(provider);
        const currentModel = keyConfig?.model?.trim()
          || getProviderEnvModel(provider)
          || config.defaultModel;
        const models = filterHiddenModels(await getProviderModels(provider, {
          apiKey: keyConfig?.key ?? getProviderEnvApiKey(provider),
          baseURL: keyConfig?.baseURL ?? undefined,
          fallbackModel: currentModel,
          fallbackModels: [...config.models, currentModel],
        }), parseHiddenModels(keyConfig?.hiddenModels), currentModel);
        return [provider, {
          name: config.name,
          defaultModel: currentModel,
          models,
        }] as const;
      }),
    );

    const customEntries = await Promise.all(
      keys
        .filter((item) => !isBuiltInProvider(item.provider))
        .map(async (item) => {
          const currentModel = item.model?.trim() || "";
          const models = filterHiddenModels(await getProviderModels(item.provider, {
            apiKey: item.key ?? undefined,
            baseURL: item.baseURL ?? undefined,
            authMode: item.authMode === "x-api-key" || item.authMode === "none" ? item.authMode : "bearer",
            fallbackModel: currentModel,
            fallbackModels: [currentModel],
          }), parseHiddenModels(item.hiddenModels), currentModel);
          return [item.provider, {
            name: item.displayName?.trim() || item.provider,
            defaultModel: currentModel,
            models,
          }] as const;
        }),
    );

    const data = Object.fromEntries([...builtInEntries, ...customEntries]);
    const response: ApiResponse<typeof data> = {
      success: true,
      data,
      message: "获取模型配置成功。",
    };
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
});

router.get("/model-routes", async (_req, res, next) => {
  try {
    const data = {
      taskTypes: MODEL_ROUTE_TASK_TYPES,
      routes: await listModelRouteConfigs(),
    };
    res.status(200).json({
      success: true,
      data,
      message: "模型路由配置已加载。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/model-routes/connectivity", async (_req, res, next) => {
  try {
    const data = await llmConnectivityService.testModelRoutes();
    res.status(200).json({
      success: true,
      data,
      message: "模型路由连通性检测完成。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/structured-fallback", async (_req, res, next) => {
  try {
    const data = await getStructuredFallbackSettings();
    res.status(200).json({
      success: true,
      data,
      message: "结构化备用模型配置已加载。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.put(
  "/structured-fallback",
  validate({ body: structuredFallbackSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof structuredFallbackSchema>;
      if ((body.enabled ?? false) && (!body.provider || !body.model)) {
        throw new AppError("启用结构化备用模型时，provider 和 model 不能为空。", 400);
      }
      const data = await saveStructuredFallbackSettings(body);
      res.status(200).json({
        success: true,
        data,
        message: "结构化备用模型配置已更新。",
      } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  },
);

const modelRouteUpsertSchema = z.object({
  taskType: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.union([z.number().int().positive(), z.null()]).optional(),
  requestProtocol: z.enum(["auto", "openai_compatible", "anthropic"]).optional(),
  structuredResponseFormat: z.enum(["auto", "json_schema", "json_object", "tool_calling", "prompt_json"]).optional(),
});

router.put(
  "/model-routes",
  validate({ body: modelRouteUpsertSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof modelRouteUpsertSchema>;
      await upsertModelRouteConfig(body.taskType, {
        provider: body.provider,
        model: body.model,
        temperature: body.temperature,
        maxTokens: body.maxTokens ?? null,
        requestProtocol: body.requestProtocol,
        structuredResponseFormat: body.structuredResponseFormat,
      });
      void probeIfEnabled({ provider: body.provider, model: body.model, requestProtocol: body.requestProtocol }).catch(() => undefined);
      res.status(200).json({
        success: true,
        message: "模型路由已更新。",
      } satisfies ApiResponse<null>);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/test",
  validate({ body: llmTestSchema }),
  async (req, res, next) => {
    try {
      const { provider, apiKey, model, baseURL, authMode, probeMode } = req.body as z.infer<typeof llmTestSchema>;
      const result = await llmConnectivityService.testConnection({ provider, apiKey, model, baseURL, authMode, probeMode });
      const shouldFail =
        probeMode === "structured"
          ? result.structured?.ok === false
          : probeMode === "plain"
            ? result.plain?.ok === false
            : result.plain?.ok === false && result.structured?.ok === false;
      if (shouldFail) {
        if (/API Key|未配置/.test(result.error ?? "")) {
          next(new AppError(result.error ?? "未配置可用的模型连接。", 400));
          return;
        }
        // 对话探测全部失败时，向量化专用渠道（只有 /embeddings 端点的服务）也会走到这里。
        // 补一次真实的向量化请求识别渠道能力，避免把配置正确的向量服务判成连接失败。
        // 弹窗里留空沿用保存配置时请求不带 key/地址，探测前先回退到已保存记录，
        // 否则缺少鉴权的探测会把配置正确的向量服务判成失败。
        const savedKeyConfig = await prisma.aPIKey.findFirst({ where: { provider } });
        const probeBaseURL = baseURL?.trim() || savedKeyConfig?.baseURL?.trim() || "";
        const savedAuthMode = savedKeyConfig?.authMode === "x-api-key" || savedKeyConfig?.authMode === "none"
          ? savedKeyConfig.authMode
          : undefined;
        if (probeBaseURL) {
          const embedding = await probeEmbeddingEndpoint({
            provider,
            apiKey: apiKey?.trim() || savedKeyConfig?.key || undefined,
            model: model?.trim() || savedKeyConfig?.model?.trim() || undefined,
            baseURL: probeBaseURL,
            authMode: authMode ?? savedAuthMode,
          });
          if (embedding.ok) {
            res.status(200).json({
              success: true,
              data: {
                success: true,
                model: model ?? "",
                latency: embedding.latency ?? 0,
                plain: result.plain,
                structured: result.structured,
                embedding,
                embeddingOnly: true,
              },
              message: "该地址是向量化专用渠道。",
            } satisfies ApiResponse<Record<string, unknown>>);
            return;
          }
        }
        next(new AppError(result.error ?? "模型连通性测试失败。", 400));
        return;
      }
      const response: ApiResponse<{
        success: boolean;
        model: string;
        latency: number;
        plain: typeof result.plain;
        structured: typeof result.structured;
      }> = {
        success: true,
        data: {
          success: result.ok || result.structured?.ok === true,
          model: result.model,
          latency: result.latency ?? 0,
          plain: result.plain,
          structured: result.structured,
        },
        message: "模型连通性与结构化兼容性测试已完成。",
      };
      res.status(200).json(response);
    } catch (error) {
      // 缺少密钥这类配置错误由工厂直接抛出，按用户可执行的提示返回 400，而不是笼统的服务器错误。
      const message = error instanceof Error ? error.message : "";
      if (/API Key|未配置/.test(message)) {
        next(new AppError(message, 400));
        return;
      }
      next(error);
    }
  },
);

export default router;
