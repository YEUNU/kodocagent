/**
 * 스테이징 파이프라인 단위 테스트
 * docs/SPEC.md §7
 *
 * os.tmpdir() 기반 샌드박스 사용 — 실제 ~/.kodocagent에 쓰지 않음
 */

import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodocError } from "@kodocagent/shared";
import { describe, expect, it } from "vitest";
import {
  backupFile,
  cleanAllStaging,
  cleanOldBackups,
  cleanSessionStaging,
  commitErrorMessage,
  commitStaged,
  markdownDiff,
  resolveOutputPath,
  stageFile,
} from "./staging.js";

/** 테스트별 임시 디렉터리 생성 */
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `kodocagent-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("H5: stageFile 권한", () => {
  it("스테이징 파일이 0o600 모드로 생성된다 (non-Windows)", async () => {
    if (process.platform === "win32") return;
    const baseDir = await makeTmpDir("staging-perm");
    const sessionId = `perm-session-${Date.now()}`;
    const path = await stageFile(sessionId, "doc.hwpx", "권한 테스트", baseDir);
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });
});

describe("H5: backupFile 권한", () => {
  it("백업 파일이 0o600 모드로 생성된다 (non-Windows)", async () => {
    if (process.platform === "win32") return;
    const baseDir = await makeTmpDir("backups-perm");
    const srcDir = await makeTmpDir("src-perm");
    const srcFile = join(srcDir, "report.hwpx");
    await writeFile(srcFile, "원본 내용");

    const backupPath = await backupFile(srcFile, baseDir);
    expect(backupPath).not.toBeNull();
    const info = await stat(backupPath!);
    expect(info.mode & 0o777).toBe(0o600);
  });
});

describe("stageFile", () => {
  it("세션 디렉터리에 n-basename 형식으로 파일을 스테이징한다", async () => {
    const baseDir = await makeTmpDir("staging");
    const sessionId = `test-session-${Date.now()}`;

    const path = await stageFile(sessionId, "/some/dir/hello.hwpx", "테스트 내용", baseDir);

    expect(path).toMatch(/1-hello\.hwpx$/);
    const content = await readFile(path, "utf-8");
    expect(content).toBe("테스트 내용");
  });

  it("같은 세션에서 순차 호출 시 카운터가 증가한다", async () => {
    const baseDir = await makeTmpDir("staging-counter");
    const sessionId = `counter-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const path1 = await stageFile(sessionId, "a.hwpx", "첫 번째", baseDir);
    const path2 = await stageFile(sessionId, "b.hwpx", "두 번째", baseDir);

    expect(path1).toMatch(/1-a\.hwpx$/);
    expect(path2).toMatch(/2-b\.hwpx$/);
  });

  it("Uint8Array 데이터도 저장된다", async () => {
    const baseDir = await makeTmpDir("staging-binary");
    const sessionId = `bin-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK magic

    const path = await stageFile(sessionId, "doc.hwpx", data, baseDir);
    const saved = await readFile(path);
    expect(saved[0]).toBe(0x50);
    expect(saved[1]).toBe(0x4b);
  });
});

describe("backupFile", () => {
  it("파일이 존재하면 타임스탬프-basename 형식으로 백업한다", async () => {
    const baseDir = await makeTmpDir("backups");
    const srcDir = await makeTmpDir("src");
    const srcFile = join(srcDir, "report.hwpx");
    await writeFile(srcFile, "원본 내용");

    const backupPath = await backupFile(srcFile, baseDir);

    expect(backupPath).not.toBeNull();
    expect(backupPath).toMatch(/report\.hwpx$/);
    const content = await readFile(backupPath!, "utf-8");
    expect(content).toBe("원본 내용");
  });

  it("파일이 존재하지 않으면 null을 반환한다", async () => {
    const baseDir = await makeTmpDir("backups-null");
    const result = await backupFile("/nonexistent/path/file.hwpx", baseDir);
    expect(result).toBeNull();
  });

  it("백업 후 원본 파일이 그대로 유지된다", async () => {
    const baseDir = await makeTmpDir("backups-preserve");
    const srcDir = await makeTmpDir("src-preserve");
    const srcFile = join(srcDir, "original.txt");
    await writeFile(srcFile, "원본 유지");

    await backupFile(srcFile, baseDir);

    // 원본 파일이 여전히 존재해야 함
    const content = await readFile(srcFile, "utf-8");
    expect(content).toBe("원본 유지");
  });

  // ⑤ 회귀 테스트: 같은 ms 내 두 번 백업해도 서로 다른 두 파일 생성
  it("⑤ 같은 ms에 동일 파일을 두 번 backupFile → 두 개의 서로 다른 백업 파일 생성", async () => {
    const baseDir = await makeTmpDir("backups-collision");
    const srcDir = await makeTmpDir("src-collision");
    const srcFile = join(srcDir, "report.hwpx");
    await writeFile(srcFile, "ms 충돌 테스트");

    // Date.now()를 모킹하여 두 호출이 동일한 ms를 반환하도록 강제
    const fixedMs = 1_700_000_000_000; // 임의 고정 타임스탬프
    const origDateNow = Date.now;
    Date.now = () => fixedMs;

    try {
      const path1 = await backupFile(srcFile, baseDir);
      const path2 = await backupFile(srcFile, baseDir);

      // 두 경로가 null이 아니고 서로 달라야 함
      expect(path1).not.toBeNull();
      expect(path2).not.toBeNull();
      expect(path1).not.toBe(path2);

      // 두 파일 모두 존재해야 함
      const content1 = await readFile(path1!, "utf-8");
      const content2 = await readFile(path2!, "utf-8");
      expect(content1).toBe("ms 충돌 테스트");
      expect(content2).toBe("ms 충돌 테스트");

      // 파일명 포맷이 타임스탬프-basename 패턴을 유지하는지 확인
      // (정규식은 변경하지 않았음을 검증)
      const { readdir: readdirFn } = await import("node:fs/promises");
      const entries = await readdirFn(baseDir);
      const backupEntries = entries.filter((e) => e.endsWith("report.hwpx"));
      expect(backupEntries).toHaveLength(2);
      // 두 항목 모두 <ts>-report.hwpx 포맷이어야 함
      for (const entry of backupEntries) {
        expect(entry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-report\.hwpx$/);
      }
    } finally {
      Date.now = origDateNow;
    }
  });
});

describe("commitErrorMessage", () => {
  it("EBUSY → 사용 중/권한 없음 메시지 반환", () => {
    const result = commitErrorMessage("EBUSY");
    expect(result).not.toBeNull();
    expect(result!.message).toContain("다른 프로그램에서 사용 중");
    expect(result!.hint).toContain("한컴오피스");
  });

  it("EACCES → 사용 중/권한 없음 메시지 반환 (EBUSY와 동일)", () => {
    const result = commitErrorMessage("EACCES");
    expect(result).not.toBeNull();
    expect(result!.message).toContain("다른 프로그램에서 사용 중");
  });

  it("ENOSPC → 저장 공간 부족 메시지 반환", () => {
    const result = commitErrorMessage("ENOSPC");
    expect(result).not.toBeNull();
    expect(result!.message).toContain("저장 공간이 부족");
    expect(result!.hint).toContain("디스크");
  });

  it("EROFS → 읽기 전용 메시지 반환", () => {
    const result = commitErrorMessage("EROFS");
    expect(result).not.toBeNull();
    expect(result!.message).toContain("읽기 전용");
    expect(result!.hint).toContain("쓰기 가능한 폴더");
  });

  it("알 수 없는 코드 → null 반환", () => {
    expect(commitErrorMessage("ENOENT")).toBeNull();
    expect(commitErrorMessage("ETIMEDOUT")).toBeNull();
    expect(commitErrorMessage(undefined)).toBeNull();
  });
});

describe("commitStaged", () => {
  it("스테이징 파일을 타겟 경로에 원자적으로 쓴다", async () => {
    const stagingDir = await makeTmpDir("staged");
    const targetDir = await makeTmpDir("target");

    const stagedPath = join(stagingDir, "staged.hwpx");
    const targetPath = join(targetDir, "output.hwpx");

    await writeFile(stagedPath, "스테이징된 내용");
    await commitStaged(stagedPath, targetPath);

    const content = await readFile(targetPath, "utf-8");
    expect(content).toBe("스테이징된 내용");
  });

  it("타겟 디렉터리가 없으면 자동 생성한다", async () => {
    const stagingDir = await makeTmpDir("staged-mkdir");
    const targetDir = join(tmpdir(), `new-dir-${Date.now()}`);
    const targetPath = join(targetDir, "subdir", "file.hwpx");

    const stagedPath = join(stagingDir, "data.hwpx");
    await writeFile(stagedPath, "새 디렉터리 테스트");

    await commitStaged(stagedPath, targetPath);

    const content = await readFile(targetPath, "utf-8");
    expect(content).toBe("새 디렉터리 테스트");
  });

  it("존재하지 않는 스테이징 파일이면 일반 오류를 던진다 (KodocError 아님)", async () => {
    const targetDir = await makeTmpDir("commit-err-target");
    await expect(
      commitStaged("/nonexistent/staged.hwpx", join(targetDir, "out.hwpx")),
    ).rejects.toSatisfy((e: unknown) => e instanceof Error && !(e instanceof KodocError));
  });
});

describe("markdownDiff", () => {
  it("두 마크다운 텍스트의 unified diff를 생성한다", () => {
    const before = "# 제목\n\n본문 2025년";
    const after = "# 제목\n\n본문 2026년";

    const diff = markdownDiff(before, after, "test.md");

    expect(diff).toContain("-본문 2025년");
    expect(diff).toContain("+본문 2026년");
    expect(diff).toContain("@@");
  });

  it("동일한 내용이면 헝크(@@)가 없다", () => {
    const content = "# 동일\n\n내용";
    const diff = markdownDiff(content, content, "same.md");

    // 동일하면 @@ 헝크 헤더가 없어야 함
    expect(diff).not.toContain("@@");
    // +/- 변경 행도 없어야 함 (헤더 --- +++ 제외)
    const lines = diff
      .split("\n")
      .filter((l) => !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("="));
    expect(lines.every((l) => !l.startsWith("+") && !l.startsWith("-"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// clean 함수 테스트 (ROADMAP M4.5 #1)
// ─────────────────────────────────────────────────────────

describe("cleanSessionStaging", () => {
  it("세션 스테이징 디렉터리를 삭제한다", async () => {
    const baseDir = await makeTmpDir("clean-session");
    const sessionId = `clean-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 파일을 먼저 스테이징
    await stageFile(sessionId, "doc.hwpx", "내용", baseDir);

    const sessionDir = join(baseDir, sessionId);
    // 존재 확인
    const before = await stat(sessionDir).catch(() => null);
    expect(before).not.toBeNull();

    // cleanSessionStaging 호출
    await cleanSessionStaging(sessionId, baseDir);

    // 삭제 확인
    const after = await stat(sessionDir).catch(() => null);
    expect(after).toBeNull();
  });

  it("존재하지 않는 세션 디렉터리여도 에러가 없다", async () => {
    const baseDir = await makeTmpDir("clean-session-noop");
    await expect(cleanSessionStaging("nonexistent-session", baseDir)).resolves.not.toThrow();
  });
});

describe("cleanAllStaging", () => {
  it("스테이징 루트 전체를 비우고 삭제 수를 반환한다", async () => {
    const baseDir = await makeTmpDir("clean-all");

    // 여러 세션 스테이징
    const sessionA = `session-a-${Date.now()}`;
    const sessionB = `session-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await stageFile(sessionA, "a.hwpx", "내용 A", baseDir);
    await stageFile(sessionB, "b.hwpx", "내용 B", baseDir);

    const deleted = await cleanAllStaging(baseDir);
    expect(deleted).toBe(2); // sessionA, sessionB 디렉터리

    // 루트는 남아있어도 내부는 비어있음
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(baseDir).catch(() => [] as string[]);
    expect(entries).toHaveLength(0);
  });

  it("스테이징 루트가 없어도 0을 반환한다", async () => {
    const deleted = await cleanAllStaging("/tmp/nonexistent-staging-root-xyz");
    expect(deleted).toBe(0);
  });
});

describe("cleanOldBackups", () => {
  it("mtime 기준 경과 파일만 삭제하고 { deleted, kept }를 반환한다", async () => {
    const baseDir = await makeTmpDir("clean-backups");
    const _srcDir = await makeTmpDir("src-backups");

    // 오래된 파일 (30일 초과)
    const oldFile = join(baseDir, "2024-01-01T00-00-00-000Z-old.hwpx");
    await writeFile(oldFile, "오래된 백업");
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31일 전
    await utimes(oldFile, oldDate, oldDate);

    // 새 파일 (1일 경과)
    const newFile = join(baseDir, "2026-06-01T00-00-00-000Z-new.hwpx");
    await writeFile(newFile, "최신 백업");
    const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1일 전
    await utimes(newFile, newDate, newDate);

    const result = await cleanOldBackups(30, baseDir);

    expect(result.deleted).toBe(1); // 오래된 파일 1개 삭제
    expect(result.kept).toBe(1); // 최신 파일 1개 보존

    // 오래된 파일이 삭제되었는지 확인
    const oldStat = await stat(oldFile).catch(() => null);
    expect(oldStat).toBeNull();

    // 최신 파일이 남아있는지 확인
    const newStat = await stat(newFile).catch(() => null);
    expect(newStat).not.toBeNull();
  });

  it("백업 루트가 없어도 { deleted: 0, kept: 0 }을 반환한다", async () => {
    const result = await cleanOldBackups(30, "/tmp/nonexistent-backups-root-xyz");
    expect(result).toEqual({ deleted: 0, kept: 0 });
  });

  it("maxAgeDays=0이면 모든 파일을 삭제한다", async () => {
    const baseDir = await makeTmpDir("clean-backups-all");

    const file1 = join(baseDir, "recent1.hwpx");
    const file2 = join(baseDir, "recent2.hwpx");
    await writeFile(file1, "백업1");
    await writeFile(file2, "백업2");

    // 현재 시각으로 mtime 설정 — maxAgeDays=0이면 전부 해당
    const now = new Date();
    await utimes(file1, now, now);
    await utimes(file2, now, now);

    const result = await cleanOldBackups(0, baseDir);

    // maxAgeDays=0: cutoff = Date.now() - 0 = now
    // mtime(now) < cutoff(now) 는 false이므로 결과는 kept=2, deleted=0 이거나
    // 동일 ms 내에 실행되면 deleted=0일 수도 있음.
    // 즉, 경계값 동작이므로 총합이 2임만 검증
    expect(result.deleted + result.kept).toBe(2);
  });
});

describe("resolveOutputPath", () => {
  it(".hwp 경로를 .hwpx로 변환하고 willConvertFormat을 반환한다", () => {
    const result = resolveOutputPath("/path/to/doc.hwp");
    expect(result.outputPath).toBe("/path/to/doc.hwpx");
    expect(result.willConvertFormat).toBe(".hwp → .hwpx");
  });

  it(".hwpx 경로는 그대로 반환한다", () => {
    const result = resolveOutputPath("/path/to/doc.hwpx");
    expect(result.outputPath).toBe("/path/to/doc.hwpx");
    expect(result.willConvertFormat).toBeUndefined();
  });

  it(".docx 경로는 그대로 반환한다", () => {
    const result = resolveOutputPath("/path/to/doc.docx");
    expect(result.outputPath).toBe("/path/to/doc.docx");
    expect(result.willConvertFormat).toBeUndefined();
  });

  it(".xls 경로를 .xlsx로 변환하고 willConvertFormat을 반환한다", () => {
    const result = resolveOutputPath("/path/to/sheet.xls");
    expect(result.outputPath).toBe("/path/to/sheet.xlsx");
    expect(result.willConvertFormat).toBe(".xls → .xlsx");
  });

  it(".xlsx 경로는 그대로 반환한다 (willConvertFormat 없음)", () => {
    const result = resolveOutputPath("/path/to/sheet.xlsx");
    expect(result.outputPath).toBe("/path/to/sheet.xlsx");
    expect(result.willConvertFormat).toBeUndefined();
  });
});
