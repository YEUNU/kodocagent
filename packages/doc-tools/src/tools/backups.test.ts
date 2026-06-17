/**
 * list_backups / restore_backup 테스트
 *
 * vitest.setup.ts가 KODOCAGENT_HOME을 임시 디렉터리로 설정하므로
 * KODOC_PATHS.backups 는 실제 ~/.kodocagent/backups 가 아닌 임시 경로를 가리킨다.
 */

import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KODOC_PATHS } from "@kodocagent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProposeOutcome } from "../types.js";
import { listBackupsTool, restoreBackupTool } from "./backups.js";

// ─────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

function makeCtx(): { cwd: string; sessionId: string } {
  return {
    cwd: testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

/**
 * 백업 파일명 형식: <ISO-ts>-<basename>
 * ISO-ts는 :와 .를 -로 치환한 것
 */
function makeBackupFilename(isoString: string, origBasename: string): string {
  const ts = isoString.replace(/[:.]/g, "-");
  return `${ts}-${origBasename}`;
}

beforeEach(async () => {
  const rawDir = join(tmpdir(), `kodocagent-backups-test-${Date.now()}`);
  await mkdir(rawDir, { recursive: true });
  // realpath로 심링크(/var → /private/var) 해소
  testDir = await realpath(rawDir);
  // backups 디렉터리 사전 생성 (일부 테스트는 직접 생성)
  await mkdir(KODOC_PATHS.backups, { recursive: true });
});

afterEach(async () => {
  // 임시 testDir 정리
  await rm(testDir, { recursive: true, force: true });
  // KODOC_PATHS.backups 정리 (다음 테스트에 영향 없도록)
  await rm(KODOC_PATHS.backups, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────
// list_backups
// ─────────────────────────────────────────────────────────

describe("list_backups — 빈 백업 디렉터리", () => {
  it("백업이 없을 때 친절한 메시지를 반환한다", async () => {
    const ctx = makeCtx();
    const result = await listBackupsTool.execute!({ input: {}, ctx });
    expect(result).toBe("백업이 없습니다.");
  });
});

describe("list_backups — 백업 파일 존재", () => {
  const FILE_A = "보도자료.hwpx";
  const FILE_B = "계획서.docx";
  let backupA1: string;
  let backupA2: string;
  let backupB1: string;

  beforeEach(async () => {
    // 두 파일 각각 백업 생성
    backupA1 = makeBackupFilename("2026-06-16T10:00:00.000Z", FILE_A);
    backupA2 = makeBackupFilename("2026-06-16T12:30:00.000Z", FILE_A);
    backupB1 = makeBackupFilename("2026-06-15T08:00:00.000Z", FILE_B);

    await writeFile(join(KODOC_PATHS.backups, backupA1), "content-a1", "utf-8");
    await writeFile(join(KODOC_PATHS.backups, backupA2), "content-a2", "utf-8");
    await writeFile(join(KODOC_PATHS.backups, backupB1), "content-b1", "utf-8");
  });

  it("전체 백업 목록을 반환한다", async () => {
    const ctx = makeCtx();
    const result = await listBackupsTool.execute!({ input: {}, ctx });
    expect(result).toContain(FILE_A);
    expect(result).toContain(FILE_B);
  });

  it("path 필터로 해당 파일의 백업만 반환한다", async () => {
    const ctx = makeCtx();
    const result = await listBackupsTool.execute!({
      input: { path: FILE_A },
      ctx,
    });
    expect(result).toContain(FILE_A);
    expect(result).not.toContain(FILE_B);
    // 두 백업 모두 포함
    expect(result).toContain(backupA1);
    expect(result).toContain(backupA2);
  });

  it("필터 결과가 없으면 '해당 파일의 백업이 없습니다' 메시지를 반환한다", async () => {
    const ctx = makeCtx();
    const result = await listBackupsTool.execute!({
      input: { path: "없는파일.txt" },
      ctx,
    });
    expect(result).toContain("해당 파일의 백업이 없습니다");
  });

  it("full path로도 필터가 동작한다", async () => {
    const ctx = makeCtx();
    const result = await listBackupsTool.execute!({
      input: { path: join(testDir, FILE_A) },
      ctx,
    });
    expect(result).toContain(FILE_A);
    expect(result).not.toContain(FILE_B);
  });
});

// ─────────────────────────────────────────────────────────
// restore_backup
// ─────────────────────────────────────────────────────────

describe("restore_backup — 정상 복원", () => {
  const TARGET_BASENAME = "문서.txt";
  let targetPath: string;
  let backupFilename: string;
  let backupPath: string;
  const ORIGINAL_CONTENT = "원본 내용입니다.";
  const BACKUP_CONTENT = "백업된 내용입니다.";

  beforeEach(async () => {
    targetPath = join(testDir, TARGET_BASENAME);
    // 현재 파일 생성
    await writeFile(targetPath, ORIGINAL_CONTENT, "utf-8");
    // 백업 파일 생성
    backupFilename = makeBackupFilename("2026-06-16T10:00:00.000Z", TARGET_BASENAME);
    backupPath = join(KODOC_PATHS.backups, backupFilename);
    await writeFile(backupPath, BACKUP_CONTENT, "utf-8");
  });

  it("propose가 ProposeOutcome을 반환한다 (kind=restore)", async () => {
    const ctx = makeCtx();
    const result = await restoreBackupTool.propose!({
      input: { path: TARGET_BASENAME },
      ctx,
    });

    expect(typeof result).toBe("object");
    type ProposeResult = ProposeOutcome | string;
    const outcome = result as ProposeResult;
    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    expect(outcome.proposal.kind).toBe("restore");
    expect(outcome.proposal.targetPath).toBe(targetPath);
    expect(outcome.proposal.stagedPath).toBeTruthy();

    // staged 파일이 실제 존재한다
    await expect(stat(outcome.proposal.stagedPath)).resolves.toBeTruthy();
  });

  it("commit()이 대상 파일을 백업 내용으로 덮어쓴다", async () => {
    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      input: { path: TARGET_BASENAME },
      ctx,
    });

    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    const message = await outcome.commit();
    expect(message).toContain("복원 완료");
    expect(message).toContain(targetPath);

    // 파일 내용이 백업 내용으로 교체되었다
    const afterContent = await readFile(targetPath, "utf-8");
    expect(afterContent).toBe(BACKUP_CONTENT);
  });

  it("commit() 후 현재 파일(원본)의 안전 백업이 생성된다", async () => {
    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      input: { path: TARGET_BASENAME },
      ctx,
    });

    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    const message = await outcome.commit();

    // 안전 백업 경로가 메시지에 포함된다
    expect(message).toContain("복원 전 현재 상태 백업");

    // 안전 백업에는 원본 내용이 담겨 있다
    // 메시지에서 백업 경로 추출
    const safetyMatch = message.match(/복원 전 현재 상태 백업: (.+)\)/);
    expect(safetyMatch).toBeTruthy();
    const safetyPath = safetyMatch![1]!;
    const safetyContent = await readFile(safetyPath, "utf-8");
    expect(safetyContent).toBe(ORIGINAL_CONTENT);
  });

  it(".txt 파일의 proposal.diff에 unified diff가 포함된다", async () => {
    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      input: { path: TARGET_BASENAME },
      ctx,
    });

    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    // unified diff 형식: --- / +++ 헤더 포함
    expect(outcome.proposal.diff).toContain("---");
    expect(outcome.proposal.diff).toContain("+++");
    // 원본 내용과 백업 내용이 diff에 나타난다
    expect(outcome.proposal.diff).toContain(ORIGINAL_CONTENT);
    expect(outcome.proposal.diff).toContain(BACKUP_CONTENT);
  });

  it("warnings에 '복원을 실행하면...' 문구가 항상 포함된다", async () => {
    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      input: { path: TARGET_BASENAME },
      ctx,
    });

    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    expect(outcome.proposal.warnings.some((w) => w.includes("복원을 실행하면"))).toBe(true);
  });
});

describe("restore_backup — 백업 없음", () => {
  it("백업이 없으면 에러 문자열을 반환한다 (throw 하지 않음)", async () => {
    const ctx = makeCtx();
    const result = await restoreBackupTool.propose!({
      input: { path: "없는파일.txt" },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("백업을 찾을 수 없습니다");
    expect(result as string).toContain("list_backups");
  });
});

describe("restore_backup — 자동 선택 경고", () => {
  const TARGET = "보고서.txt";
  let targetPath: string;

  beforeEach(async () => {
    targetPath = join(testDir, TARGET);
    await writeFile(targetPath, "현재 내용", "utf-8");

    // 백업 2개 생성
    const b1 = makeBackupFilename("2026-06-16T08:00:00.000Z", TARGET);
    const b2 = makeBackupFilename("2026-06-16T12:00:00.000Z", TARGET);
    await writeFile(join(KODOC_PATHS.backups, b1), "오래된 백업", "utf-8");
    await writeFile(join(KODOC_PATHS.backups, b2), "최신 백업", "utf-8");
  });

  it("backup 미지정 + 후보 2개 이상 → 자동 선택 경고가 포함된다", async () => {
    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      input: { path: TARGET },
      ctx,
    });

    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    const hasAutoWarning = outcome.proposal.warnings.some((w) => w.includes("자동으로 선택"));
    expect(hasAutoWarning).toBe(true);
  });

  it("backup 지정 시 자동 선택 경고가 없다", async () => {
    // 어떤 백업 파일명을 지정하는지 확인
    const { readdir: rd } = await import("node:fs/promises");
    const entries = await rd(KODOC_PATHS.backups);
    const specificBackup = entries.find((e) => e.includes(TARGET));
    expect(specificBackup).toBeTruthy();

    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      input: { path: TARGET, backup: specificBackup },
      ctx,
    });

    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    const hasAutoWarning = outcome.proposal.warnings.some((w) => w.includes("자동으로 선택"));
    expect(hasAutoWarning).toBe(false);
  });
});

describe("restore_backup — 백업 지정 모호성 (BUG-1 회귀)", () => {
  const TARGET = "회귀.txt";
  let targetPath: string;

  beforeEach(async () => {
    targetPath = join(testDir, TARGET);
    await writeFile(targetPath, "현재 내용", "utf-8");
    // 같은 basename 백업 2개 (오래된 것 / 최신 것)
    const bOld = makeBackupFilename("2026-06-10T08:00:00.000Z", TARGET);
    const bNew = makeBackupFilename("2026-06-16T12:00:00.000Z", TARGET);
    await writeFile(join(KODOC_PATHS.backups, bOld), "오래된 내용", "utf-8");
    await writeFile(join(KODOC_PATHS.backups, bNew), "최신 내용", "utf-8");
  });

  it("backup에 basename만 주면 가장 최근 것을 선택하고 모호성 경고를 단다", async () => {
    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      // basename만 지정 — 여러 백업과 endsWith 매칭됨
      input: { path: TARGET, backup: TARGET },
      ctx,
    });
    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    // 최신 백업이 선택됨 (오래된 것이 조용히 선택되던 BUG-1 방지)
    expect(outcome.proposal.diff).toContain("최신 내용");
    expect(outcome.proposal.diff).not.toContain("오래된 내용");
    // 모호성 경고 포함
    expect(outcome.proposal.warnings.some((w) => w.includes("일치하는 백업이"))).toBe(true);
  });

  it("정확한 전체 파일명을 주면 그 백업을 선택하고 모호성 경고가 없다", async () => {
    const exactOld = makeBackupFilename("2026-06-10T08:00:00.000Z", TARGET);
    const ctx = makeCtx();
    const outcome = await restoreBackupTool.propose!({
      input: { path: TARGET, backup: exactOld },
      ctx,
    });
    if (typeof outcome === "string") throw new Error(`propose 오류: ${outcome}`);

    // 정확히 지정한(오래된) 백업이 선택됨
    expect(outcome.proposal.diff).toContain("오래된 내용");
    expect(outcome.proposal.warnings.some((w) => w.includes("일치하는 백업이"))).toBe(false);
  });
});
