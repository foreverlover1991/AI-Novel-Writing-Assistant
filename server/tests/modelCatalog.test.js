const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProviderModelHeaders,
  filterHiddenModels,
  parseHiddenModels,
  parseModelList,
  refreshProviderModels,
  resolveModelsEndpoint,
  serializeHiddenModels,
  serializeModelList,
} = require("../dist/llm/modelCatalog.js");

test("hidden model storage trims and deduplicates model ids", () => {
  const stored = serializeHiddenModels([" model-a ", "model-b", "model-a", ""]);
  assert.equal(stored, '["model-a","model-b"]');
  assert.deepEqual(parseHiddenModels(stored), ["model-a", "model-b"]);
});

test("invalid hidden model storage is treated as empty", () => {
  assert.deepEqual(parseHiddenModels("not-json"), []);
  assert.deepEqual(parseHiddenModels('{"model":"model-a"}'), []);
});

test("provider model catalogs use the same bounded JSON storage format", () => {
  const stored = serializeModelList([" model-a ", "model-b", "model-a", ""]);
  assert.equal(stored, '["model-a","model-b"]');
  assert.deepEqual(parseModelList(stored), ["model-a", "model-b"]);
});

test("hidden models are filtered while the selected model remains available", () => {
  assert.deepEqual(
    filterHiddenModels(["model-a", "model-b", "model-c"], ["model-a", "model-b"], "model-a"),
    ["model-a", "model-c"],
  );
});

test("model catalog does not append a duplicate models path", () => {
  assert.equal(
    resolveModelsEndpoint("https://generativelanguage.googleapis.com/v1beta/openai"),
    "https://generativelanguage.googleapis.com/v1beta/openai/models",
  );
  assert.equal(
    resolveModelsEndpoint("https://generativelanguage.googleapis.com/v1beta/openai/models"),
    "https://generativelanguage.googleapis.com/v1beta/openai/models",
  );
  assert.equal(
    resolveModelsEndpoint("http://127.0.0.1:11434/v1/models/"),
    "http://127.0.0.1:11434/v1/models",
  );
});

test("custom model catalog uses the configured authentication header", () => {
  assert.deepEqual(buildProviderModelHeaders("custom_gateway", "secret", "bearer"), {
    Accept: "application/json",
    Authorization: "Bearer secret",
  });
  assert.deepEqual(buildProviderModelHeaders("custom_gateway", "secret", "x-api-key"), {
    Accept: "application/json",
    "x-api-key": "secret",
  });
  assert.deepEqual(buildProviderModelHeaders("custom_gateway", "secret", "none"), {
    Accept: "application/json",
  });
});

test("a web console page behind a 200 response is reported as a catalog failure, not a syntax error", async (t) => {
  const mockedFetch = t.mock.method(globalThis, "fetch", async () =>
    new Response("<!DOCTYPE html><html><body>console</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));

  await assert.rejects(
    refreshProviderModels("custom_preview", "secret", "http://gateway.local", "bearer"),
    (error) => {
      assert.match(error.message, /拉取模型列表失败：接口返回了网页而不是 JSON/);
      assert.match(error.message, /版本根地址/);
      assert.doesNotMatch(error.message, /Unexpected token/);
      return true;
    },
  );
  assert.equal(mockedFetch.mock.callCount(), 1);
});

test("an empty catalog payload is reported as an empty model list", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  await assert.rejects(
    refreshProviderModels("custom_preview", "secret", "http://gateway.local", "bearer"),
    /模型列表为空/,
  );
});
