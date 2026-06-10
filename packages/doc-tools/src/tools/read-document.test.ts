/**
 * read_document 픽스처 보강 테스트
 * ROADMAP M4.5 #4
 *
 * - exceljs로 생성한 .xlsx → read_document → 마크다운 검증
 * - md-to-docx로 생성한 .docx → read_document → 마크다운 검증
 * - 한자/특수기호 포함 hwpx 라운드트립
 *
 * 샌드박스: os.tmpdir() — 실제 ~/.kodocagent에 쓰지 않음
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToHwpx } from "@clazic/kordoc";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { markdownToDocx } from "../md-to-docx.js";
import type { ToolContext } from "../types.js";
import { readDocumentTool } from "./read-document.js";

/** readDocumentTool.execute는 항상 존재 — 타입 단순화 헬퍼 */
async function runReadDocument(input: { path: string; pages?: string }, ctx: ToolContext) {
  // readDocumentTool.execute는 requiresApproval=false 툴에서 반드시 존재함
  return (readDocumentTool.execute as NonNullable<typeof readDocumentTool.execute>)({ input, ctx });
}

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-read-doc-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

function makeCtx() {
  return {
    cwd: testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

// ─────────────────────────────────────────────────────────
// XLSX 픽스처 보강
// ─────────────────────────────────────────────────────────

describe("read_document XLSX 실파싱", () => {
  it("exceljs로 생성한 .xlsx → 마크다운에 셀 값 포함", async () => {
    const ctx = makeCtx();

    // exceljs로 픽스처 생성: 시트명 "매출", A1=항목, B1=금액, A2=라이선스, B2=1200
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("매출");
    sheet.getCell("A1").value = "항목";
    sheet.getCell("B1").value = "금액";
    sheet.getCell("A2").value = "라이선스";
    sheet.getCell("B2").value = 1200;

    const xlsxBuf = await workbook.xlsx.writeBuffer();
    const fixturePath = join(testDir, "sales.xlsx");
    await writeFile(fixturePath, new Uint8Array(xlsxBuf as unknown as ArrayBuffer));

    // read_document 실행
    const result = await runReadDocument({ path: fixturePath }, ctx);

    expect(typeof result).toBe("string");
    const md = result as string;
    // 마크다운에 "라이선스" 포함 확인
    expect(md).toContain("라이선스");
  }, 20000);
});

// ─────────────────────────────────────────────────────────
// DOCX 픽스처 보강
// ─────────────────────────────────────────────────────────

describe("read_document DOCX 실파싱", () => {
  it("md-to-docx로 생성한 .docx → 마크다운에 제목 포함", async () => {
    const ctx = makeCtx();

    // markdownToDocx로 .docx 생성
    const srcMd = "# 제목입니다\n\n본문 내용이 여기 있습니다.";
    const docxBuf = await markdownToDocx(srcMd);
    const fixturePath = join(testDir, "test-doc.docx");
    await writeFile(fixturePath, docxBuf);

    // read_document 실행
    const result = await runReadDocument({ path: fixturePath }, ctx);

    expect(typeof result).toBe("string");
    const md = result as string;
    // 마크다운에 제목 텍스트 포함 확인
    expect(md).toContain("제목입니다");
  }, 20000);
});

// ─────────────────────────────────────────────────────────
// HWPX 한자/특수기호 라운드트립
// ─────────────────────────────────────────────────────────

describe("read_document HWPX 한자/특수기호 라운드트립", () => {
  it("한자·특수기호 포함 hwpx → 마크다운에 해당 문자 보존", async () => {
    const ctx = makeCtx();

    // markdownToHwpx로 한자·특수기호 포함 hwpx 생성
    const srcMd = "# 漢字 §1 ①항\n\n테스트 본문입니다.";
    const hwpxBuf = await markdownToHwpx(srcMd);
    const fixturePath = join(testDir, "hanja-test.hwpx");
    await writeFile(fixturePath, Buffer.from(hwpxBuf));

    // read_document 실행
    const result = await runReadDocument({ path: fixturePath }, ctx);

    expect(typeof result).toBe("string");
    const md = result as string;
    // 한자 및 특수기호 보존 확인
    expect(md).toContain("漢字");
    expect(md).toContain("§");
    expect(md).toContain("①");
  }, 30000);
});
