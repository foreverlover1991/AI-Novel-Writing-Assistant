import { Prisma } from "@prisma/client";
import type { NovelWorldSyncRecordSummary, NovelWorldSyncSection } from "@ai-novel/shared/types/novelWorld";
import { prisma } from "../../../db/prisma";

interface WorldSyncRecordRow {
  id: string;
  direction: string;
  syncedFieldsJson: string | null;
  diffSummary: string | null;
  triggeredBy: string;
  createdAt: Date | string;
}

const MAX_SYNC_RECORD_LIMIT = 100;
const VALID_SYNC_SECTIONS = new Set<NovelWorldSyncSection>([
  "profile",
  "rules",
  "factions",
  "forces",
  "locations",
  "relations",
]);

function parseSyncedSections(raw: string | null): NovelWorldSyncSection[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((section): section is NovelWorldSyncSection => (
      typeof section === "string" && VALID_SYNC_SECTIONS.has(section as NovelWorldSyncSection)
    ));
  } catch {
    return [];
  }
}

export async function listNovelWorldSyncRecords(
  novelWorldId: string | null | undefined,
  limit = 5,
): Promise<NovelWorldSyncRecordSummary[]> {
  if (!novelWorldId) {
    return [];
  }
  // Postgres 无法从 LIMIT 的占位符推断参数类型（42P18），这里先把读取条数收敛成
  // 确定范围内的整数再拼进语句，两种数据库引擎都能执行。
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 5, 1), MAX_SYNC_RECORD_LIMIT);
  const rows = await prisma.$queryRaw<WorldSyncRecordRow[]>(Prisma.sql`
    SELECT
      "id",
      "direction",
      "syncedFieldsJson",
      "diffSummary",
      "triggeredBy",
      "createdAt"
    FROM "WorldSyncRecord"
    WHERE "novelWorldId" = ${novelWorldId}
    ORDER BY "createdAt" DESC
    LIMIT ${Prisma.raw(String(safeLimit))}
  `);
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    syncedSections: parseSyncedSections(row.syncedFieldsJson),
    diffSummary: row.diffSummary,
    triggeredBy: row.triggeredBy,
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}
