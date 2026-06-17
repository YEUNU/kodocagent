/**
 * find_in_document 테스트
 *
 * 1. findInSectionXmls 순수 함수 단위 테스트
 *    - 표 셀 매칭 → tableIndex / row / col 좌표 확인
 *    - 본문 매칭 → 섹션 번호 확인
 *    - 2개 섹션 → 두 번째 섹션 표의 tableIndex가 연속됨
 *    - 매칭 없음 → []
 *    - caseSensitive 옵션
 * 2. findInDocumentTool execute 통합 테스트 (실제 HWPX ZIP 생성)
 *    - .hwpx가 아닌 확장자 → 한국어 안내 문자열
 *    - 존재하지 않는 파일 → 오류
 *    - 실제 ZIP에서 셀 검색 → 좌표 포함 결과
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findInDocumentTool, findInSectionXmls } from "./find-in-document.js";

// ─────────────────────────────────────────────────────────
// 섹션 XML 픽스처 빌더
// ─────────────────────────────────────────────────────────

/**
 * <hp:tc> XML 조각을 생성한다.
 * propose-cell-edit.test.ts의 makeSimpleTcXml과 동일한 구조.
 */
function makeTcXml(colAddr: number, rowAddr: number, text: string): string {
  return (
    `<hp:tc name="">` +
    `<hp:subList><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="${colAddr}" rowAddr="${rowAddr}"/>` +
    `<hp:cellSpan colSpan="1" rowSpan="1"/>` +
    `<hp:cellSz width="1000" height="500"/>` +
    `</hp:tc>`
  );
}

function makeTblXml(id: number, tcs: string[]): string {
  return (
    `<hp:tbl id="${id}" rowCnt="1" colCnt="${tcs.length}">` +
    `<hp:tr>${tcs.join("")}</hp:tr>` +
    `</hp:tbl>`
  );
}

/**
 * 본문 단락(표 밖).
 */
function makeParaXml(text: string): string {
  return `<hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p>`;
}

function makeSectionXml(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hs:sec>${content}</hs:sec>`;
}

// ─────────────────────────────────────────────────────────
// 세션 컨텍스트 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-find-in-doc-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(() => {
  // OS가 정리
});

function makeCtx(subDir?: string): { cwd: string; sessionId: string } {
  return {
    cwd: subDir ?? testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

// ─────────────────────────────────────────────────────────
// 최소 HWPX ZIP 생성 헬퍼
// ─────────────────────────────────────────────────────────

async function makeMinimalHwpx(sectionXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  zip.file("Contents/section0.xml", sectionXml);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buf as Buffer;
}

// ─────────────────────────────────────────────────────────
// 1. findInSectionXmls 단위 테스트
// ─────────────────────────────────────────────────────────

describe("findInSectionXmls — 표 셀 매칭", () => {
  it("셀 텍스트와 일치하면 tableIndex/row/col 좌표를 반환한다", () => {
    const tc00 = makeTcXml(0, 0, "홍길동");
    const tc10 = makeTcXml(1, 0, "김철수");
    const tbl = makeTblXml(1, [tc00, tc10]);
    const xml = makeSectionXml(tbl);

    const hits = findInSectionXmls([xml], "홍길동", false);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.kind).toBe("표");
    if (hit?.kind === "표") {
      expect(hit.tableIndex).toBe(0);
      expect(hit.row).toBe(0);
      expect(hit.col).toBe(0);
      expect(hit.text).toContain("홍길동");
    }
  });

  it("row/col이 0-based cellAddr와 일치한다", () => {
    // tc at colAddr=2, rowAddr=1
    const tc = makeTcXml(2, 1, "대상셀");
    const tbl = makeTblXml(1, [tc]);
    const xml = makeSectionXml(tbl);

    const hits = findInSectionXmls([xml], "대상셀", false);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    if (hit?.kind === "표") {
      expect(hit.row).toBe(1);
      expect(hit.col).toBe(2);
    }
  });

  it("두 번째 섹션 첫 번째 표의 tableIndex는 1 (globalOffset 누적)", () => {
    // 섹션0: 표 1개 (tableIndex=0)
    const tbl0 = makeTblXml(1, [makeTcXml(0, 0, "섹션0셀")]);
    const xml0 = makeSectionXml(tbl0);

    // 섹션1: 표 1개 → globalOffset=1 이므로 tableIndex=1
    const tbl1 = makeTblXml(2, [makeTcXml(0, 0, "섹션1셀")]);
    const xml1 = makeSectionXml(tbl1);

    const hits = findInSectionXmls([xml0, xml1], "섹션1셀", false);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    if (hit?.kind === "표") {
      expect(hit.tableIndex).toBe(1);
    }
  });

  it("두 섹션 각각에 표가 있으면 tableIndex가 연속된다 (0, 1)", () => {
    const xml0 = makeSectionXml(makeTblXml(1, [makeTcXml(0, 0, "셀A")]));
    const xml1 = makeSectionXml(makeTblXml(2, [makeTcXml(0, 0, "셀A")]));

    const hits = findInSectionXmls([xml0, xml1], "셀A", false);
    expect(hits).toHaveLength(2);
    const indices = hits.map((h) => (h.kind === "표" ? h.tableIndex : -1));
    expect(indices).toContain(0);
    expect(indices).toContain(1);
  });

  it("매칭 없으면 빈 배열을 반환한다", () => {
    const xml = makeSectionXml(makeTblXml(1, [makeTcXml(0, 0, "홍길동")]));
    const hits = findInSectionXmls([xml], "존재안함", false);
    expect(hits).toHaveLength(0);
  });

  it("caseSensitive=false이면 대소문자 무시", () => {
    const xml = makeSectionXml(makeTblXml(1, [makeTcXml(0, 0, "Hello World")]));
    const hits = findInSectionXmls([xml], "hello", false);
    expect(hits).toHaveLength(1);
  });

  it("caseSensitive=true이면 대소문자 구분", () => {
    const xml = makeSectionXml(makeTblXml(1, [makeTcXml(0, 0, "Hello World")]));
    const noHit = findInSectionXmls([xml], "hello", true);
    expect(noHit).toHaveLength(0);

    const hit = findInSectionXmls([xml], "Hello", true);
    expect(hit).toHaveLength(1);
  });
});

describe("findInSectionXmls — 본문 매칭", () => {
  it("표 밖 본문 단락을 찾으면 본문 hit를 반환한다", () => {
    const para = makeParaXml("본문텍스트입니다");
    const xml = makeSectionXml(para);

    const hits = findInSectionXmls([xml], "본문텍스트", false);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.kind).toBe("본문");
    if (hit?.kind === "본문") {
      expect(hit.section).toBe(0);
      expect(hit.text).toContain("본문텍스트");
    }
  });

  it("표 안 텍스트와 본문 텍스트가 동시에 매칭되면 둘 다 반환한다", () => {
    const tc = makeTcXml(0, 0, "검색어포함셀");
    const tbl = makeTblXml(1, [tc]);
    const para = makeParaXml("검색어포함본문");
    const xml = makeSectionXml(tbl + para);

    const tableHits = findInSectionXmls([xml], "검색어포함셀", false);
    expect(tableHits.some((h) => h.kind === "표")).toBe(true);

    const paraHits = findInSectionXmls([xml], "검색어포함본문", false);
    expect(paraHits.some((h) => h.kind === "본문")).toBe(true);
  });

  it("표 안의 텍스트는 본문 hit로 중복 반환되지 않는다", () => {
    const tc = makeTcXml(0, 0, "유일한셀");
    const tbl = makeTblXml(1, [tc]);
    const xml = makeSectionXml(tbl);

    const hits = findInSectionXmls([xml], "유일한셀", false);
    // 표 hit만 있어야 함 — 본문 hit 없음
    expect(hits.every((h) => h.kind === "표")).toBe(true);
  });

  it("두 번째 섹션 본문은 section=1을 반환한다", () => {
    const xml0 = makeSectionXml(makeParaXml("섹션0본문"));
    const xml1 = makeSectionXml(makeParaXml("섹션1본문"));

    const hits = findInSectionXmls([xml0, xml1], "섹션1본문", false);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    if (hit?.kind === "본문") {
      expect(hit.section).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 2. findInDocumentTool execute 통합 테스트
// ─────────────────────────────────────────────────────────

describe("findInDocumentTool.execute", () => {
  it(".hwpx가 아닌 확장자이면 한국어 안내 문자열 반환", async () => {
    const ctx = makeCtx();
    const result = await findInDocumentTool.execute?.({
      input: { path: "test.docx", query: "찾기" },
      ctx,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("hwpx 전용");
  });

  it("존재하지 않는 파일이면 오류 문자열 반환", async () => {
    const ctx = makeCtx();
    const result = await findInDocumentTool.execute?.({
      input: { path: "nonexistent.hwpx", query: "찾기" },
      ctx,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("오류");
  });

  it("실제 ZIP에서 셀 검색 → tableIndex/row/col 포함 한국어 결과", async () => {
    const tc = makeTcXml(0, 0, "찾기대상텍스트");
    const tbl = makeTblXml(1, [tc]);
    const xml = makeSectionXml(tbl);
    const buf = await makeMinimalHwpx(xml);

    const dir = join(testDir, `find-integration-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "sample.hwpx");
    await writeFile(filePath, buf);

    const ctx = makeCtx(dir);
    const result = await findInDocumentTool.execute?.({
      input: { path: "sample.hwpx", query: "찾기대상텍스트" },
      ctx,
    });

    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("tableIndex=0");
    expect(text).toContain("row=0");
    expect(text).toContain("col=0");
    expect(text).toContain("propose_cell_edit");
  });

  it("매칭 없으면 '찾지 못했습니다' 문자열 반환", async () => {
    const tc = makeTcXml(0, 0, "다른텍스트");
    const tbl = makeTblXml(1, [tc]);
    const xml = makeSectionXml(tbl);
    const buf = await makeMinimalHwpx(xml);

    const dir = join(testDir, `find-nomatch-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "empty.hwpx"), buf);

    const ctx = makeCtx(dir);
    const result = await findInDocumentTool.execute?.({
      input: { path: "empty.hwpx", query: "없는텍스트" },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("찾지 못했습니다");
  });
});
