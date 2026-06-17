/**
 * propose_redact_pii 통합 테스트
 *
 * 1. PII가 포함된 .txt → ProposeOutcome 반환; commit 후 원문 없음·마스킹 있음; diff에 원문 없음
 * 2. PII가 없는 .txt → 노-op 문자열 반환 (proposal 아님)
 * 3. .docx → 미지원 포맷 오류 문자열
 */

import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeRedactPiiTool } from "./propose-redact-pii.js";

const TEST_DIR_BASE = join(tmpdir(), `kodocagent-test-redact-pii-${Date.now()}`);

let testDir: string;
let ctx: { cwd: string; sessionId: string };

beforeEach(async () => {
  testDir = `${TEST_DIR_BASE}-${Math.random().toString(36).slice(2)}`;
  await mkdir(testDir, { recursive: true });
  ctx = {
    cwd: await realpath(testDir),
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("proposeRedactPiiTool", () => {
  it("PII가 포함된 .txt → ProposeOutcome 반환, commit 후 원문 제거·마스킹 확인, diff에 원문 없음", async () => {
    const rawPhone = "010-1234-5678";
    const rawEmail = "user@example.com";
    const rawRrn = "901215-1234567";
    const content = [
      `담당자: 홍길동`,
      `전화: ${rawPhone}`,
      `이메일: ${rawEmail}`,
      `주민번호: ${rawRrn}`,
    ].join("\n");

    const filename = "contact.txt";
    await writeFile(join(testDir, filename), content, "utf-8");

    const result = await proposeRedactPiiTool.propose?.({
      input: { path: filename },
      ctx,
    });

    // ProposeOutcome이어야 한다 (string이면 오류)
    expect(typeof result).not.toBe("string");
    const outcome = result as Exclude<typeof result, string | undefined>;

    expect(outcome.proposal.kind).toBe("redact-pii");
    expect(outcome.proposal.targetPath).toContain(filename);

    // diff에 원문 PII가 없어야 한다
    const diff = outcome.proposal.diff;
    expect(diff).not.toContain("1234-5678");
    expect(diff).not.toContain("user@");
    expect(diff).not.toContain("901215-1234567");
    // diff에는 마스킹 형태나 건수가 포함되어야 한다
    expect(diff).toContain("건");

    // commit 실행
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain(filename);

    // 커밋된 파일에서 원문 PII가 없어야 한다
    const saved = await readFile(outcome.proposal.targetPath, "utf-8");
    expect(saved).not.toContain("1234-5678");
    expect(saved).not.toContain("user@example");
    expect(saved).not.toContain("901215-1234567");
    // 마스킹 형태가 있어야 한다
    expect(saved).toContain("****");
  });

  it("PII가 없는 .txt → 노-op 문자열 반환 (proposal 없음)", async () => {
    await writeFile(
      join(testDir, "clean.txt"),
      "회의는 3시입니다. 예산은 1,000,000원입니다.",
      "utf-8",
    );

    const result = await proposeRedactPiiTool.propose?.({
      input: { path: "clean.txt" },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("발견되지 않아");
  });

  it(".docx 경로 → 미지원 포맷 오류 문자열", async () => {
    // 실제 파일이 없어도 경로 확인 전에 ext 체크가 된다
    // resolveSafePath가 ENOENT에서 부모 디렉터리를 사용하므로 testDir 안에 가짜 .docx 만들기
    await writeFile(join(testDir, "test.docx"), "PK fake", "utf-8");

    const result = await proposeRedactPiiTool.propose?.({
      input: { path: "test.docx" },
      ctx,
    });

    expect(typeof result).toBe("string");
    const msg = result as string;
    expect(msg).toContain("오류");
    expect(msg).toContain(".hwpx");
  });
});
