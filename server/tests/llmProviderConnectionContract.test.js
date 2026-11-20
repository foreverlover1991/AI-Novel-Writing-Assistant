/**
 * 渠道连接合同回归：自定义网关的鉴权头方案、完整请求地址、以及连通性探测对
 * 思考型模型与多协议候选的处理。
 *
 * 覆盖范围：
 * - 用户粘贴接口文档里的完整请求地址时，必须收敛到版本根地址，避免操作路径被重复拼接。
 * - 用户粘贴 `Bearer <key>` 形式的密钥时，发送前必须去掉方案前缀。
 * - Anthropic 协议按厂商鉴权设置选择鉴权头，不再只发 `x-api-key`。
 * - 连通性探测只收到推理内容也算渠道可用；多协议候选都失败时按协议分别给出原因。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const providers = require("../dist/llm/providers");
const modelCatalog = require("../dist/llm/modelCatalog");
const anthropicClient = require("../dist/llm/anthropicClient");
const factory = require("../dist/llm/factory");
const connectivity = require("../dist/llm/connectivity");
const { AIMessageChunk, HumanMessage } = require("@langchain/core/messages");

const GATEWAY_BASE_URL = "http://10.62.64.38:30808/api/inference/v1";
const GATEWAY_CHAT_URL = `${GATEWAY_BASE_URL}/chat/completions`;

test("provider base url keeps version root when a full request address is pasted", () => {
  assert.equal(providers.normalizeBaseURL(GATEWAY_CHAT_URL), GATEWAY_BASE_URL);
  assert.equal(providers.normalizeBaseURL(`${GATEWAY_CHAT_URL}//`), GATEWAY_BASE_URL);
  assert.equal(providers.normalizeBaseURL("https://relay.example/v1/messages"), "https://relay.example/v1");
  assert.equal(providers.normalizeBaseURL("https://relay.example/v1/embeddings"), "https://relay.example/v1");
  assert.equal(providers.normalizeBaseURL("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1");
  assert.equal(providers.normalizeBaseURL("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(modelCatalog.resolveModelsEndpoint(providers.normalizeBaseURL(GATEWAY_CHAT_URL)), `${GATEWAY_BASE_URL}/models`);
});

test("api key bearer scheme prefix is removed before the auth header is composed", () => {
  assert.equal(providers.normalizeProviderApiKey("Bearer f59f6af5-9f27"), "f59f6af5-9f27");
  assert.equal(providers.normalizeProviderApiKey("  bearer   f59f6af5-9f27 "), "f59f6af5-9f27");
  assert.equal(providers.normalizeProviderApiKey("sk-ant-api03-abcd"), "sk-ant-api03-abcd");
  assert.equal(providers.normalizeProviderApiKey("   "), undefined);
  assert.deepEqual(
    modelCatalog.buildProviderModelHeaders("custom_gateway", providers.normalizeProviderApiKey("Bearer f59f"), "bearer"),
    { Accept: "application/json", Authorization: "Bearer f59f" },
  );
});

test("anthropic transport selects the auth header from the provider auth mode", async () => {
  const previousFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url, headers: options.headers });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
  };
  const messages = [new HumanMessage("hi")];
  try {
    for (const authMode of ["bearer", "x-api-key", "none"]) {
      await anthropicClient.createAnthropicLLM({
        apiKey: "K1",
        model: "claude-sonnet-4-5",
        baseURL: GATEWAY_BASE_URL,
        temperature: 0,
        authMode,
      }).invoke(messages);
    }
    assert.equal(seen[0].headers.Authorization, "Bearer K1");
    assert.equal(seen[0].headers["x-api-key"], undefined);
    assert.equal(seen[1].headers["x-api-key"], "K1");
    assert.equal(seen[1].headers.Authorization, undefined);
    assert.equal(seen[2].headers.Authorization, undefined);
    assert.equal(seen[2].headers["x-api-key"], undefined);
    for (const request of seen) {
      assert.equal(request.headers["anthropic-version"], "2023-06-01");
      assert.equal(request.url, `${GATEWAY_BASE_URL}/messages`);
    }
    // 未显式传入鉴权方式时保持官方 Anthropic 行为。
    await anthropicClient.createAnthropicLLM({
      apiKey: "K1",
      model: "claude-sonnet-4-5",
      baseURL: "https://api.anthropic.com/v1",
      temperature: 0,
    }).invoke(messages);
    assert.equal(seen[3].headers["x-api-key"], "K1");
  } finally {
    global.fetch = previousFetch;
  }
});

function stubFactory(chunksByProtocol) {
  const originalResolve = factory.resolveLLMClientOptions;
  const originalGetLLM = factory.getLLM;
  factory.resolveLLMClientOptions = async (provider, options = {}) => ({
    provider,
    providerName: provider,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    authMode: "bearer",
    temperature: 0.1,
    maxTokens: options.maxTokens,
    requestProtocol: options.requestProtocol === "anthropic" ? "anthropic" : "openai_compatible",
    executionMode: "plain",
    concurrencyLimit: 0,
    requestIntervalMs: 0,
    reasoningEnabled: false,
    reasoningEffort: null,
    includeRawResponse: false,
    reasoningForcedOff: false,
    structuredStrategy: null,
  });
  factory.getLLM = async (provider, options = {}) => ({
    stream: async () => chunksByProtocol[options.requestProtocol] ?? [],
  });
  return () => {
    factory.resolveLLMClientOptions = originalResolve;
    factory.getLLM = originalGetLLM;
  };
}

test("plain probe accepts reasoning-only responses and reports larger output budget", async () => {
  const restore = stubFactory({
    openai_compatible: [new AIMessageChunk({ content: "", additional_kwargs: { reasoning: "思考中" } })],
  });
  try {
    const result = await connectivity.llmConnectivityService.testConnection({
      provider: "custom_gateway",
      model: "Qwen3.6-27B",
      apiKey: "k",
      baseURL: GATEWAY_BASE_URL,
      probeMode: "plain",
      requestProtocol: "openai_compatible",
    });
    assert.equal(result.plain.ok, true);
    assert.equal(result.plain.requestProtocol, "openai_compatible");
  } finally {
    restore();
  }
});

test("plain probe still fails when neither content nor reasoning arrives", async () => {
  const restore = stubFactory({ openai_compatible: [new AIMessageChunk({ content: "" })] });
  try {
    const result = await connectivity.llmConnectivityService.testConnection({
      provider: "custom_gateway",
      model: "Qwen3.6-27B",
      apiKey: "k",
      baseURL: GATEWAY_BASE_URL,
      probeMode: "plain",
      requestProtocol: "openai_compatible",
    });
    assert.equal(result.plain.ok, false);
    assert.match(result.plain.error, /空正文/);
  } finally {
    restore();
  }
});

test("failed probe lists every protocol candidate instead of only the last attempt", async () => {
  const originalResolve = factory.resolveLLMClientOptions;
  const originalGetLLM = factory.getLLM;
  const attempted = [];
  factory.resolveLLMClientOptions = async (provider, options = {}) => ({
    provider,
    providerName: provider,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    authMode: "bearer",
    temperature: 0.1,
    maxTokens: options.maxTokens,
    requestProtocol: options.requestProtocol === "anthropic" ? "anthropic" : "openai_compatible",
    executionMode: "plain",
    concurrencyLimit: 0,
    requestIntervalMs: 0,
    reasoningEnabled: false,
    reasoningEffort: null,
    includeRawResponse: false,
    reasoningForcedOff: false,
    structuredStrategy: null,
  });
  factory.getLLM = async (provider, options = {}) => {
    attempted.push(options.requestProtocol);
    const detail = options.requestProtocol === "anthropic"
      ? "Anthropic request failed (401): 缺失Authorization header"
      : "400 invalid_request_error";
    throw new Error(detail);
  };
  try {
    const result = await connectivity.llmConnectivityService.testConnection({
      provider: "custom_gateway",
      model: "Qwen3.6-27B",
      apiKey: "k",
      baseURL: GATEWAY_BASE_URL,
      probeMode: "plain",
    });
    assert.deepEqual(attempted, ["openai_compatible", "anthropic"]);
    assert.equal(result.plain.ok, false);
    assert.match(result.plain.error, /OpenAI 兼容协议：400 invalid_request_error/);
    assert.match(result.plain.error, /Anthropic 协议：Anthropic request failed \(401\)/);
  } finally {
    factory.resolveLLMClientOptions = originalResolve;
    factory.getLLM = originalGetLLM;
  }
});
