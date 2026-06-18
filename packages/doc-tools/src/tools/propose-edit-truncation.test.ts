/**
 * H2 데이터안전 — propose_edit 80k 절단 경고 테스트
 *
 * 1. 긴 originalMarkdown(>2000자) hwpx 픽스처를 짧은 newMarkdown으로 propose_edit
 *    → proposal.warnings에 '절반 미만' 경고 포함
 * 2. 비슷한 길이 편집(원본의 60% 이상) → 경고 없음
 * 3. 짧은 원본(<2000자) 문서를 더 짧은 내용으로 편집 → 경고 없음(임계값 미만)
 *
 * 샌드박스: os.tmpdir() 하위 임시 디렉터리
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToHwpx } from "kordoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposeEditTool } from "./propose-edit.js";

const SESSION_ID = "test-propose-edit-trunc";

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-propose-edit-trunc-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("propose_edit — 80k 절단 경고(H2)", () => {
  it("긴 원본 hwpx → 짧은 newMarkdown → warnings에 '절반 미만' 경고 포함", async () => {
    // 2000자 이상의 원본 마크다운으로 hwpx 생성
    const longMarkdown = `# 긴 문서\n\n${"가나다라마바사아자차카타파하 ".repeat(150)}`; // ~2250자
    const hwpxBuf = await markdownToHwpx(longMarkdown);
    const filePath = join(testDir, "long.hwpx");
    await writeFile(filePath, Buffer.from(hwpxBuf));

    // 원본의 10% 미만인 짧은 내용으로 교체 시도
    const shortMarkdown = "# 제목\n\n짧은 내용만 남김";

    const ctx = { cwd: testDir, sessionId: SESSION_ID };
    const result = await proposeEditTool.propose?.({
      input: { path: filePath, newMarkdown: shortMarkdown, summary: "테스트" },
      ctx,
    });

    // 성공 proposal이어야 함
    expect(typeof result).toBe("object");
    const outcome = result as { proposal: { warnings: string[] }; commit: () => Promise<string> };
    expect(Array.isArray(outcome.proposal.warnings)).toBe(true);
    // '절반 미만' 경고가 포함되어야 함
    const hasWarning = outcome.proposal.warnings.some((w: string) => w.includes("절반 미만"));
    expect(hasWarning).toBe(true);
  });

  it("비슷한 길이(60% 이상) 편집 → 경고 없음", async () => {
    // 2000자 이상의 원본 마크다운으로 hwpx 생성
    const longMarkdown = `# 긴 문서\n\n${"가나다라마바사아자차카타파하 ".repeat(150)}`; // ~2250자
    const hwpxBuf = await markdownToHwpx(longMarkdown);
    const filePath = join(testDir, "similar.hwpx");
    await writeFile(filePath, Buffer.from(hwpxBuf));

    // 원본의 80% 정도 유지
    const similarMarkdown = `# 긴 문서(일부 수정)\n\n${"가나다라마바사아자차카타파하 ".repeat(120)}`; // ~1820자

    const ctx = { cwd: testDir, sessionId: SESSION_ID };
    const result = await proposeEditTool.propose?.({
      input: { path: filePath, newMarkdown: similarMarkdown, summary: "테스트" },
      ctx,
    });

    expect(typeof result).toBe("object");
    const outcome = result as { proposal: { warnings: string[] }; commit: () => Promise<string> };
    expect(Array.isArray(outcome.proposal.warnings)).toBe(true);
    // '절반 미만' 경고가 없어야 함
    const hasWarning = outcome.proposal.warnings.some((w: string) => w.includes("절반 미만"));
    expect(hasWarning).toBe(false);
  });

  it("짧은 원본(<2000자) → 임계값 미만이므로 경고 없음", async () => {
    // 짧은 원본
    const shortOriginal = "# 제목\n\n짧은 원본 문서입니다."; // ~30자
    const hwpxBuf = await markdownToHwpx(shortOriginal);
    const filePath = join(testDir, "short-orig.hwpx");
    await writeFile(filePath, Buffer.from(hwpxBuf));

    const veryShortMarkdown = "# 제목";

    const ctx = { cwd: testDir, sessionId: SESSION_ID };
    const result = await proposeEditTool.propose?.({
      input: { path: filePath, newMarkdown: veryShortMarkdown, summary: "테스트" },
      ctx,
    });

    expect(typeof result).toBe("object");
    const outcome = result as { proposal: { warnings: string[] }; commit: () => Promise<string> };
    // '절반 미만' 경고가 없어야 함(원본이 짧으면 경고 미발동)
    const hasWarning = outcome.proposal.warnings.some((w: string) => w.includes("절반 미만"));
    expect(hasWarning).toBe(false);
  });
});
