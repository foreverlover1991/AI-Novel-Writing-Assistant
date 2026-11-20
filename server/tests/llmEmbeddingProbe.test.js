const test = require("node:test");
const assert = require("node:assert/strict");
const { probeEmbeddingEndpoint } = require("../dist/llm/connectivity.js");

const VECTOR_OK = JSON.stringify({
  object: "list",
  data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
});

function jsonResponse(body, status = 200, contentType = "application/json") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

test("an embedding-only service passes the vectorization probe and the path is not duplicated", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://token-api.example.com/inference/qweb4b01/v1/embeddings");
    return jsonResponse(VECTOR_OK);
  });

  const result = await probeEmbeddingEndpoint({
    provider: "custom_preview",
    model: "Qwen3-Embedding-4B",
    apiKey: "secret",
    // 用户直接粘贴带操作路径的完整地址，尾部剥离后不应出现重复的 /embeddings。
    baseURL: "https://token-api.example.com/inference/qweb4b01/v1/embeddings",
    authMode: "bearer",
  });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.match(result.endpoint, /\/v1\/embeddings$/);
  assert.equal(mocked.mock.callCount(), 1);
});

test("the vectorization probe sends the auth header selected by authMode", async (t) => {
  let captured = null;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    captured = init;
    return jsonResponse(VECTOR_OK);
  });

  await probeEmbeddingEndpoint({
    provider: "custom_preview",
    model: "emb",
    apiKey: "secret",
    baseURL: "https://gw.example.com/v1",
    authMode: "x-api-key",
  });
  assert.equal(captured.headers["x-api-key"], "secret");
  assert.equal(captured.headers.Authorization, undefined);
});

test("an empty vectorization result is reported as a probe failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(JSON.stringify({ object: "list", data: [] })));

  const result = await probeEmbeddingEndpoint({
    provider: "custom_preview",
    model: "emb",
    apiKey: "secret",
    baseURL: "https://gw.example.com/v1",
    authMode: "bearer",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /空结果/);
});

test("a server error from the vectorization endpoint keeps the status code in the message", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(JSON.stringify({ status: 500, message: "处理异常" }), 500));

  const result = await probeEmbeddingEndpoint({
    provider: "custom_preview",
    model: "emb",
    apiKey: "secret",
    baseURL: "https://gw.example.com/v1",
    authMode: "bearer",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /向量化接口返回 500/);
});

test("a web page response from the vectorization endpoint is reported as non-JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse("<!DOCTYPE html><html></html>", 200, "text/html"));

  const result = await probeEmbeddingEndpoint({
    provider: "custom_preview",
    model: "emb",
    apiKey: "secret",
    baseURL: "https://gw.example.com/v1",
    authMode: "bearer",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /不是 JSON/);
});

test("a missing API URL fails fast without a network request", async () => {
  const result = await probeEmbeddingEndpoint({ provider: "custom_preview", model: "emb" });
  assert.equal(result.ok, false);
  assert.match(result.error, /未配置可用的 API URL/);
  assert.equal(result.endpoint, null);
});
