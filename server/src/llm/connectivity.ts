import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { LLMProvider, ProviderAuthMode } from "@ai-novel/shared/types/llm";
import type {
  ModelRouteRequestProtocol,
  ModelRouteStructuredResponseFormat,
  ModelRouteTaskType,
} from "@ai-novel/shared/types/novel";
import { getLLM, resolveLLMClientOptions } from "./factory";
import { extractReasoningTextFromChunk } from "./reasoning";
import {
  MODEL_ROUTE_TASK_TYPES,
  resolveModel,
  toStructuredOutputStrategy,
  upsertModelRouteConfig,
} from "./modelRouter";
import { invokeStructuredLlmDetailed, summarizeStructuredOutputFailure } from "./structuredInvoke";
import { buildProviderModelHeaders } from "./modelCatalog";
import { normalizeBaseURL } from "./providers";
import { toText } from "../services/novel/novelP0Utils";
import {
  resolveStructuredOutputProfile,
  selectStructuredOutputStrategy,
  structuredStrategySequence,
  type StructuredOutputStrategy,
} from "./structuredOutput";

export type ConnectivityProbeMode = "plain" | "structured" | "both";

const STRUCTURED_PROBE_SCHEMA = z.object({
  status: z.literal("ok"),
});

// 思考型模型会先把输出额度花在推理上，探测预算过小会把可用渠道误判成不可用。
const PLAIN_PROBE_MAX_TOKENS = 512;
const STRUCTURED_PROBE_MAX_TOKENS = 1024;

const PROTOCOL_LABELS: Record<ModelRouteRequestProtocol, string> = {
  auto: "自动协议",
  openai_compatible: "OpenAI 兼容协议",
  anthropic: "Anthropic 协议",
};

export interface ConnectivityProbeStatus {
  ok: boolean;
  latency: number | null;
  error: string | null;
  requestProtocol: ModelRouteRequestProtocol | null;
}

export interface StructuredConnectivityProbeStatus extends ConnectivityProbeStatus {
  strategy: string | null;
  reasoningForcedOff: boolean;
  fallbackAvailable: boolean;
  fallbackUsed: boolean;
  errorCategory: string | null;
  nativeJsonObject: boolean;
  nativeJsonSchema: boolean;
  profileFamily: string | null;
}

export interface LLMConnectivityStatus extends ConnectivityProbeStatus {
  provider: LLMProvider;
  model: string;
  plain: ConnectivityProbeStatus | null;
  structured: StructuredConnectivityProbeStatus | null;
  /** 仅在厂商检测入口的增强路径上填充：向量化端点的真实请求结果。 */
  embedding?: EmbeddingProbeStatus | null;
  /** 为 true 表示该地址只提供向量化能力，对话与结构化接口不可用。 */
  embeddingOnly?: boolean;
}

export interface EmbeddingProbeStatus {
  ok: boolean;
  latency: number | null;
  error: string | null;
  endpoint: string | null;
}

export interface ModelRouteConnectivityStatus extends LLMConnectivityStatus {
  taskType: ModelRouteTaskType;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "连接测试失败。";
}

interface ProbeAttemptFailure {
  requestProtocol: ModelRouteRequestProtocol;
  error: string;
}

/**
 * 一次检测会按顺序尝试多个请求协议，只保留最后一个错误会让用户看到与自身配置无关的
 * 协议报错，因此按协议分别列出失败原因。
 */
function summarizeProbeFailures(attempts: ProbeAttemptFailure[]): string {
  const lines: string[] = [];
  for (const attempt of attempts) {
    const line = `${PROTOCOL_LABELS[attempt.requestProtocol]}：${attempt.error}`;
    if (!lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines.join("；");
}

function withProbeFailureSummary(
  status: LLMConnectivityStatus | null,
  attempts: ProbeAttemptFailure[],
): LLMConnectivityStatus | null {
  if (!status || status.ok || attempts.length === 0) {
    return status;
  }
  const error = summarizeProbeFailures(attempts);
  return {
    ...status,
    error,
    plain: status.plain ? { ...status.plain, error } : null,
    structured: status.structured ? { ...status.structured, error } : null,
  };
}

function getProtocolCandidates(preferred?: ModelRouteRequestProtocol): ModelRouteRequestProtocol[] {
  if (preferred === "openai_compatible" || preferred === "anthropic") {
    return [preferred, preferred === "anthropic" ? "openai_compatible" : "anthropic"];
  }
  return ["openai_compatible", "anthropic"];
}

function getStructuredFormatCandidates(input: {
  provider: LLMProvider;
  model?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  requestProtocol: ModelRouteRequestProtocol;
  preferred?: ModelRouteStructuredResponseFormat;
}): ModelRouteStructuredResponseFormat[] {
  if (input.requestProtocol === "anthropic") {
    return ["prompt_json"];
  }
  const profile = resolveStructuredOutputProfile({
    provider: input.provider,
    model: input.model,
    baseURL: input.baseURL,
    requestProtocol: input.requestProtocol,
    executionMode: "structured",
  });
  const fallbackOrder = structuredStrategySequence(profile, STRUCTURED_PROBE_SCHEMA);
  const preferred = input.preferred;
  if (preferred === "json_schema" || preferred === "json_object" || preferred === "tool_calling" || preferred === "prompt_json") {
    return [preferred, ...fallbackOrder].filter((value, index, array) => array.indexOf(value) === index);
  }
  return fallbackOrder;
}

async function testPlainConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  requestProtocol?: ModelRouteRequestProtocol;
}): Promise<LLMConnectivityStatus> {
  try {
    const resolved = await resolveLLMClientOptions(input.provider, {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      authMode: input.authMode,
      model: input.model,
      temperature: 0.1,
      maxTokens: PLAIN_PROBE_MAX_TOKENS,
      requestProtocol: input.requestProtocol,
    });
    const llm = await getLLM(input.provider, {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      authMode: input.authMode,
      model: resolved.model,
      temperature: 0.1,
      maxTokens: PLAIN_PROBE_MAX_TOKENS,
      requestProtocol: resolved.requestProtocol,
    });
    const start = Date.now();
    const stream = await llm.stream([new HumanMessage("请只回复 ok")]);
    let content = "";
    let reasoning = "";
    for await (const chunk of stream) {
      content += toText(chunk.content);
      reasoning += extractReasoningTextFromChunk(chunk);
    }
    // 推理内容已经证明请求被模型处理，不能因为它占满额度就判渠道不可用。
    if (!content.trim() && !reasoning.trim()) {
      throw new Error("模型连接已建立，但返回了空正文，无法确认渠道可用。请检查渠道协议、模型能力及思考设置。");
    }
    const plain = {
      ok: true,
      latency: Date.now() - start,
      error: null,
      requestProtocol: resolved.requestProtocol,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: plain.ok,
      latency: plain.latency,
      error: plain.error,
      requestProtocol: plain.requestProtocol,
      plain,
      structured: null,
    };
  } catch (error) {
    const plain = {
      ok: false,
      latency: null,
      error: toErrorMessage(error),
      requestProtocol: input.requestProtocol ?? null,
    };
    return {
      provider: input.provider,
      model: input.model?.trim() || "",
      ok: plain.ok,
      latency: plain.latency,
      error: plain.error,
      requestProtocol: plain.requestProtocol,
      plain,
      structured: null,
    };
  }
}

async function testStructuredConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredResponseFormat?: ModelRouteStructuredResponseFormat;
}): Promise<LLMConnectivityStatus> {
  const resolved = await resolveLLMClientOptions(input.provider, {
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    authMode: input.authMode,
    model: input.model,
    temperature: 0.2,
    maxTokens: STRUCTURED_PROBE_MAX_TOKENS,
    requestProtocol: input.requestProtocol,
    structuredStrategy: toStructuredOutputStrategy(input.structuredResponseFormat ?? "auto") ?? undefined,
    executionMode: "plain",
  });
  try {
    const startedAt = Date.now();
    const result = await invokeStructuredLlmDetailed({
      provider: resolved.provider,
      model: resolved.model,
      apiKey: input.apiKey,
      baseURL: input.baseURL ?? resolved.baseURL,
      authMode: input.authMode ?? resolved.authMode,
      temperature: 0.2,
      maxTokens: STRUCTURED_PROBE_MAX_TOKENS,
      taskType: "planner",
      requestProtocol: resolved.requestProtocol,
      structuredStrategy: toStructuredOutputStrategy(input.structuredResponseFormat ?? "auto") ?? undefined,
      label: "llm.connectivity.structured_probe",
      schema: STRUCTURED_PROBE_SCHEMA,
      messages: [
        new SystemMessage("你正在执行结构化输出兼容性探针。必须只输出合法 JSON。"),
        new HumanMessage("请输出一个 JSON 对象，字段 status 的值必须是 ok。"),
      ],
      maxRepairAttempts: 1,
      disableFallbackModel: true,
    });
    const structured: StructuredConnectivityProbeStatus = {
      ok: true,
      latency: Date.now() - startedAt,
      error: null,
      requestProtocol: resolved.requestProtocol,
      strategy: result.diagnostics.strategy,
      reasoningForcedOff: result.diagnostics.reasoningForcedOff,
      fallbackAvailable: result.diagnostics.fallbackAvailable,
      fallbackUsed: result.diagnostics.fallbackUsed,
      errorCategory: null,
      nativeJsonObject: result.diagnostics.profile.nativeJsonObject,
      nativeJsonSchema: result.diagnostics.profile.nativeJsonSchema,
      profileFamily: result.diagnostics.profile.family,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: structured.ok,
      latency: structured.latency,
      error: structured.error,
      requestProtocol: structured.requestProtocol,
      plain: null,
      structured,
    };
  } catch (error) {
    const summary = summarizeStructuredOutputFailure({
      error,
      fallbackAvailable: false,
    });
    const structured: StructuredConnectivityProbeStatus = {
      ok: false,
      latency: null,
      error: toErrorMessage(error),
      requestProtocol: input.requestProtocol ?? resolved.requestProtocol,
      strategy: null,
      reasoningForcedOff: false,
      fallbackAvailable: false,
      fallbackUsed: false,
      errorCategory: summary.category,
      nativeJsonObject: false,
      nativeJsonSchema: false,
      profileFamily: null,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: structured.ok,
      latency: structured.latency,
      error: structured.error,
      requestProtocol: structured.requestProtocol,
      plain: null,
      structured,
    };
  }
}

async function mergeProbeStatuses(input: {
  provider: LLMProvider;
  model?: string;
  plain: LLMConnectivityStatus | null;
  structured: LLMConnectivityStatus | null;
}): Promise<LLMConnectivityStatus> {
  const provider = input.plain?.provider ?? input.structured?.provider ?? input.provider;
  const model = input.plain?.model ?? input.structured?.model ?? input.model?.trim() ?? "";
  const top = input.plain?.plain ?? input.structured?.structured ?? {
    ok: false,
    latency: null,
    error: "连接测试失败。",
    requestProtocol: null,
  };
  return {
    provider,
    model,
    ok: top.ok,
    latency: top.latency,
    error: top.error,
    requestProtocol: top.requestProtocol,
    plain: input.plain?.plain ?? null,
    structured: input.structured?.structured ?? null,
  };
}

async function testConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  probeMode?: ConnectivityProbeMode;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredResponseFormat?: ModelRouteStructuredResponseFormat;
}): Promise<LLMConnectivityStatus> {
  const probeMode = input.probeMode ?? "both";
  let plain: LLMConnectivityStatus | null = null;
  let structured: LLMConnectivityStatus | null = null;
  const plainAttempts: ProbeAttemptFailure[] = [];
  const structuredAttempts: ProbeAttemptFailure[] = [];
  if (probeMode === "plain" || probeMode === "both") {
    for (const requestProtocol of getProtocolCandidates(input.requestProtocol)) {
      plain = await testPlainConnection({ ...input, requestProtocol });
      if (plain.ok) {
        break;
      }
      plainAttempts.push({
        requestProtocol: plain.plain?.requestProtocol ?? requestProtocol,
        error: plain.plain?.error ?? "连接测试失败。",
      });
    }
    plain = withProbeFailureSummary(plain, plainAttempts);
  }
  if (probeMode === "structured" || probeMode === "both") {
    for (const requestProtocol of getProtocolCandidates(input.requestProtocol)) {
      for (const structuredResponseFormat of getStructuredFormatCandidates({
        provider: input.provider,
        model: input.model,
        baseURL: input.baseURL,
        requestProtocol,
        preferred: input.structuredResponseFormat,
      })) {
        structured = await testStructuredConnection({ ...input, requestProtocol, structuredResponseFormat });
        if (structured.ok) {
          break;
        }
      }
      if (structured?.ok) {
        break;
      }
      structuredAttempts.push({
        requestProtocol: structured?.structured?.requestProtocol ?? requestProtocol,
        error: structured?.structured?.error ?? "连接测试失败。",
      });
    }
    structured = withProbeFailureSummary(structured, structuredAttempts);
  }
  return mergeProbeStatuses({
    provider: input.provider,
    model: input.model,
    plain,
    structured,
  });
}

async function testModelRoutes(taskTypes: readonly ModelRouteTaskType[] = MODEL_ROUTE_TASK_TYPES): Promise<{
  testedAt: string;
  statuses: ModelRouteConnectivityStatus[];
}> {
  const resolvedRoutes = await Promise.all(taskTypes.map(async (taskType) => ({
    taskType,
    ...(await resolveModel(taskType)),
  })));

  const dedupedChecks = new Map<string, Promise<LLMConnectivityStatus>>();
  for (const route of resolvedRoutes) {
    const key = [
      route.provider,
      route.model,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    if (!dedupedChecks.has(key)) {
      dedupedChecks.set(key, testConnection({
        provider: route.provider,
        model: route.model,
        requestProtocol: route.requestProtocol,
        structuredResponseFormat: route.structuredResponseFormat,
        probeMode: "both",
      }));
    }
  }

  const statuses = await Promise.all(resolvedRoutes.map(async (route) => {
    const key = [
      route.provider,
      route.model,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    const result = await dedupedChecks.get(key)!;
    const effectiveProtocol = result.structured?.requestProtocol ?? result.plain?.requestProtocol ?? route.requestProtocol;
    const effectiveFormat = (
      result.structured?.strategy === "json_schema"
      || result.structured?.strategy === "json_object"
      || result.structured?.strategy === "prompt_json"
    )
      ? result.structured.strategy
      : route.structuredResponseFormat;
    const shouldPersistProbeResult = result.structured?.ok === true
      && (effectiveProtocol !== route.requestProtocol || effectiveFormat !== route.structuredResponseFormat);
    if (shouldPersistProbeResult) {
      await upsertModelRouteConfig(route.taskType, {
        provider: route.provider,
        model: route.model,
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        requestProtocol: effectiveProtocol,
        structuredResponseFormat: effectiveFormat,
      });
    }
    return {
      taskType: route.taskType,
      provider: route.provider,
      model: route.model,
      ok: result.ok,
      latency: result.latency,
      error: result.error,
      requestProtocol: result.requestProtocol,
      plain: result.plain,
      structured: result.structured,
    };
  }));

  return {
    testedAt: new Date().toISOString(),
    statuses,
  };
}

/**
 * 向量化专用渠道（如 embedding 服务）没有对话接口，对话探测必然失败。
 * 这里直接请求向量化端点验证真实能力，判定依据是请求结果而不是错误文案。
 */
export async function probeEmbeddingEndpoint(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
}): Promise<EmbeddingProbeStatus> {
  const baseURL = input.baseURL?.trim();
  if (!baseURL) {
    return { ok: false, latency: null, error: "未配置可用的 API URL。", endpoint: null };
  }
  const model = input.model?.trim() || "embedding";
  // 用户粘贴的地址可能以 /embeddings 结尾，与模型目录、对话请求共用同一套尾部剥离规则。
  const endpoint = `${normalizeBaseURL(baseURL).replace(/\/+$/, "")}/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const start = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...buildProviderModelHeaders(input.provider, input.apiKey, input.authMode ?? "bearer"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: "连接测试" }),
      signal: controller.signal,
    });
    const latency = Date.now() - start;
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        latency,
        error: `向量化接口返回 ${response.status}：${raw.slice(0, 160) || "未知错误"}`,
        endpoint,
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, latency, error: "向量化接口返回的内容不是 JSON。", endpoint };
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, latency, error: "向量化接口返回了空结果。", endpoint };
    }
    return { ok: true, latency, error: null, endpoint };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, latency: Date.now() - start, error: "向量化接口请求超时。", endpoint };
    }
    return { ok: false, latency: Date.now() - start, error: toErrorMessage(error), endpoint };
  } finally {
    clearTimeout(timer);
  }
}

export const llmConnectivityService = {
  testConnection,
  testModelRoutes,
  probeEmbeddingEndpoint,
};
