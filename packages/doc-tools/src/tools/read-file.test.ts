import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileTool } from "./read-file.js";

const testDir = join(tmpdir(), `kodocagent-test-readfile-${Date.now()}`);
let ctx = { cwd: testDir, sessionId: "test" };

describe("read_file", () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    ctx = { cwd: await realpath(testDir), sessionId: "test" };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("텍스트 파일을 읽는다", async () => {
    await writeFile(join(testDir, "test.txt"), "안녕하세요", "utf-8");
    const result = await readFileTool.execute!({ input: { path: "test.txt" }, ctx });
    expect(result).toBe("안녕하세요");
  });

  it("256KB를 초과하면 에러를 반환한다", async () => {
    // 257KB 파일 생성
    const largeContent = "x".repeat(257 * 1024);
    await writeFile(join(testDir, "large.txt"), largeContent, "utf-8");
    const result = await readFileTool.execute!({ input: { path: "large.txt" }, ctx });
    expect(result).toContain("너무 큽니다");
  });

  it("존재하지 않는 파일은 에러를 반환한다", async () => {
    const result = await readFileTool.execute!({ input: { path: "nonexistent.txt" }, ctx });
    expect(result).toContain("오류");
  });

  it("cwd 이탈 경로는 KodocError를 던진다", async () => {
    await expect(
      readFileTool.execute!({ input: { path: "../escape.txt" }, ctx }),
    ).rejects.toThrow();
  });

  it("마크다운 파일을 읽는다", async () => {
    await writeFile(join(testDir, "readme.md"), "# 제목\n내용", "utf-8");
    const result = await readFileTool.execute!({ input: { path: "readme.md" }, ctx });
    expect(result).toContain("# 제목");
  });
});
