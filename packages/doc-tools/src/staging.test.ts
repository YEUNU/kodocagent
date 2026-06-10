/**
 * 스테이징 파이프라인 단위 테스트
 * docs/SPEC.md §7
 *
 * os.tmpdir() 기반 샌드박스 사용 — 실제 ~/.kodocagent에 쓰지 않음
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupFile, commitStaged, markdownDiff, resolveOutputPath, stageFile } from "./staging.js";

/** 테스트별 임시 디렉터리 생성 */
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `kodocagent-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

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
});
