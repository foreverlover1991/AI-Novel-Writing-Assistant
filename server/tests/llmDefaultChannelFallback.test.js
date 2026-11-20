const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");
const { resolveModel } = require("../dist/llm/modelRouter.js");
const { resolveLLMClientOptions, setProviderSecretCache } = require("../dist/llm/factory.js");

const GATEWAY_PROVIDER = "custom_qwen_gateway";
const GATEWAY_MODEL = "Qwen3.6-27B";
const GATEWAY_BASE_URL = "http://gateway.example.com/api/inference/v1";
const SELECTION_KEY = "llm.currentSelection";

function stubSelection(selection) {
  const original = prisma.appSetting.findUnique;
  prisma.appSetting.findUnique = async (args) => {
    const key = args?.where?.key;
    if (key === SELECTION_KEY) {
      return selection ? { key, value: JSON.stringify(selection) } : null;
    }
    return original(args);
  };
  return () => {
    prisma.appSetting.findUnique = original;
  };
}

function stubRouteRow(row) {
  const original = prisma.modelRouteConfig.findUnique;
  prisma.modelRouteConfig.findUnique = async () => row;
  return () => {
    prisma.modelRouteConfig.findUnique = original;
  };
}

function stubStoredKeys(rows = []) {
  const original = prisma.aPIKey.findUnique;
  prisma.aPIKey.findUnique = async (args) => {
    const provider = args?.where?.provider;
    return rows.find((row) => row.provider === provider) ?? null;
  };
  return () => {
    prisma.aPIKey.findUnique = original;
  };
}

function withoutLegacyDefaultKey() {
  const original = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  setProviderSecretCache("deepseek", null);
  return () => {
    if (original === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = original;
    }
    setProviderSecretCache("deepseek", null);
  };
}

test("resolveModel falls back to the saved global model selection when a task route is missing", async () => {
  const restoreRoute = stubRouteRow(null);
  const restoreSelection = stubSelection({ provider: GATEWAY_PROVIDER, model: GATEWAY_MODEL, temperature: 0.7 });

  try {
    const resolved = await resolveModel("planner");
    assert.equal(resolved.provider, GATEWAY_PROVIDER);
    assert.equal(resolved.model, GATEWAY_MODEL);
    // Task specific tuning stays, only the channel follows the user's selection.
    assert.equal(resolved.temperature, 0.3);
  } finally {
    restoreRoute();
    restoreSelection();
  }
});

test("resolveModel keeps a saved per-task route ahead of the global selection", async () => {
  const restoreRoute = stubRouteRow({
    taskType: "planner",
    provider: "kimi",
    model: "kimi-k2",
    temperature: 0.25,
    maxTokens: null,
    requestProtocol: "auto",
    structuredResponseFormat: "auto",
  });
  const restoreSelection = stubSelection({ provider: GATEWAY_PROVIDER, model: GATEWAY_MODEL, temperature: 0.7 });

  try {
    const resolved = await resolveModel("planner");
    assert.equal(resolved.provider, "kimi");
    assert.equal(resolved.model, "kimi-k2");
    assert.equal(resolved.temperature, 0.25);
  } finally {
    restoreRoute();
    restoreSelection();
  }
});

test("resolveModel honors an explicit caller channel over the global selection", async () => {
  const restoreRoute = stubRouteRow(null);
  const restoreSelection = stubSelection({ provider: GATEWAY_PROVIDER, model: GATEWAY_MODEL });

  try {
    const resolved = await resolveModel("writer", { provider: "glm", model: "glm-4.6" });
    assert.equal(resolved.provider, "glm");
    assert.equal(resolved.model, "glm-4.6");
  } finally {
    restoreRoute();
    restoreSelection();
  }
});

test("resolveLLMClientOptions reroutes the unconfigured legacy default to the selected channel", async () => {
  const restoreRoute = stubRouteRow(null);
  const restoreSelection = stubSelection({ provider: GATEWAY_PROVIDER, model: GATEWAY_MODEL });
  const restoreKeys = stubStoredKeys([]);
  const restoreLegacyKey = withoutLegacyDefaultKey();
  setProviderSecretCache(GATEWAY_PROVIDER, {
    key: "gateway-key",
    model: GATEWAY_MODEL,
    baseURL: GATEWAY_BASE_URL,
    displayName: "Qwen Gateway",
  });

  try {
    // High level services such as world building still pass the historical default channel.
    const resolved = await resolveLLMClientOptions("deepseek", {
      model: "deepseek-chat",
      taskType: "planner",
      executionMode: "structured",
    });
    assert.equal(resolved.provider, GATEWAY_PROVIDER);
    assert.equal(resolved.model, GATEWAY_MODEL);
    assert.equal(resolved.baseURL, GATEWAY_BASE_URL);
  } finally {
    setProviderSecretCache(GATEWAY_PROVIDER, null);
    restoreLegacyKey();
    restoreKeys();
    restoreSelection();
    restoreRoute();
  }
});

test("resolveLLMClientOptions keeps the requested channel when its key is configured", async () => {
  const restoreRoute = stubRouteRow(null);
  const restoreSelection = stubSelection({ provider: GATEWAY_PROVIDER, model: GATEWAY_MODEL });
  const restoreLegacyKey = withoutLegacyDefaultKey();
  setProviderSecretCache("deepseek", {
    key: "legacy-key",
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
  });

  try {
    const resolved = await resolveLLMClientOptions("deepseek", { taskType: "planner" });
    assert.equal(resolved.provider, "deepseek");
    assert.equal(resolved.model, "deepseek-chat");
  } finally {
    restoreLegacyKey();
    restoreSelection();
    restoreRoute();
  }
});

test("resolveLLMClientOptions asks the user to configure a channel when nothing is available", async () => {
  const restoreRoute = stubRouteRow(null);
  const restoreSelection = stubSelection(null);
  const restoreKeys = stubStoredKeys([]);
  const restoreLegacyKey = withoutLegacyDefaultKey();

  try {
    await assert.rejects(
      () => resolveLLMClientOptions(undefined, { taskType: "planner" }),
      (error) => {
        assert.match(error.message, /还没有配置可用的模型渠道/);
        return true;
      },
    );
  } finally {
    restoreLegacyKey();
    restoreKeys();
    restoreSelection();
    restoreRoute();
  }
});
