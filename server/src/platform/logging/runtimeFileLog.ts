import fs from "node:fs";
import path from "node:path";

import { resolveLogsRoot } from "../../runtime/appPaths";
import { resolveLogRetentionConfig, rotateLogFileIfNeeded } from "./logRetention";

const MAX_STACK_CHARS = 2048;

function formatDatePart(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveRuntimeLogPath(now: Date = new Date()): string {
  return path.join(resolveLogsRoot(), "server", `runtime-${formatDatePart(now)}.log`);
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…(truncated)` : value;
}

/**
 * 追加一行运行错误日志到 <logs>/server/runtime-<日期>.log。
 * 只记录错误路径（请求 4xx/5xx、异常堆栈、未捕获异常），量小且对诊断最有价值；
 * 轮转与保留复用统一日志保留配置，写失败只告警不影响主链路。
 */
export function appendRuntimeErrorLine(line: string): void {
  try {
    const logPath = resolveRuntimeLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateLogFileIfNeeded(logPath, resolveLogRetentionConfig());
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line.replace(/\n/g, " ⏎ ")}\n`, "utf8");
  } catch (error) {
    console.warn("[runtime.log] failed to append runtime error line:", error instanceof Error ? error.message : error);
  }
}

export function appendRuntimeErrorStack(label: string, error: unknown): void {
  const stack = error instanceof Error && error.stack ? error.stack : String(error);
  appendRuntimeErrorLine(`${label} ${truncate(stack, MAX_STACK_CHARS)}`);
}
