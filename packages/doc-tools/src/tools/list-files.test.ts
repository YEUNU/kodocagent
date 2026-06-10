import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFilesTool } from "./list-files.js";

const testDir = join(tmpdir(), `kodocagent-test-list-${Date.now()}`);
let ctx = { cwd: testDir, sessionId: "test" };

describe("list_files", () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    ctx = { cwd: await realpath(testDir), sessionId: "test" };
    // 다양한 파일 생성
    await writeFile(join(testDir, "문서.hwpx"), "hwpx", "utf-8");
    await writeFile(join(testDir, "보고서.docx"), "docx", "utf-8");
    await writeFile(join(testDir, "data.xlsx"), "xlsx", "utf-8");
    await writeFile(join(testDir, "readme.md"), "# 제목", "utf-8");
    await writeFile(join(testDir, "script.ts"), "// ts", "utf-8");
    await mkdir(join(testDir, "node_modules"), { recursive: true });
    await writeFile(join(testDir, "node_modules", "pkg.js"), "pkg", "utf-8");
    await mkdir(join(testDir, "subdir"), { recursive: true });
    await writeFile(join(testDir, "subdir", "nested.txt"), "text", "utf-8");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("파일 목록을 반환한다", async () => {
    const result = await listFilesTool.execute!({ input: {}, ctx });
    expect(result).toContain("문서.hwpx");
    expect(result).toContain("보고서.docx");
  });

  it("node_modules를 스킵한다", async () => {
    const result = await listFilesTool.execute!({ input: {}, ctx });
    expect(result).not.toContain("pkg.js");
    // node_modules 디렉터리 자체도 없어야 함 (SKIP_DIRS에 있으므로)
    expect(result).not.toContain("node_modules");
  });

  it("문서 파일이 먼저 표시된다", async () => {
    const result = await listFilesTool.execute!({ input: {}, ctx });
    const lines = result.split("\n");
    const hwpxIdx = lines.findIndex((l) => l.includes("문서.hwpx"));
    const tsIdx = lines.findIndex((l) => l.includes("script.ts"));
    // 문서 파일이 ts 파일보다 먼저
    expect(hwpxIdx).toBeLessThan(tsIdx);
  });

  it("서브 디렉터리 내 파일도 포함된다", async () => {
    const result = await listFilesTool.execute!({ input: {}, ctx });
    expect(result).toContain("nested.txt");
  });

  it("특정 서브 디렉터리만 조회할 수 있다", async () => {
    const result = await listFilesTool.execute!({ input: { dir: "subdir" }, ctx });
    expect(result).toContain("nested.txt");
    expect(result).not.toContain("문서.hwpx");
  });
});
