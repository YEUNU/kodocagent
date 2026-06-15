/**
 * compare_documents 툴 단위 테스트
 *
 * 샌드박스: os.tmpdir() — 실제 ~/.kodocagent에 쓰지 않음.
 *
 * 테스트 케이스:
 * 1. 내용이 다른 두 hwpx 비교 → 통계와 변경 텍스트 포함 확인
 * 2. 동일한 문서 비교 → 변경 없음 반영 확인
 * 3. 존재하지 않는 경로 → "오류:" 접두 반환 확인
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToHwpx } from "@clazic/kordoc";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { compareDocumentsTool } from "./compare-documents.js";

/** compareDocumentsTool.execute는 requiresApproval=false이므로 항상 존재 */
async function runCompareDocuments(
  input: { pathA: string; pathB: string },
  ctx: ToolContext,
): Promise<string> {
  return (compareDocumentsTool.execute as NonNullable<typeof compareDocumentsTool.execute>)({
    input,
    ctx,
  });
}

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-compare-doc-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

function makeCtx(): ToolContext {
  return {
    cwd: testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

// ─────────────────────────────────────────────────────────
// 내용이 다른 두 hwpx 비교
// ─────────────────────────────────────────────────────────

describe("compare_documents — 내용이 다른 두 hwpx", () => {
  it("통계에 변경 항목이 포함되고 변경된 텍스트가 결과에 존재", async () => {
    const ctx = makeCtx();

    // 픽스처 A: 2025년 매출 48억
    const mdA = "# 제목\n\n2025년 매출 48억";
    const hwpxBufA = await markdownToHwpx(mdA);
    const pathA = join(testDir, "docA.hwpx");
    await writeFile(pathA, Buffer.from(hwpxBufA));

    // 픽스처 B: 2026년 매출 52억
    const mdB = "# 제목\n\n2026년 매출 52억";
    const hwpxBufB = await markdownToHwpx(mdB);
    const pathB = join(testDir, "docB.hwpx");
    await writeFile(pathB, Buffer.from(hwpxBufB));

    const result = await runCompareDocuments({ pathA, pathB }, ctx);

    expect(typeof result).toBe("string");

    // 오류가 아닌 정상 결과여야 한다
    expect(result).not.toMatch(/^오류:/);

    // 통계 테이블이 포함되어야 한다
    expect(result).toContain("변경 통계");

    // 변경 항목(수정 또는 추가/삭제)이 0이 아닌 수치를 포함해야 한다
    // 수정된 블록이 있거나 추가/삭제가 있어야 함
    const hasChange =
      result.includes("[수정]") || result.includes("[추가]") || result.includes("[삭제]");
    expect(hasChange).toBe(true);

    // 변경된 연도 또는 금액이 결과에 포함되어야 한다
    const hasChangedContent = result.includes("2026년") || result.includes("52억");
    expect(hasChangedContent).toBe(true);
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// 동일한 문서 비교
// ─────────────────────────────────────────────────────────

describe("compare_documents — 동일한 문서 비교", () => {
  it("같은 파일을 비교하면 변경 없음이 반영됨", async () => {
    const ctx = makeCtx();

    // 픽스처: 동일 내용
    const md = "# 동일 문서\n\n변경 없는 내용입니다.";
    const hwpxBuf = await markdownToHwpx(md);
    const path = join(testDir, "same.hwpx");
    await writeFile(path, Buffer.from(hwpxBuf));

    const result = await runCompareDocuments({ pathA: path, pathB: path }, ctx);

    expect(typeof result).toBe("string");
    expect(result).not.toMatch(/^오류:/);

    // unchanged 통계가 0보다 커야 한다 (변경 없는 블록 존재)
    // "변경 없음"이 결과에 포함되어야 한다 (통계 행 또는 안내 문구)
    const hasUnchanged = result.includes("변경 없음") || result.includes("동일합니다");
    expect(hasUnchanged).toBe(true);

    // 변경 항목([추가]/[삭제]/[수정])이 없어야 한다
    expect(result).not.toContain("[추가]");
    expect(result).not.toContain("[삭제]");
    expect(result).not.toContain("[수정]");
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// 오류 경로 — 존재하지 않는 파일
// ─────────────────────────────────────────────────────────

describe("compare_documents — 오류 경로", () => {
  it("존재하지 않는 pathA → '오류:' 접두 문자열 반환", async () => {
    const ctx = makeCtx();

    const missingPath = join(testDir, "does-not-exist-xyz999.hwpx");
    const md = "# 존재하는 문서\n\n본문";
    const hwpxBuf = await markdownToHwpx(md);
    const existingPath = join(testDir, "exists.hwpx");
    await writeFile(existingPath, Buffer.from(hwpxBuf));

    const result = await runCompareDocuments({ pathA: missingPath, pathB: existingPath }, ctx);

    expect(typeof result).toBe("string");
    expect(result).toMatch(/^오류:/);
  }, 30000);

  it("존재하지 않는 pathB → '오류:' 접두 문자열 반환", async () => {
    const ctx = makeCtx();

    const md = "# 존재하는 문서\n\n본문";
    const hwpxBuf = await markdownToHwpx(md);
    const existingPath = join(testDir, "exists2.hwpx");
    await writeFile(existingPath, Buffer.from(hwpxBuf));
    const missingPath = join(testDir, "does-not-exist-abc000.hwpx");

    const result = await runCompareDocuments({ pathA: existingPath, pathB: missingPath }, ctx);

    expect(typeof result).toBe("string");
    expect(result).toMatch(/^오류:/);
  }, 30000);
});
