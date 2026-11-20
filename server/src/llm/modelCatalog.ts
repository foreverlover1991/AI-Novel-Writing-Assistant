import type { LLMProvider, ProviderAuthMode } from "@ai-novel/shared/types/llm";
import {
  isBuiltInProvider,
  normalizeProviderApiKey,
  providerRequiresApiKey,
  PROVIDERS,
  resolveProviderBaseUrl,
} from "./providers";

interface ModelCacheItem {
  models: string[];
  cachedAt: number;
}

interface GetProviderModelsOptions {
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  forceRefresh?: boolean;
  allowAnonymous?: boolean;
  fallbackModel?: string;
  fallbackModels?: string[];
  includeBuiltInFallback?: boolean;
}

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const modelCache = new Map<string, ModelCacheItem>();

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map((item) => item.trim()).filter(Boolean)));
}

export function parseModelList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? uniqueModels(parsed.filter((item): item is string => typeof item === "string")).slice(0, 200)
      : [];
  } catch {
    return [];
  }
}

export function parseHiddenModels(value: string | null | undefined): string[] {
  return parseModelList(value);
}

export function serializeHiddenModels(models: string[]): string {
  return JSON.stringify(uniqueModels(models).slice(0, 200));
}

export function serializeModelList(models: string[]): string {
  return JSON.stringify(uniqueModels(models).slice(0, 200));
}

export function filterHiddenModels(
  models: string[],
  hiddenModels: string[],
  currentModel?: string,
): string[] {
  const hidden = new Set(hiddenModels);
  const current = currentModel?.trim();
  return uniqueModels(models).filter((model) => model === current || !hidden.has(model));
}

function getFallbackModels(provider: LLMProvider, options: GetProviderModelsOptions = {}): string[] {
  const builtInModels = options.includeBuiltInFallback === false
    ? []
    : isBuiltInProvider(provider) ? PROVIDERS[provider].models : [];
  return uniqueModels([
    ...builtInModels,
    ...(options.fallbackModels ?? []),
    options.fallbackModel ?? "",
  ]);
}

function getCacheKey(provider: LLMProvider, baseURL?: string): string {
  const resolvedBaseURL = resolveProviderBaseUrl(provider, baseURL, baseURL) ?? "";
  return `${provider}::${resolvedBaseURL}`;
}

function getCachedModels(provider: LLMProvider, baseURL?: string): string[] | undefined {
  const cacheKey = getCacheKey(provider, baseURL);
  const item = modelCache.get(cacheKey);
  if (!item) {
    return undefined;
  }
  const expired = Date.now() - item.cachedAt > MODEL_CACHE_TTL_MS;
  if (expired) {
    modelCache.delete(cacheKey);
    return undefined;
  }
  return item.models;
}

function setCachedModels(provider: LLMProvider, models: string[], baseURL?: string): string[] {
  const normalized = uniqueModels(models);
  modelCache.set(getCacheKey(provider, baseURL), {
    models: normalized,
    cachedAt: Date.now(),
  });
  return normalized;
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown; models?: unknown }).data ?? (payload as { models?: unknown }).models;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const candidate = (item as { id?: unknown; model?: unknown; name?: unknown }).id
        ?? (item as { model?: unknown }).model
        ?? (item as { name?: unknown }).name;
      return typeof candidate === "string" ? candidate : "";
    })
    .filter(Boolean);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      // 返回体可能是大段 HTML 错误页，截断后放进提示，避免报错信息不可读。
      const detail = (await response.text()).slice(0, 160);
      throw new Error(`拉取模型列表失败（${response.status}）：${detail || "未知错误"}`);
    }

    // 目录地址偶尔会指向网关的网页控制台：状态码是 200，但正文是 HTML。
    // 这里先识别内容再解析，避免裸 json() 抛出无意义的 SyntaxError 变成 500。
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    if (!(/json/i.test(contentType) || /^\s*[[{]/.test(raw))) {
      throw new Error(
        `拉取模型列表失败：接口返回了网页而不是 JSON（content-type: ${contentType || "未知"}）。`
        + "请把 API URL 填成模型服务的版本根地址（例如 http://主机:端口/v1），而不是网页控制台地址。",
      );
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("拉取模型列表失败：接口返回的内容无法解析成 JSON，请确认 API URL 指向模型服务。");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("拉取模型列表失败：请求超时。请检查网络连通性后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function buildProviderModelHeaders(
  provider: LLMProvider,
  apiKey?: string,
  authMode: ProviderAuthMode = "bearer",
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (!apiKey) {
    return headers;
  }

  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = process.env.ANTHROPIC_VERSION ?? "2023-06-01";
    return headers;
  }

  if (!isBuiltInProvider(provider) && authMode === "none") {
    return headers;
  }

  if (!isBuiltInProvider(provider) && authMode === "x-api-key") {
    headers["x-api-key"] = apiKey;
    return headers;
  }

  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export function resolveModelsEndpoint(baseURL: string): string {
  const endpoint = new URL(baseURL);
  const normalizedPath = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = normalizedPath.endsWith("/models")
    ? normalizedPath
    : `${normalizedPath}/models`;
  return endpoint.toString();
}

async function fetchOllamaModels(baseURL: string): Promise<string[]> {
  const nativeBaseURL = baseURL.endsWith("/v1") ? baseURL.slice(0, -3) : baseURL;

  try {
    const payload = await fetchJson(`${nativeBaseURL}/api/tags`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    const models = parseModelIds(payload);
    if (models.length > 0) {
      return models;
    }
  } catch {
    // Fall back to the OpenAI-compatible models endpoint.
  }

  const payload = await fetchJson(resolveModelsEndpoint(baseURL), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  const models = parseModelIds(payload);
  if (models.length === 0) {
    throw new Error("模型列表为空。");
  }
  return models;
}

async function fetchProviderModels(
  provider: LLMProvider,
  apiKey?: string,
  customBaseURL?: string,
  authMode?: ProviderAuthMode,
): Promise<string[]> {
  const baseURL = resolveProviderBaseUrl(provider, customBaseURL, customBaseURL);
  if (!baseURL) {
    throw new Error("未配置可用的 API URL。");
  }
  if (provider === "ollama") {
    return fetchOllamaModels(baseURL);
  }

  const payload = await fetchJson(resolveModelsEndpoint(baseURL), {
    method: "GET",
    headers: buildProviderModelHeaders(provider, apiKey, authMode),
  });

  const models = parseModelIds(payload);
  if (models.length === 0) {
    throw new Error("模型列表为空。");
  }
  return models;
}

export async function getProviderModels(
  provider: LLMProvider,
  options: GetProviderModelsOptions = {},
): Promise<string[]> {
  const fallback = getFallbackModels(provider, options);
  if (!options.forceRefresh) {
    const cached = getCachedModels(provider, options.baseURL);
    if (cached && cached.length > 0) {
      return cached;
    }
  }

  const normalizedApiKey = normalizeProviderApiKey(options.apiKey);
  const allowAnonymous = options.allowAnonymous ?? !providerRequiresApiKey(provider);
  const canFetchRemotely = normalizedApiKey || allowAnonymous;
  if (!canFetchRemotely) {
    return fallback;
  }

  try {
    const models = await fetchProviderModels(provider, normalizedApiKey, options.baseURL, options.authMode);
    return models.length > 0 ? setCachedModels(provider, models, options.baseURL) : fallback;
  } catch {
    const cached = getCachedModels(provider, options.baseURL);
    if (cached && cached.length > 0) {
      return cached;
    }
    return fallback;
  }
}

export async function refreshProviderModels(
  provider: LLMProvider,
  apiKey?: string,
  baseURL?: string,
  authMode?: ProviderAuthMode,
): Promise<string[]> {
  const models = await fetchProviderModels(provider, normalizeProviderApiKey(apiKey), baseURL, authMode);
  return setCachedModels(provider, models, baseURL);
}
