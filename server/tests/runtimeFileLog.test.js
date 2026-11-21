const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 把日志根重定向到临时目录（desktop 模式 + AI_NOVEL_APP_DATA_DIR），避免污染仓库 .logs。
const tempAppData = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-runtime-log-"));
const priorRuntime = process.env.AI_NOVEL_RUNTIME;
const priorAppDataDir = process.env.AI_NOVEL_APP_DATA_DIR;
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = tempAppData;

// 若与其它用例共享进程，测试结束后还原环境变量，避免影响别处的日志根解析。
after(() => {
  if (priorRuntime === undefined) delete process.env.AI_NOVEL_RUNTIME; else process.env.AI_NOVEL_RUNTIME = priorRuntime;
  if (priorAppDataDir === undefined) delete process.env.AI_NOVEL_APP_DATA_DIR; else process.env.AI_NOVEL_APP_DATA_DIR = priorAppDataDir;
});

const {
  resolveRuntimeLogPath,
  appendRuntimeErrorLine,
  appendRuntimeErrorStack,
} = require("../dist/platform/logging/runtimeFileLog.js");

test("runtime log path lives under <logs>/server/runtime-<date>.log", () => {
  const logPath = resolveRuntimeLogPath(new Date("2024-05-06T10:00:00Z"));
  assert.match(logPath, /server[/\\]runtime-\d{4}-\d{2}-\d{2}\.log$/);
  assert.equal(path.basename(logPath), `runtime-${formatLocalDate(new Date("2024-05-06T10:00:00Z"))}.log`);
});

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("appendRuntimeErrorLine writes an ISO-timestamped line and flattens newlines", () => {
  appendRuntimeErrorLine("GET /api/boom 500 12ms\nsecond line");
  const logPath = resolveRuntimeLogPath();
  assert.ok(fs.existsSync(logPath), "runtime log file should be created");
  const content = fs.readFileSync(logPath, "utf8");
  const line = content.trim().split("\n").pop();
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  assert.match(line, /GET \/api\/boom 500/);
  assert.ok(!line.includes("\n"), "newlines must be flattened");
  assert.match(line, /⏎/);
});

test("appendRuntimeErrorLine accumulates multiple lines", () => {
  appendRuntimeErrorLine("line-a");
  appendRuntimeErrorLine("line-b");
  const content = fs.readFileSync(resolveRuntimeLogPath(), "utf8");
  assert.match(content, /line-a/);
  assert.match(content, /line-b/);
});

test("appendRuntimeErrorStack truncates long stacks", () => {
  const longStack = new Error("boom");
  longStack.stack = `Error: boom\n${"x".repeat(5000)}`;
  appendRuntimeErrorStack("[error] requestId=test POST /api/x", longStack);
  const content = fs.readFileSync(resolveRuntimeLogPath(), "utf8");
  assert.match(content, /requestId=test/);
  assert.match(content, /…\(truncated\)/);
  const line = content.trim().split("\n").pop();
  // 堆栈上限 2048 字符 + 时间戳与标签，远小于原始 5000。
  assert.ok(line.length < 2600, `expected truncated stack line, got ${line.length}`);
});
