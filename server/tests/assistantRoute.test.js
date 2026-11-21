const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../dist/app.js");
const assistantService = require("../dist/services/assistant/assistantService.js");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("assistant chat streams intent → tool → delta → done frames in order", async () => {
  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);
  const original = assistantService.runAssistantChat;
  assistantService.runAssistantChat = async (_input, emit) => {
    emit({ event: "assistant/intent", data: { category: "product_usage", novelId: null, retrievalQuery: null, logSources: [], needDocSelect: true, clarification: null } });
    emit({ event: "assistant/tool", data: { tool: "docs", status: "done", summary: "已读取 1 篇文档" } });
    emit({ event: "assistant/delta", data: { text: "创作中枢" } });
    emit({ event: "assistant/delta", data: { text: "用于状态查询。" } });
    emit({ event: "assistant/done", data: { category: "product_usage" } });
  };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "创作中枢怎么用？" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    const intentAt = text.indexOf('"event":"assistant/intent"');
    const toolAt = text.indexOf('"event":"assistant/tool"');
    const deltaAt = text.indexOf('"event":"assistant/delta"');
    const doneAt = text.indexOf('"event":"assistant/done"');
    assert.ok(intentAt >= 0, "intent frame missing");
    assert.ok(intentAt < toolAt && toolAt < deltaAt && deltaAt < doneAt, "frame order violated");
    assert.match(text, /创作中枢/);
    assert.match(text, /用于状态查询。/);
  } finally {
    assistantService.runAssistantChat = original;
    await close(server);
  }
});

test("assistant chat emits an error frame when the service throws", async () => {
  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);
  const original = assistantService.runAssistantChat;
  assistantService.runAssistantChat = async () => {
    throw new Error("模型不可用");
  };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "任意问题" }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"event":"assistant\/error"/);
    assert.match(text, /模型不可用/);
  } finally {
    assistantService.runAssistantChat = original;
    await close(server);
  }
});

test("assistant chat rejects an empty message with a 400", async () => {
  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    assert.equal(response.status, 400);
  } finally {
    await close(server);
  }
});
