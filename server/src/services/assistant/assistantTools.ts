import fs from "node:fs";
import path from "node:path";

import { prisma } from "../../db/prisma";
import { getLlmSessionLogPath } from "../../llm/sessionLogFile";
import { resolveLogsRoot, resolveWorkspaceRoot } from "../../runtime/appPaths";
import { ragServices } from "../rag";
import type { RagOwnerType } from "../rag/types";
import type { AssistantDocCatalogEntry, AssistantLogSource, AssistantNovelSummary } from "../../prompting/prompts/assistant/assistant.prompts";

/**
 * AI 助手只读工具层。
 * 硬约束：本文件只做 prisma 查询 / 文件读取 / RAG 检索，绝不 import 或调用任何写服务，
 * 保证助手不会修改任何业务数据。所有函数在异常时降级返回空证据，不抛出中断对话。
 */

const MAX_DOC_CHARS = 12_000;
const MAX_RUNTIME_LINES = 200;
const MAX_LLM_SESSION_LINES = 100;
const MAX_NOVEL_CONTEXT_CHARS = 6_000;
const RUNTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const NOVEL_CONTENT_OWNER_TYPES: RagOwnerType[] = [
  "novel",
  "chapter",
  "world",
  "character",
  "chapter_summary",
  "consistency_fact",
];

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n…（内容已截断）` : value;
}

// ---------------------------------------------------------------------------
// 文档包（产品用法 / 写作概念）
// ---------------------------------------------------------------------------

/** 解析产品文档根：优先 env，其次镜像内 /app/docs，最后回退仓库 mintlify-docs（开发态）。 */
export function resolveAssistantDocsRoot(): string {
  const configured = process.env.ASSISTANT_DOCS_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const imageDocs = "/app/docs";
  if (fs.existsSync(imageDocs)) {
    return imageDocs;
  }
  return path.join(resolveWorkspaceRoot(), "mintlify-docs");
}

/** 把相对文档路径解析为绝对路径，并强制限定在文档根内（防路径穿越）。越界返回 null。 */
export function resolveDocPath(docsRoot: string, file: string): string | null {
  const normalizedRoot = path.resolve(docsRoot);
  const resolved = path.resolve(normalizedRoot, file);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

/** 解析 mdx 顶部 frontmatter 的 title / description。 */
function parseFrontmatter(content: string): { title: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const pick = (key: string): string => {
    if (!match) return "";
    const line = match[1]
      .split(/\r?\n/)
      .find((item) => item.trim().startsWith(`${key}:`));
    if (!line) return "";
    return line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
  };
  return { title: pick("title"), description: pick("description") };
}

/** 扫描文档根，产出可供文档选择 Prompt 使用的目录（features / guides / 术语表 / faq / quickstart）。 */
export function listDocsCatalog(docsRoot: string = resolveAssistantDocsRoot()): AssistantDocCatalogEntry[] {
  const entries: AssistantDocCatalogEntry[] = [];
  const push = (relative: string) => {
    const absolute = resolveDocPath(docsRoot, relative);
    if (!absolute || !fs.existsSync(absolute)) return;
    try {
      const meta = parseFrontmatter(fs.readFileSync(absolute, "utf8"));
      entries.push({
        file: relative,
        title: meta.title || path.basename(relative, ".mdx"),
        description: meta.description || "",
      });
    } catch {
      // 单个文档读取失败不影响目录整体。
    }
  };

  for (const dir of ["features", "guides"]) {
    const absoluteDir = resolveDocPath(docsRoot, dir);
    if (!absoluteDir || !fs.existsSync(absoluteDir)) continue;
    try {
      for (const name of fs.readdirSync(absoluteDir).filter((item) => item.endsWith(".mdx")).sort()) {
        push(path.posix.join(dir, name));
      }
    } catch {
      // 目录不可读则跳过。
    }
  }
  for (const file of ["glossary.mdx", "faq.mdx", "quickstart.mdx"]) {
    push(file);
  }
  return entries;
}

/** 读取选定文档，单文件截断到 12k 字符，拼成 Markdown 证据块。 */
export function readDocs(files: string[], docsRoot: string = resolveAssistantDocsRoot()): string {
  const blocks: string[] = [];
  for (const file of files) {
    const absolute = resolveDocPath(docsRoot, file);
    if (!absolute) {
      continue; // 越界路径直接丢弃。
    }
    try {
      if (!fs.existsSync(absolute)) continue;
      const raw = fs.readFileSync(absolute, "utf8").replace(/^---[\s\S]*?---\r?\n/, "");
      const meta = parseFrontmatter(fs.readFileSync(absolute, "utf8"));
      blocks.push(`### 文档：${meta.title || file}\n${truncate(raw.trim(), MAX_DOC_CHARS)}`);
    } catch {
      // 读取失败跳过该文档。
    }
  }
  return blocks.join("\n\n");
}

/** 写作基础概念证据：术语表 + 指南目录摘要。 */
export function writingGlossary(docsRoot: string = resolveAssistantDocsRoot()): string {
  const blocks: string[] = [];
  const glossaryPath = resolveDocPath(docsRoot, "glossary.mdx");
  if (glossaryPath && fs.existsSync(glossaryPath)) {
    try {
      const raw = fs.readFileSync(glossaryPath, "utf8").replace(/^---[\s\S]*?---\r?\n/, "");
      blocks.push(`### 写作术语表\n${truncate(raw.trim(), MAX_DOC_CHARS)}`);
    } catch {
      // 忽略。
    }
  }
  const guideEntries = listDocsCatalog(docsRoot).filter((entry) => entry.file.startsWith("guides/"));
  if (guideEntries.length > 0) {
    blocks.push([
      "### 可用写作指南目录",
      ...guideEntries.map((entry) => `- ${entry.title}（${entry.file}）：${entry.description}`),
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// 诊断（系统问题）
// ---------------------------------------------------------------------------

/** 读取 <logs>/server/ 下近 24h 的运行错误日志末 200 行。 */
function collectRuntimeErrors(): string {
  const serverLogDir = path.join(resolveLogsRoot(), "server");
  if (!fs.existsSync(serverLogDir)) {
    return "";
  }
  const cutoff = Date.now() - RUNTIME_WINDOW_MS;
  const lines: string[] = [];
  try {
    const files = fs.readdirSync(serverLogDir)
      .filter((name) => name.startsWith("runtime-") && name.endsWith(".log"))
      .sort();
    for (const name of files) {
      const content = fs.readFileSync(path.join(serverLogDir, name), "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const timestamp = Date.parse(trimmed.slice(0, 24));
        if (Number.isNaN(timestamp) || timestamp < cutoff) continue;
        lines.push(trimmed);
      }
    }
  } catch {
    return "";
  }
  return lines.slice(-MAX_RUNTIME_LINES).join("\n");
}

/** 读取当日 LLM 会话 jsonl 末 100 行错误事件。 */
function collectLlmSessionErrors(): string {
  const sessionPath = getLlmSessionLogPath();
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return "";
  }
  try {
    const content = fs.readFileSync(sessionPath, "utf8");
    const errorLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && /"?(error|failed|fail)"?/i.test(line));
    return errorLines.slice(-MAX_LLM_SESSION_LINES).join("\n");
  } catch {
    return "";
  }
}

/** 取最近 10 条失败任务记录（含 lastError、来源 lane）。 */
async function collectTaskRecords(): Promise<string> {
  try {
    const tasks = await prisma.novelWorkflowTask.findMany({
      where: { status: "failed" },
      orderBy: [{ finishedAt: "desc" }, { updatedAt: "desc" }],
      take: 10,
      select: {
        id: true,
        title: true,
        lane: true,
        status: true,
        currentStage: true,
        lastError: true,
        finishedAt: true,
        novelId: true,
      },
    });
    if (tasks.length === 0) {
      return "";
    }
    return tasks
      .map((task) => [
        `- 任务《${task.title}》 lane=${task.lane} stage=${task.currentStage ?? "未知"} 结束于=${task.finishedAt?.toISOString() ?? "未知"}`,
        task.lastError ? `  错误：${truncate(task.lastError, 500)}` : "  错误：（无记录）",
      ].join("\n"))
      .join("\n");
  } catch {
    return "";
  }
}

/** 汇总诊断证据。 */
export async function collectDiagnostics(sources: AssistantLogSource[]): Promise<string> {
  const blocks: string[] = [];
  if (sources.includes("runtime_errors")) {
    const runtime = collectRuntimeErrors();
    if (runtime) {
      blocks.push(`### 运行错误日志（近 24 小时末 ${MAX_RUNTIME_LINES} 行）\n${runtime}`);
    }
  }
  if (sources.includes("task_records")) {
    const tasks = await collectTaskRecords();
    if (tasks) {
      blocks.push(`### 最近失败任务记录\n${tasks}`);
    }
  }
  if (sources.includes("llm_sessions")) {
    const llm = collectLlmSessionErrors();
    if (llm) {
      blocks.push(`### 模型调用会话错误事件\n${llm}`);
    }
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// 小说内容
// ---------------------------------------------------------------------------

/** 小说清单（供意图路由判断目标小说）。 */
export async function listNovelSummaries(): Promise<AssistantNovelSummary[]> {
  try {
    const novels = await prisma.novel.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, title: true, _count: { select: { chapters: true } } },
    });
    return novels.map((novel) => ({
      id: novel.id,
      title: novel.title,
      chapterCount: novel._count.chapters,
    }));
  } catch {
    return [];
  }
}

/** 小说概览：标题/题材/进度/卷章结构/最近章节标题。 */
async function novelOverview(novelId: string): Promise<string> {
  const novel = await prisma.novel.findUnique({
    where: { id: novelId },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      writingMode: true,
      targetWordCount: true,
      genre: { select: { name: true } },
    },
  });
  if (!novel) {
    return "";
  }
  const recentChapters = await prisma.chapter.findMany({
    where: { novelId },
    orderBy: { order: "desc" },
    take: 8,
    select: { title: true, order: true, targetWordCount: true },
  });
  const chapterCount = await prisma.chapter.count({ where: { novelId } });
  return [
    `### 小说概览：《${novel.title}》`,
    `- 题材：${novel.genre?.name ?? "未设置"}；状态：${novel.status}；创作模式：${novel.writingMode}`,
    novel.description ? `- 简介：${truncate(novel.description, 400)}` : "",
    `- 已写章节数：${chapterCount}${novel.targetWordCount ? `；目标字数：${novel.targetWordCount}` : ""}`,
    recentChapters.length > 0
      ? `- 最近章节（新→旧）：${recentChapters.map((chapter) => `第${chapter.order}章《${chapter.title}》`).join("、")}`
      : "",
  ].filter(Boolean).join("\n");
}

/** 按检索 query 命中章节全文（RAG 不可用时的降级），每章截断 6k，最多 2 章。 */
async function chapterFallback(novelId: string, query: string): Promise<string> {
  const chapters = await prisma.chapter.findMany({
    where: { novelId },
    orderBy: { order: "desc" },
    take: 20,
    select: { title: true, order: true, content: true },
  });
  const keywords = query.replace(/[，。？！、\s]+/g, "").slice(0, 20);
  const matched = chapters
    .filter((chapter) => keywords && (chapter.content ?? "").includes(keywords))
    .slice(0, 2);
  const targets = matched.length > 0 ? matched : chapters.slice(0, 2);
  return targets
    .map((chapter) => `### 第${chapter.order}章《${chapter.title}》\n${truncate((chapter.content ?? "").trim(), MAX_NOVEL_CONTEXT_CHARS)}`)
    .join("\n\n");
}

/** 小说内容证据：概览 + RAG 检索 top4（可用时）或章节降级。 */
export async function novelContext(novelId: string | null, retrievalQuery: string | null): Promise<string> {
  if (!novelId) {
    return "";
  }
  const blocks: string[] = [];
  try {
    const overview = await novelOverview(novelId);
    if (overview) blocks.push(overview);
  } catch {
    // 概览失败继续尝试检索。
  }

  const query = retrievalQuery?.trim();
  if (query) {
    try {
      const chunks = await ragServices.hybridRetrievalService.retrieve(query, {
        novelId,
        ownerTypes: NOVEL_CONTENT_OWNER_TYPES,
        finalTopK: 4,
      });
      if (chunks.length > 0) {
        blocks.push([
          "### 相关片段（检索命中）",
          ...chunks.map((chunk) => `- [${chunk.ownerType}${chunk.title ? ` · ${chunk.title}` : ""}] ${truncate(chunk.chunkText.trim(), 800)}`),
        ].join("\n"));
      } else {
        const fallback = await chapterFallback(novelId, query);
        if (fallback) blocks.push(fallback);
      }
    } catch {
      // RAG 不可用时降级到章节全文。
      try {
        const fallback = await chapterFallback(novelId, query);
        if (fallback) blocks.push(fallback);
      } catch {
        // 忽略。
      }
    }
  }
  return blocks.join("\n\n");
}
