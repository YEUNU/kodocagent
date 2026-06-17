/**
 * list_backups / restore_backup 툴 — 백업 목록 조회 및 복원
 *
 * backupFile()이 생성하는 파일명 규칙:
 *   <ISO-ts>-<basename>
 *   예) 2026-06-16T23-18-42-393Z-보도자료.hwpx
 *
 * list_backups  : requiresApproval=false, execute
 * restore_backup: requiresApproval=true,  propose
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { KODOC_PATHS } from "@kodocagent/shared";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import { backupFile, commitStaged, markdownDiff, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 파일명 파싱 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * 백업 파일명을 타임스탬프 토큰과 원본 basename으로 분해한다.
 *
 * 형식: `^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$`
 */
function parseBackupFilename(filename: string): {
  tsToken: string;
  origBasename: string;
} | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/);
  if (!m) return null;
  return { tsToken: m[1]!, origBasename: m[2]! };
}

/**
 * 타임스탬프 토큰을 사람이 읽기 좋은 문자열로 변환한다.
 * 예) "2026-06-16T23-18-42-393Z" → "2026-06-16 23:18:42"
 */
function formatTimestamp(tsToken: string): string {
  // "2026-06-16T23-18-42-393Z" → "2026-06-16T23:18:42.393Z"
  const restored = tsToken.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z",
  );
  try {
    const d = new Date(restored);
    if (Number.isNaN(d.getTime())) return tsToken;
    // "2026-06-16 23:18:42"
    return d.toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return tsToken;
  }
}

// ─────────────────────────────────────────────────────────
// list_backups
// ─────────────────────────────────────────────────────────

const MAX_BACKUP_LIST = 50;

export const listBackupsSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("특정 파일의 백업만 보려면 그 파일 경로 (미지정 시 전체 백업)"),
});

export type ListBackupsInput = z.infer<typeof listBackupsSchema>;

export const listBackupsTool: ToolDefinition<ListBackupsInput> = {
  name: "list_backups",
  description:
    "백업 디렉터리의 백업 목록을 반환합니다. " +
    "path를 지정하면 해당 파일의 백업만, 미지정 시 전체 백업을 표시합니다. " +
    "최대 50건, 최신순 정렬.",
  inputSchema: listBackupsSchema,
  requiresApproval: false,

  execute: async ({
    input,
  }: {
    input: ListBackupsInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }): Promise<string> => {
    const backupsDir = KODOC_PATHS.backups;

    // 디렉터리 없거나 비어있는 경우
    let allEntries: string[];
    try {
      allEntries = await readdir(backupsDir);
    } catch {
      return "백업이 없습니다.";
    }

    if (allEntries.length === 0) {
      return "백업이 없습니다.";
    }

    // 파싱 가능한 항목만 수집
    interface BackupEntry {
      filename: string;
      fullPath: string;
      tsToken: string;
      origBasename: string;
      mtimeMs: number;
    }

    const parsed: BackupEntry[] = [];
    for (const filename of allEntries) {
      const info = parseBackupFilename(filename);
      if (!info) continue;
      const fullPath = join(backupsDir, filename);
      let mtimeMs = 0;
      try {
        const s = await stat(fullPath);
        mtimeMs = s.mtimeMs;
      } catch {
        // stat 실패 시 tsToken 기반 정렬 (fallback)
        mtimeMs = 0;
      }
      parsed.push({ filename, fullPath, ...info, mtimeMs });
    }

    // 필터: 특정 파일
    let filtered = parsed;
    if (input.path) {
      const targetBase = basename(input.path);
      filtered = parsed.filter((e) => e.origBasename === targetBase);
    }

    if (filtered.length === 0) {
      if (input.path) {
        return `해당 파일의 백업이 없습니다: ${basename(input.path)}`;
      }
      return "백업이 없습니다.";
    }

    // 최신순 정렬 (mtimeMs DESC, fallback: tsToken DESC)
    filtered.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return b.tsToken.localeCompare(a.tsToken);
    });

    const total = filtered.length;
    const truncated = filtered.length > MAX_BACKUP_LIST;
    const display = filtered.slice(0, MAX_BACKUP_LIST);

    const lines = display.map(
      (e, i) => `${i + 1}. ${e.origBasename}  [${formatTimestamp(e.tsToken)}]  ${e.fullPath}`,
    );

    const notice = truncated ? `\n(총 ${total}건 중 최신 ${MAX_BACKUP_LIST}건만 표시됩니다.)` : "";

    return lines.join("\n") + notice;
  },
};

// ─────────────────────────────────────────────────────────
// restore_backup
// ─────────────────────────────────────────────────────────

export const restoreBackupSchema = z.object({
  path: z.string().describe("복원할 대상 파일 경로"),
  backup: z
    .string()
    .optional()
    .describe("복원할 특정 백업 파일명 (list_backups 결과의 파일명; 미지정 시 가장 최근 백업)"),
  summary: z.string().optional().describe("복원 사유/요약"),
});

export type RestoreBackupInput = z.infer<typeof restoreBackupSchema>;

export const restoreBackupTool: ToolDefinition<RestoreBackupInput> = {
  name: "restore_backup",
  description:
    "백업 파일로 대상 파일을 복원합니다. " +
    "backup을 미지정 시 가장 최근 백업을 사용합니다. " +
    "복원 전 현재 파일도 자동 백업됩니다(복원도 되돌릴 수 있음). " +
    "사용자 승인이 필요합니다.",
  inputSchema: restoreBackupSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: RestoreBackupInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    // 1. 대상 경로 검증
    let safePath: string;
    try {
      safePath = await resolveSafePath(ctx.cwd, input.path);
    } catch (e) {
      return `경로 오류: ${e instanceof Error ? e.message : String(e)}`;
    }

    const targetBase = basename(safePath);
    const backupsDir = KODOC_PATHS.backups;

    // 2. 백업 목록 수집
    let allEntries: string[];
    try {
      allEntries = await readdir(backupsDir);
    } catch {
      return `백업을 찾을 수 없습니다: ${targetBase}. list_backups로 사용 가능한 백업을 먼저 확인하세요.`;
    }

    interface CandidateEntry {
      filename: string;
      fullPath: string;
      tsToken: string;
      mtimeMs: number;
    }

    const candidates: CandidateEntry[] = [];
    for (const filename of allEntries) {
      const info = parseBackupFilename(filename);
      if (!info) continue;
      if (info.origBasename !== targetBase) continue;
      const fullPath = join(backupsDir, filename);
      let mtimeMs = 0;
      try {
        const s = await stat(fullPath);
        mtimeMs = s.mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      candidates.push({ filename, fullPath, tsToken: info.tsToken, mtimeMs });
    }

    if (candidates.length === 0) {
      return `백업을 찾을 수 없습니다: ${targetBase}. list_backups로 사용 가능한 백업을 먼저 확인하세요.`;
    }

    const byNewest = (a: CandidateEntry, b: CandidateEntry) =>
      b.mtimeMs !== a.mtimeMs ? b.mtimeMs - a.mtimeMs : b.tsToken.localeCompare(a.tsToken);

    // 3. 선택: input.backup 지정 또는 최신
    let chosen: CandidateEntry;
    let ambiguityNote: string | null = null;
    const requested = input.backup?.trim();
    if (requested) {
      // 정확한 파일명 우선 — basename만 주면 endsWith가 모든 후보와 매칭돼
      // 엉뚱한(오래된) 백업이 조용히 선택되던 문제를 방지한다.
      const exact = candidates.find((c) => c.filename === requested);
      if (exact) {
        chosen = exact;
      } else {
        const matches = candidates.filter(
          (c) => c.filename.endsWith(requested) || c.fullPath.endsWith(requested),
        );
        if (matches.length === 0) {
          return `지정한 백업을 찾을 수 없습니다: ${input.backup}. list_backups로 사용 가능한 백업의 정확한 파일명을 확인하세요.`;
        }
        matches.sort(byNewest);
        chosen = matches[0]!;
        if (matches.length > 1) {
          ambiguityNote =
            `'${input.backup}'와 일치하는 백업이 ${matches.length}개여서 가장 최근(${formatTimestamp(chosen.tsToken)}) 것을 선택했습니다. ` +
            `특정 백업을 원하면 list_backups의 전체 파일명을 지정하세요.`;
        }
      }
    } else {
      // 최신순 정렬 후 첫 번째
      candidates.sort(byNewest);
      chosen = candidates[0]!;
    }

    // 4. 백업 파일 읽기
    let backupBytes: Buffer;
    try {
      backupBytes = await readFile(chosen.fullPath);
    } catch {
      return `백업 파일을 읽을 수 없습니다: ${chosen.fullPath}`;
    }

    // 5. 스테이징
    const stagedPath = await stageFile(ctx.sessionId, targetBase, backupBytes);

    // 6. diff / diff-summary 생성
    const ext = extname(targetBase).toLowerCase();
    const isText = ext === ".md" || ext === ".txt";

    let diff: string;
    if (isText) {
      let currentText = "";
      try {
        currentText = await readFile(safePath, "utf-8");
      } catch {
        currentText = "";
      }
      const backupText = backupBytes.toString("utf-8");
      diff = markdownDiff(currentText, backupText, targetBase);
    } else {
      // 바이너리: 인간 요약
      let currentSize = "파일 없음";
      try {
        const s = await stat(safePath);
        currentSize = `${s.size} bytes`;
      } catch {
        currentSize = "파일 없음";
      }
      const backupSize = `${backupBytes.length} bytes`;
      diff = [
        `복원 대상: ${safePath}`,
        `현재 파일: ${currentSize}`,
        `백업 파일: ${chosen.fullPath}`,
        `백업 시각: ${formatTimestamp(chosen.tsToken)}`,
        `백업 크기: ${backupSize}`,
        `→ 현재 파일을 위 백업으로 되돌립니다.`,
      ].join("\n");
    }

    // 7. 경고 목록
    const warnings: string[] = [];
    const autoSelected = !requested && candidates.length > 1;
    if (autoSelected) {
      warnings.push(
        `백업을 지정하지 않아 가장 최근 백업(${formatTimestamp(chosen.tsToken)})을 자동으로 선택했습니다. ` +
          `다른 백업을 원하면 list_backups로 확인 후 backup 파라미터를 지정하세요.`,
      );
    }
    if (ambiguityNote) {
      warnings.push(ambiguityNote);
    }
    warnings.push(
      "복원을 실행하면 현재 파일도 백업된 뒤 덮어쓰여집니다(복원 자체도 되돌릴 수 있음).",
    );

    const summary = input.summary ?? `백업으로 되돌리기: ${targetBase}`;
    const chosenBackupPath = chosen.fullPath;

    return {
      proposal: {
        id: crypto.randomUUID(),
        kind: "restore",
        targetPath: safePath,
        stagedPath,
        summary,
        diff,
        warnings,
      },
      commit: async (): Promise<string> => {
        const safetyBackup = await backupFile(safePath);
        await commitStaged(stagedPath, safePath);
        const safetyNote = safetyBackup ? ` (복원 전 현재 상태 백업: ${safetyBackup})` : "";
        return `복원 완료: ${safePath} ← ${chosenBackupPath}${safetyNote}`;
      },
    };
  },
};
