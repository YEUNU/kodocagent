import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanPiiTool } from "./scan-pii.js";

const testDir = join(tmpdir(), `kodocagent-test-scanpii-${Date.now()}`);
let ctx = { cwd: testDir, sessionId: "test" };

describe("scan_pii", () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    ctx = { cwd: await realpath(testDir), sessionId: "test" };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("전화번호와 이메일이 포함된 .txt 파일에서 PII를 탐지해 마스킹 보고한다", async () => {
    const content = "담당자: 010-1234-5678\n연락처: user@example.com";
    await writeFile(join(testDir, "contact.txt"), content, "utf-8");

    const result = await scanPiiTool.execute?.({ input: { path: "contact.txt" }, ctx });

    expect(result).toContain("발견된 개인정보");
    expect(result).toContain("전화번호");
    expect(result).toContain("이메일");
    // 원문이 포함되지 않아야 함
    expect(result).not.toContain("1234");
    expect(result).not.toContain("ser@");
    // 마스킹 형식 확인
    expect(result).toContain("****");
    // 주의 문구
    expect(result).toContain("마스킹된 예시");
  });

  it("PII가 없는 .txt 파일은 '발견되지 않았습니다' 메시지를 반환한다", async () => {
    await writeFile(join(testDir, "clean.txt"), "회의는 3시, 예산 1,000,000원", "utf-8");

    const result = await scanPiiTool.execute?.({ input: { path: "clean.txt" }, ctx });

    expect(result).toContain("발견되지 않았습니다");
    expect(result).toContain("clean.txt");
  });

  it("존재하지 않는 파일은 오류 메시지를 반환한다 (throw 없이)", async () => {
    const result = await scanPiiTool.execute?.({ input: { path: "nonexistent.txt" }, ctx });
    expect(result).toContain("오류");
  });

  it("cwd 이탈 경로는 오류 메시지를 반환한다 (throw 없이)", async () => {
    const result = await scanPiiTool.execute?.({ input: { path: "../escape.txt" }, ctx });
    expect(result).toContain("오류");
  });

  it("주민등록번호가 포함된 .md 파일도 탐지한다", async () => {
    await writeFile(join(testDir, "doc.md"), "# 개인정보\n주민번호: 901215-1234567", "utf-8");

    const result = await scanPiiTool.execute?.({ input: { path: "doc.md" }, ctx });

    expect(result).toContain("발견된 개인정보");
    expect(result).toContain("주민등록번호");
    // 원문 뒷자리 미포함
    expect(result).not.toContain("1234567");
  });
});
