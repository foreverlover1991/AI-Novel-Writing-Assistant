const test = require("node:test");
const assert = require("node:assert/strict");
const { getRegisteredPromptAsset } = require("../dist/prompting/registry");

test("assistant prompt assets are registered with correct modes and taskType", () => {
  const intent = getRegisteredPromptAsset("assistant.intent.route", "v1");
  assert.ok(intent, "intent route asset should be registered");
  assert.equal(intent.mode, "structured");
  assert.equal(intent.taskType, "assistant");
  assert.ok(intent.outputSchema);

  const docs = getRegisteredPromptAsset("assistant.docs.select", "v1");
  assert.ok(docs, "docs select asset should be registered");
  assert.equal(docs.mode, "structured");
  assert.equal(docs.taskType, "assistant");
  assert.ok(docs.outputSchema);

  const answer = getRegisteredPromptAsset("assistant.answer.compose", "v1");
  assert.ok(answer, "answer compose asset should be registered");
  assert.equal(answer.mode, "text");
  assert.equal(answer.taskType, "assistant");
});

test("intent schema enforces category and logSources enums", () => {
  const schema = getRegisteredPromptAsset("assistant.intent.route", "v1").outputSchema;
  const base = { novelId: null, retrievalQuery: null, logSources: [], needDocSelect: false, clarification: null };

  assert.equal(schema.safeParse({ ...base, category: "novel_content" }).success, true);
  assert.equal(schema.safeParse({ ...base, category: "product_usage" }).success, true);
  assert.equal(schema.safeParse({ ...base, category: "not_a_category" }).success, false);

  assert.equal(schema.safeParse({ ...base, category: "system_diagnosis", logSources: ["runtime_errors", "task_records"] }).success, true);
  assert.equal(schema.safeParse({ ...base, category: "system_diagnosis", logSources: ["unknown_source"] }).success, false);
});

test("docs.select schema caps files at three", () => {
  const schema = getRegisteredPromptAsset("assistant.docs.select", "v1").outputSchema;
  assert.equal(schema.safeParse({ files: ["a.mdx", "b.mdx", "c.mdx"], reason: "r" }).success, true);
  assert.equal(schema.safeParse({ files: ["a.mdx", "b.mdx", "c.mdx", "d.mdx"], reason: "r" }).success, false);
});

test("intent postValidate normalizes blank strings to null", () => {
  const asset = getRegisteredPromptAsset("assistant.intent.route", "v1");
  const normalized = asset.postValidate(
    { category: "chitchat", novelId: "  ", retrievalQuery: "  ", logSources: [], needDocSelect: false, clarification: "  " },
    {},
    { selectedBlockIds: [], droppedBlockIds: [], summarizedBlockIds: [], blocks: [], estimatedInputTokens: 0 },
  );
  assert.equal(normalized.novelId, null);
  assert.equal(normalized.retrievalQuery, null);
  assert.equal(normalized.clarification, null);
});
