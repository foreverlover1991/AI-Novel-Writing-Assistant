const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveDocPath,
  listDocsCatalog,
  readDocs,
  writingGlossary,
} = require("../dist/services/assistant/assistantTools.js");
const toolsModule = require("../dist/services/assistant/assistantTools.js");

function makeDocsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-docs-"));
  fs.mkdirSync(path.join(root, "features"), { recursive: true });
  fs.mkdirSync(path.join(root, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "features", "creative-hub.mdx"),
    `---\ntitle: "创作中枢"\ndescription: "面向创作过程的状态查询入口。"\n---\n\n创作中枢正文。\n`,
  );
  fs.writeFileSync(
    path.join(root, "guides", "chapter-execution.mdx"),
    `---\ntitle: "章节执行"\ndescription: "章节执行指南。"\n---\n\n指南正文。\n`,
  );
  fs.writeFileSync(
    path.join(root, "glossary.mdx"),
    `---\ntitle: "术语表"\ndescription: "写作术语表。"\n---\n\n黄金三章：小说开头三章。\n`,
  );
  return root;
}

test("listDocsCatalog parses frontmatter title and description", () => {
  const root = makeDocsRoot();
  const catalog = listDocsCatalog(root);
  const byFile = new Map(catalog.map((entry) => [entry.file, entry]));
  assert.equal(byFile.get("features/creative-hub.mdx").title, "创作中枢");
  assert.equal(byFile.get("features/creative-hub.mdx").description, "面向创作过程的状态查询入口。");
  assert.equal(byFile.get("guides/chapter-execution.mdx").title, "章节执行");
  assert.ok(byFile.has("glossary.mdx"));
});

test("resolveDocPath rejects path traversal and absolute escape", () => {
  const root = makeDocsRoot();
  assert.ok(resolveDocPath(root, "features/creative-hub.mdx"));
  assert.equal(resolveDocPath(root, "../../etc/passwd"), null);
  assert.equal(resolveDocPath(root, "/etc/passwd"), null);
  assert.equal(resolveDocPath(root, "features/../../secret.mdx"), null);
});

test("readDocs truncates a single file to the character cap", () => {
  const root = makeDocsRoot();
  const bigBody = "x".repeat(20000);
  fs.writeFileSync(path.join(root, "features", "big.mdx"), `---\ntitle: "大文档"\ndescription: "很长。"\n---\n\n${bigBody}\n`);
  const output = readDocs(["features/big.mdx"], root);
  assert.match(output, /（内容已截断）/);
  // 截断上限 12k 字符 + 标题与提示行，远小于原始 20k。
  assert.ok(output.length < 13000, `expected truncated output, got ${output.length}`);
});

test("readDocs silently drops traversal paths outside the docs root", () => {
  const root = makeDocsRoot();
  const output = readDocs(["../../../etc/passwd"], root);
  assert.equal(output, "");
});

test("writingGlossary includes glossary body and guide catalog", () => {
  const root = makeDocsRoot();
  const glossary = writingGlossary(root);
  assert.match(glossary, /黄金三章/);
  assert.match(glossary, /章节执行/);
});

test("assistant tools layer exposes only read helpers (no write operations)", () => {
  const writeish = Object.keys(toolsModule).filter((name) => /^(create|update|delete|write|save|remove|mutate)/i.test(name));
  assert.deepEqual(writeish, [], `tools layer must not export write helpers: ${writeish.join(", ")}`);
});
