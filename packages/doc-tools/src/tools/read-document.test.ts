/**
 * read_document 픽스처 보강 테스트
 * ROADMAP M4.5 #4, v0.2.0 포맷 매트릭스 커버리지
 *
 * - exceljs로 생성한 .xlsx → read_document → 마크다운 검증
 * - md-to-docx로 생성한 .docx → read_document → 마크다운 검증
 * - 한자/특수기호 포함 hwpx 라운드트립
 * - .md 파일 직접 읽기 → 마크다운 검증
 * - 한글·한자·특수기호 포함 .txt 읽기 → 문자 보존 검증
 * - 존재하지 않는 경로 → "오류:" 접두 문자열 반환 검증
 *
 * 샌드박스: os.tmpdir() — 실제 ~/.kodocagent에 쓰지 않음
 *
 * [PDF 읽기 단위 테스트 제외 사유]
 * .pdf의 read_document 경로는 kordoc(parse)에 그대로 위임되며, 이 위임 동작은
 * hwpx/docx/xlsx 테스트로 이미 커버된다. kordoc의 PDF 파서(pdfjs-dist)는 pnpm
 * 개발 환경에서 wasm 경로 해석 버그로 빠른 오류 또는 30초+ 행(hang)을 비결정적으로
 * 일으켜 CI를 불안정하게 만든다(설치형 번들에서는 pdfjs-dist가 정상 해석되어 동작).
 * 의존성의 PDF 파서를 우리 단위 테스트로 검증할 이유가 없어 플레이키 회피를 위해 제외한다.
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

// ─────────────────────────────────────────────────────────
// MD 파일 읽기
//
// read_document가 .md/.markdown 파일을 kordoc 없이 직접 UTF-8로 읽어 반환한다.
// (kordoc 2.7.6은 .md를 UNSUPPORTED_FORMAT으로 처리하므로 우회함)
// ─────────────────────────────────────────────────────────

describe("read_document MD 읽기", () => {
  it(".md 파일 → read_document가 직접 처리하여 내용 포함 반환", async () => {
    const ctx = makeCtx();

    // 픽스처: 제목과 본문 단락을 가진 마크다운 파일
    const content = "# 제목\n\n본문 단락";
    const fixturePath = join(testDir, "test-readme.md");
    await writeFile(fixturePath, content, "utf-8");

    // read_document 실행
    const result = await runReadDocument({ path: fixturePath }, ctx);

    expect(typeof result).toBe("string");
    const text = result as string;

    // 평문 직접 처리: 원본 텍스트 내용이 반환값에 반드시 포함되어야 함
    expect(text).toContain("제목");
    expect(text).toContain("본문");
  }, 20000);
});

// ─────────────────────────────────────────────────────────
// TXT 파일 읽기 (한글·한자·특수기호 보존)
//
// read_document가 .txt/.text 파일을 kordoc 없이 직접 UTF-8로 읽어 반환한다.
// (kordoc 2.7.6은 .txt를 UNSUPPORTED_FORMAT으로 처리하므로 우회함)
// ─────────────────────────────────────────────────────────

describe("read_document TXT 읽기", () => {
  it("한글·한자·특수기호 포함 .txt → read_document가 직접 처리하여 문자 보존", async () => {
    const ctx = makeCtx();

    // 픽스처: 한국어 법률 문체 + 한자 + 특수기호
    const content = "근로기준법 제60조 §1 ① 漢字";
    const fixturePath = join(testDir, "statute.txt");
    await writeFile(fixturePath, content, "utf-8");

    // read_document 실행
    const result = await runReadDocument({ path: fixturePath }, ctx);

    expect(typeof result).toBe("string");
    const text = result as string;

    // 평문 직접 처리: 한글·한자·특수기호가 반환 텍스트에 반드시 보존되어야 함
    expect(text).toContain("근로기준법");
    expect(text).toContain("§");
    expect(text).toContain("①");
    expect(text).toContain("漢字");
  }, 20000);
});

// ─────────────────────────────────────────────────────────
// 오류 경로 — 존재하지 않는 파일
// ─────────────────────────────────────────────────────────

describe("read_document 오류 경로", () => {
  it("존재하지 않는 경로 → '오류:' 접두 문자열 반환", async () => {
    const ctx = makeCtx();

    // 절대 존재하지 않는 경로
    const missingPath = join(testDir, "does-not-exist-abc123.hwpx");

    // read_document 실행
    const result = await runReadDocument({ path: missingPath }, ctx);

    expect(typeof result).toBe("string");
    const text = result as string;
    // 오류 메시지는 반드시 "오류:" 접두어로 시작해야 함
    expect(text).toMatch(/^오류:/);
  }, 10000);
});
