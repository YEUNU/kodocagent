/**
 * propose_cell_edit 테스트
 *
 * 1. 순수 XML 함수 단위 테스트 (applyCellEditsToSectionXml, readCellTextFromXml)
 *    - 평탄 표 편집
 *    - 중첩 표 케이스
 *    - expectedText 불일치 → 오류
 *    - XML 이스케이프
 * 2. 통합 테스트 (proposeCellEditTool.propose + commit)
 *    - 픽스처 HWPX 생성 → 편집 → 커밋 → kordoc 재파싱 확인
 *    - 병합 셀(colSpan) 보존 확인
 * 3. Capability A: 빈 셀(<hp:t/>) 채우기 단위 테스트
 * 4. Capability B: 레이블 기반 셀 탐색 단위 테스트 (resolveLabelTarget)
 * 5. 레이블 모드 통합 테스트 (실제 HWPX + markdownToHwpx)
 *
 * 샌드박스: os.tmpdir() 하위 임시 디렉터리
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { markdownToHwpx, parse } from "kordoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyCellEditsToSectionXml,
  type CellEditRequest,
  cellEditItemSchema,
  proposeCellEditTool,
  readCellTextFromXml,
  resolveLabelTarget,
} from "./propose-cell-edit.js";

// ─────────────────────────────────────────────────────────
// XML 픽스처 빌더
// ─────────────────────────────────────────────────────────

/**
 * 단순한 HWPX 섹션 XML 조각을 생성한다 (테스트 전용).
 * 실제 HWPX namespace 등은 생략하고 핵심 구조만 포함.
 */
function makeSimpleTcXml(
  colAddr: number,
  rowAddr: number,
  texts: string[],
  colSpan = 1,
  rowSpan = 1,
): string {
  const runs = texts.map((t) => `<hp:run><hp:t>${t}</hp:t></hp:run>`).join("");
  return (
    `<hp:tc name="">` +
    `<hp:subList><hp:p>${runs}</hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="${colAddr}" rowAddr="${rowAddr}"/>` +
    `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
    `<hp:cellSz width="1000" height="500"/>` +
    `</hp:tc>`
  );
}

/**
 * 빈 셀(<hp:t/>) XML 생성 — Capability A 테스트 전용
 * charPrIDRef 포함한 실제 Hancom 구조를 모사
 */
function makeEmptyTcXml(colAddr: number, rowAddr: number, colSpan = 1, rowSpan = 1): string {
  return (
    `<hp:tc name="">` +
    `<hp:subList><hp:p><hp:run charPrIDRef="11"><hp:t/></hp:run><hp:linesegarray/></hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="${colAddr}" rowAddr="${rowAddr}"/>` +
    `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
    `<hp:cellSz width="1000" height="500"/>` +
    `</hp:tc>`
  );
}

function makeSimpleTblXml(id: number, tcs: string[]): string {
  return (
    `<hp:tbl id="${id}" rowCnt="1" colCnt="${tcs.length}">` +
    `<hp:tr>${tcs.join("")}</hp:tr>` +
    `</hp:tbl>`
  );
}

function makeSectionXml(tbls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hs:sec>${tbls.join("")}</hs:sec>`;
}

// ─────────────────────────────────────────────────────────
// 세션 컨텍스트 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-cell-edit-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(() => {
  // 임시 디렉터리는 OS가 자동 정리 — 명시적 삭제 생략
});

function makeCtx(subDir?: string): { cwd: string; sessionId: string } {
  return {
    cwd: subDir ?? testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

// ─────────────────────────────────────────────────────────
// 1. 순수 XML 함수 단위 테스트
// ─────────────────────────────────────────────────────────

describe("applyCellEditsToSectionXml — 평탄 표 편집", () => {
  it("셀 텍스트를 교체하고 cellSpan을 보존한다", () => {
    // tc(0,0) colSpan=4, tc(0,1) colSpan=1
    const tc00 = makeSimpleTcXml(0, 0, ["기부 금액"], 4, 1);
    const tc01 = makeSimpleTcXml(1, 0, ["기부 건수"]);
    const tbl = makeSimpleTblXml(1, [tc00, tc01]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [{ tableIndex: 0, row: 0, col: 0, newText: "수정된 금액" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldText).toBe("기부 금액");

    // 새 텍스트 포함
    expect(newXml).toContain("<hp:t>수정된 금액</hp:t>");

    // 다른 셀은 변경 없음
    expect(newXml).toContain("<hp:t>기부 건수</hp:t>");

    // colSpan="4" 보존
    expect(newXml).toContain('colSpan="4"');
    expect(newXml).toContain('rowSpan="1"');
  });

  it("단일 표에서 여러 셀을 한 번에 편집한다", () => {
    const tc00 = makeSimpleTcXml(0, 0, ["셀A"]);
    const tc10 = makeSimpleTcXml(1, 0, ["셀B"]);
    const tc20 = makeSimpleTcXml(2, 0, ["셀C"]);
    const tbl = makeSimpleTblXml(1, [tc00, tc10, tc20]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [
      { tableIndex: 0, row: 0, col: 0, newText: "NEW-A" },
      { tableIndex: 0, row: 0, col: 2, newText: "NEW-C" },
    ];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(true);
    expect(results[1]?.success).toBe(true);
    expect(newXml).toContain("<hp:t>NEW-A</hp:t>");
    expect(newXml).toContain("<hp:t>셀B</hp:t>"); // 변경 없음
    expect(newXml).toContain("<hp:t>NEW-C</hp:t>");
  });

  it("다른 표의 셀은 변경하지 않는다", () => {
    const tbl0 = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["표0-셀A"])]);
    const tbl1 = makeSimpleTblXml(2, [makeSimpleTcXml(0, 0, ["표1-셀A"])]);
    const xml = makeSectionXml([tbl0, tbl1]);

    const edits: CellEditRequest[] = [{ tableIndex: 1, row: 0, col: 0, newText: "표1-수정" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(true);
    expect(newXml).toContain("<hp:t>표0-셀A</hp:t>"); // 표0 변경 없음
    expect(newXml).toContain("<hp:t>표1-수정</hp:t>");
  });
});

describe("applyCellEditsToSectionXml — 중첩 표 케이스", () => {
  it("외부 표 셀 편집이 중첩 표 셀에 영향을 주지 않는다", () => {
    // 내부 표: tc(0,0) = "내부셀"
    const innerTc = makeSimpleTcXml(0, 0, ["내부셀"]);
    const innerTbl = makeSimpleTblXml(99, [innerTc]);

    // 외부 표: tc(0,0) = "외부셀" (내부에 innerTbl 포함), tc(1,0) = "옆셀"
    const outerTc00 =
      `<hp:tc name="">` +
      `<hp:subList><hp:p><hp:run><hp:t>외부셀</hp:t></hp:run></hp:p>` +
      // 중첩 표 삽입
      `<hp:p><hp:run>${innerTbl}</hp:run></hp:p>` +
      `</hp:subList>` +
      `<hp:cellAddr colAddr="0" rowAddr="0"/>` +
      `<hp:cellSpan colSpan="1" rowSpan="1"/>` +
      `<hp:cellSz width="1000" height="500"/>` +
      `</hp:tc>`;
    const outerTc10 = makeSimpleTcXml(1, 0, ["옆셀"]);
    const outerTbl = makeSimpleTblXml(10, [outerTc00, outerTc10]);
    const xml = makeSectionXml([outerTbl]);

    // 외부 표 tableIndex=0, 셀(0,0) 편집
    const edits: CellEditRequest[] = [{ tableIndex: 0, row: 0, col: 0, newText: "외부수정" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(true);
    // 외부 셀 텍스트 변경됨
    expect(newXml).toContain("<hp:t>외부수정</hp:t>");
    // 중첩 표의 내부 셀은 그대로
    expect(newXml).toContain("<hp:t>내부셀</hp:t>");
  });

  it("중첩 표의 tableIndex는 kordoc 순서와 동일 (최상위만 카운팅)", () => {
    // 표0: tc(0,0) = "표0셀"
    // 표0 안에 중첩 표 (kordoc에서 별도 카운팅 안 함)
    // 표1: tc(0,0) = "표1셀" (최상위 두 번째)
    const innerTc = makeSimpleTcXml(0, 0, ["중첩셀"]);
    const innerTbl = makeSimpleTblXml(99, [innerTc]);

    const outerTc00 =
      `<hp:tc name="">` +
      `<hp:subList><hp:p><hp:run><hp:t>표0셀</hp:t></hp:run></hp:p>` +
      `<hp:p><hp:run>${innerTbl}</hp:run></hp:p>` +
      `</hp:subList>` +
      `<hp:cellAddr colAddr="0" rowAddr="0"/>` +
      `<hp:cellSpan colSpan="1" rowSpan="1"/>` +
      `<hp:cellSz width="1000" height="500"/>` +
      `</hp:tc>`;
    const tbl0 = makeSimpleTblXml(10, [outerTc00]);
    const tbl1 = makeSimpleTblXml(11, [makeSimpleTcXml(0, 0, ["표1셀"])]);
    const xml = makeSectionXml([tbl0, tbl1]);

    // tableIndex=1이 두 번째 최상위 표를 가리켜야 한다
    const text = readCellTextFromXml(xml, 1, 0, 0);
    expect(text).toBe("표1셀");

    // tableIndex=0으로 중첩 표 안의 셀을 편집하면 외부 셀만 변경
    const edits: CellEditRequest[] = [{ tableIndex: 0, row: 0, col: 0, newText: "외부수정2" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);
    expect(results[0]?.success).toBe(true);
    expect(newXml).toContain("<hp:t>외부수정2</hp:t>");
    expect(newXml).toContain("<hp:t>중첩셀</hp:t>"); // 중첩 표 내용 보존
  });
});

describe("applyCellEditsToSectionXml — expectedText 검증", () => {
  it("expectedText가 일치하면 편집 성공", () => {
    const tbl = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["현재값"])]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [
      { tableIndex: 0, row: 0, col: 0, newText: "새값", expectedText: "현재값" },
    ];
    const { results } = applyCellEditsToSectionXml(xml, edits);
    expect(results[0]?.success).toBe(true);
  });

  it("expectedText가 불일치하면 오류 반환, XML 무변경", () => {
    const tbl = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["실제값"])]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [
      { tableIndex: 0, row: 0, col: 0, newText: "새값", expectedText: "다른값" },
    ];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain("예상값과 다릅니다");
    expect(results[0]?.oldText).toBe("실제값");
    // XML 무변경
    expect(newXml).toBe(xml);
  });

  it("한 편집이라도 실패하면 XML 전체 무변경", () => {
    const tc00 = makeSimpleTcXml(0, 0, ["셀A"]);
    const tc10 = makeSimpleTcXml(1, 0, ["셀B"]);
    const tbl = makeSimpleTblXml(1, [tc00, tc10]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [
      { tableIndex: 0, row: 0, col: 0, newText: "NEW-A" }, // 성공
      { tableIndex: 0, row: 0, col: 1, newText: "NEW-B", expectedText: "잘못된예상" }, // 실패
    ];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(true); // 성공 처리됨
    expect(results[1]?.success).toBe(false); // 실패
    // 실패가 있으므로 XML 무변경
    expect(newXml).toBe(xml);
  });
});

describe("applyCellEditsToSectionXml — XML 이스케이프", () => {
  it("newText의 &, <, >를 XML 이스케이프한다", () => {
    const tbl = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["원본"])]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [{ tableIndex: 0, row: 0, col: 0, newText: "A & B < C > D" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(true);
    expect(newXml).toContain("<hp:t>A &amp; B &lt; C &gt; D</hp:t>");
  });
});

describe("readCellTextFromXml", () => {
  it("존재하지 않는 표 인덱스는 null을 반환한다", () => {
    const tbl = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["텍스트"])]);
    const xml = makeSectionXml([tbl]);
    expect(readCellTextFromXml(xml, 99, 0, 0)).toBeNull();
  });

  it("존재하지 않는 셀 주소는 null을 반환한다", () => {
    const tbl = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["텍스트"])]);
    const xml = makeSectionXml([tbl]);
    expect(readCellTextFromXml(xml, 0, 5, 5)).toBeNull();
  });

  it("XML 엔티티가 디코딩된 텍스트를 반환한다", () => {
    const tc = makeSimpleTcXml(0, 0, ["A &amp; B &lt; C"]);
    const tbl = makeSimpleTblXml(1, [tc]);
    const xml = makeSectionXml([tbl]);
    expect(readCellTextFromXml(xml, 0, 0, 0)).toBe("A & B < C");
  });
});

// ─────────────────────────────────────────────────────────
// 2. 통합 테스트 (propose + commit + kordoc 재파싱)
// ─────────────────────────────────────────────────────────

describe("proposeCellEditTool 통합 테스트", () => {
  it("병합 셀 HWPX 픽스처 편집 → commit → kordoc 재파싱 확인, colSpan 보존", async () => {
    // 1. kordoc으로 기본 HWPX 생성
    const md = "| 이름 | 나이 |\n| --- | --- |\n| 홍길동 | 30 |";
    const baseHwpx = await markdownToHwpx(md);

    // 2. ZIP 열어서 section0.xml에 colSpan 병합 셀 주입
    const zip = await JSZip.loadAsync(baseHwpx);
    const sectionFiles = Object.keys(zip.files).filter((n) =>
      /^Contents\/section\d+\.xml$/.test(n),
    );
    const firstSection = sectionFiles[0];
    if (!firstSection) throw new Error("섹션 파일 없음");
    const sectionEntry = zip.file(firstSection);
    if (!sectionEntry) throw new Error("섹션 항목 없음");
    let sectionXml = await sectionEntry.async("string");

    // cellSpan을 colSpan="2"로 수동 패치 (첫 번째 cellSpan 태그)
    sectionXml = sectionXml.replace('colSpan="1" rowSpan="1"', 'colSpan="2" rowSpan="1"');

    // 수정된 섹션 XML을 새 ZIP에 반영
    const patchedZip = new JSZip();
    const mimetypeEntry = zip.file("mimetype");
    if (mimetypeEntry) {
      patchedZip.file("mimetype", await mimetypeEntry.async("uint8array"), {
        compression: "STORE",
      });
    }
    for (const [name, entry] of Object.entries(zip.files)) {
      if (name === "mimetype" || entry.dir) continue;
      if (name === firstSection) {
        patchedZip.file(name, sectionXml);
      } else {
        patchedZip.file(name, await entry.async("uint8array"));
      }
    }
    const patchedBuf = await patchedZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    // 3. 픽스처 파일 저장
    const fixtureDir = join(testDir, `cell-edit-integration-${Date.now()}`);
    await mkdir(fixtureDir, { recursive: true });
    const fixturePath = join(fixtureDir, "fixture.hwpx");
    await writeFile(fixturePath, patchedBuf);

    // 4. kordoc으로 픽스처 파싱 — 편집 전 상태 확인
    const originalBuf = await readFile(fixturePath);
    const beforeResult = await parse(originalBuf.buffer as ArrayBuffer);
    expect(beforeResult.success).toBe(true);

    // 5. propose_cell_edit 호출
    const ctx = makeCtx(fixtureDir);
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "fixture.hwpx",
        edits: [
          {
            tableIndex: 0,
            row: 0,
            col: 0,
            newText: "김철수",
            expectedText: undefined, // expectedText 없이도 동작
          },
        ],
        summary: "첫 번째 셀을 김철수로 변경",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as {
      proposal: import("@kodocagent/shared").Proposal;
      commit: () => Promise<string>;
    };

    // diff 포함 확인
    expect(outcome.proposal.diff).toContain("김철수");
    expect(outcome.proposal.kind).toBe("cell-edit");

    // 6. commit
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain("저장 완료");
    expect(commitMsg).toContain("fixture.hwpx");

    // 7. kordoc으로 저장된 파일 재파싱
    const savedBuf = await readFile(fixturePath);
    const afterResult = await parse(savedBuf.buffer as ArrayBuffer);
    expect(afterResult.success).toBe(true);

    if (afterResult.success) {
      // 첫 번째 표의 첫 번째 셀 텍스트가 "김철수"인지 확인
      const tableBlock = afterResult.blocks.find((b) => b.type === "table");
      expect(tableBlock).toBeDefined();
      if (tableBlock?.type === "table" && tableBlock.table) {
        const firstCell = tableBlock.table.cells[0]?.[0];
        expect(firstCell?.text).toBe("김철수");
      }
    }

    // 8. colSpan이 XML에 그대로 보존되었는지 직접 확인
    const savedZip = await JSZip.loadAsync(savedBuf);
    const savedSection = savedZip.file(firstSection);
    expect(savedSection).toBeDefined();
    const savedXml = await savedSection?.async("string");
    // 첫 번째 cellSpan 확인 (병합 패치가 유지됨)
    expect(savedXml).toContain('colSpan="2"');
  }, 30000);

  it("존재하지 않는 파일이면 오류 문자열 반환", async () => {
    const ctx = makeCtx();
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "nonexistent.hwpx",
        edits: [{ tableIndex: 0, row: 0, col: 0, newText: "값" }],
        summary: "테스트",
      },
      ctx,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("오류");
  });

  it(".hwp 파일이면 .hwpx 저장 안내 오류 반환", async () => {
    const ctx = makeCtx();
    const hwpPath = join(testDir, "test.hwp");
    await writeFile(hwpPath, Buffer.from("dummy"));

    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "test.hwp",
        edits: [{ tableIndex: 0, row: 0, col: 0, newText: "값" }],
        summary: "테스트",
      },
      ctx,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain(".hwpx");
    expect(result as string).toContain("저장");
  });

  it("잘못된 표 인덱스이면 오류 문자열 반환", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const hwpxBuf = await markdownToHwpx(md);
    const fixtureDir = join(testDir, `cell-edit-badidx-${Date.now()}`);
    await mkdir(fixtureDir, { recursive: true });
    const fixturePath = join(fixtureDir, "bad.hwpx");
    await writeFile(fixturePath, Buffer.from(hwpxBuf));

    const ctx = makeCtx(fixtureDir);
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "bad.hwpx",
        edits: [{ tableIndex: 999, row: 0, col: 0, newText: "값" }],
        summary: "테스트",
      },
      ctx,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("오류");
    expect(result as string).toContain("999");
  }, 15000);

  it("expectedText 불일치이면 오류 문자열 반환, 파일 미수정", async () => {
    const md = "| 이름 |\n| --- |\n| 홍길동 |";
    const hwpxBuf = await markdownToHwpx(md);
    const fixtureDir = join(testDir, `cell-edit-mismatch-${Date.now()}`);
    await mkdir(fixtureDir, { recursive: true });
    const fixturePath = join(fixtureDir, "mismatch.hwpx");
    await writeFile(fixturePath, Buffer.from(hwpxBuf));
    const originalSize = hwpxBuf.byteLength;

    const ctx = makeCtx(fixtureDir);
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "mismatch.hwpx",
        edits: [{ tableIndex: 0, row: 0, col: 0, newText: "김철수", expectedText: "다른이름" }],
        summary: "테스트",
      },
      ctx,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("예상값과 다릅니다");

    // 파일 크기가 원본과 동일 (수정 안 됨)
    const afterBuf = await readFile(fixturePath);
    expect(afterBuf.length).toBe(originalSize);
  }, 15000);
});

// ─────────────────────────────────────────────────────────
// 3. Capability A: 빈 셀 (<hp:t/>) 채우기
// ─────────────────────────────────────────────────────────

describe("Capability A — 빈 셀(<hp:t/>) 채우기", () => {
  it("빈 셀을 읽으면 빈 문자열을 반환한다", () => {
    const emptyTc = makeEmptyTcXml(0, 0);
    const tbl = makeSimpleTblXml(1, [emptyTc]);
    const xml = makeSectionXml([tbl]);

    expect(readCellTextFromXml(xml, 0, 0, 0)).toBe("");
  });

  it("<hp:t/>를 값으로 채우면 <hp:t>value</hp:t>가 되고 cellSpan이 보존된다", () => {
    const emptyTc = makeEmptyTcXml(0, 0, 2, 1); // colSpan=2
    const tbl = makeSimpleTblXml(1, [emptyTc]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [{ tableIndex: 0, row: 0, col: 0, newText: "홍길동" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldText).toBe("");
    // self-closing이 완전한 태그로 교체됨
    expect(newXml).toContain("<hp:t>홍길동</hp:t>");
    // 기존 self-closing 태그가 사라짐
    expect(newXml).not.toContain("<hp:t/>");
    // cellSpan 보존
    expect(newXml).toContain('colSpan="2"');
  });

  it('expectedText: ""는 빈 셀에 매칭된다', () => {
    const emptyTc = makeEmptyTcXml(0, 0);
    const tbl = makeSimpleTblXml(1, [emptyTc]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [
      { tableIndex: 0, row: 0, col: 0, newText: "채운값", expectedText: "" },
    ];
    const { results } = applyCellEditsToSectionXml(xml, edits);
    expect(results[0]?.success).toBe(true);
  });

  it("non-empty expectedText는 빈 셀과 불일치 → 오류", () => {
    const emptyTc = makeEmptyTcXml(0, 0);
    const tbl = makeSimpleTblXml(1, [emptyTc]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [
      { tableIndex: 0, row: 0, col: 0, newText: "채운값", expectedText: "기존값" },
    ];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain("예상값과 다릅니다");
    // XML 무변경
    expect(newXml).toBe(xml);
  });

  it("빈 셀과 일반 셀이 혼재할 때 양쪽 모두 정상 편집", () => {
    const emptyTc = makeEmptyTcXml(0, 0);
    const normalTc = makeSimpleTcXml(1, 0, ["기존값"]);
    const tbl = makeSimpleTblXml(1, [emptyTc, normalTc]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [
      { tableIndex: 0, row: 0, col: 0, newText: "빈셀채움" },
      { tableIndex: 0, row: 0, col: 1, newText: "일반셀수정" },
    ];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);
    expect(results[0]?.success).toBe(true);
    expect(results[1]?.success).toBe(true);
    expect(newXml).toContain("<hp:t>빈셀채움</hp:t>");
    expect(newXml).toContain("<hp:t>일반셀수정</hp:t>");
  });

  it("셀에 텍스트 런이 전혀 없으면 명확한 한국어 오류를 반환한다", () => {
    // 텍스트 런이 없는 극단적인 셀 구조
    const noRunTc =
      `<hp:tc name="">` +
      `<hp:subList><hp:p></hp:p></hp:subList>` +
      `<hp:cellAddr colAddr="0" rowAddr="0"/>` +
      `<hp:cellSpan colSpan="1" rowSpan="1"/>` +
      `</hp:tc>`;
    const tbl = makeSimpleTblXml(1, [noRunTc]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [{ tableIndex: 0, row: 0, col: 0, newText: "값" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain("텍스트 런이 없습니다");
    expect(newXml).toBe(xml);
  });

  it("XML 특수문자 포함 텍스트를 빈 셀에 채울 때 올바르게 이스케이프한다", () => {
    const emptyTc = makeEmptyTcXml(0, 0);
    const tbl = makeSimpleTblXml(1, [emptyTc]);
    const xml = makeSectionXml([tbl]);

    const edits: CellEditRequest[] = [{ tableIndex: 0, row: 0, col: 0, newText: "A & B < C > D" }];
    const { newXml, results } = applyCellEditsToSectionXml(xml, edits);
    expect(results[0]?.success).toBe(true);
    expect(newXml).toContain("<hp:t>A &amp; B &lt; C &gt; D</hp:t>");
  });
});

// ─────────────────────────────────────────────────────────
// 4. Capability B: 레이블 기반 셀 탐색 (resolveLabelTarget)
// ─────────────────────────────────────────────────────────

describe("Capability B — resolveLabelTarget 단위 테스트", () => {
  it("label로 오른쪽 이웃 셀을 찾는다 (direction: right)", () => {
    // 표0: [성명 | (빈칸)]
    const labelTc = makeSimpleTcXml(0, 0, ["성명"]);
    const valueTc = makeSimpleTcXml(1, 0, [""]);
    const tbl = makeSimpleTblXml(1, [labelTc, valueTc]);
    const xml = makeSectionXml([tbl]);

    const result = resolveLabelTarget(xml, "성명", "right");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.tableIndex).toBe(0);
      expect(result.row).toBe(0);
      expect(result.col).toBe(1);
    }
  });

  it("label로 아래 셀을 찾는다 (direction: below)", () => {
    // 표0: row0=[헤더], row1=[값]
    const headerTc = makeSimpleTcXml(0, 0, ["이름"]);
    const valueTc = makeSimpleTcXml(0, 1, [""]);
    const tbl =
      `<hp:tbl id="1" rowCnt="2" colCnt="1">` +
      `<hp:tr>${headerTc}</hp:tr>` +
      `<hp:tr>${valueTc}</hp:tr>` +
      `</hp:tbl>`;
    const xml = makeSectionXml([tbl]);

    const result = resolveLabelTarget(xml, "이름", "below");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.tableIndex).toBe(0);
      expect(result.row).toBe(1);
      expect(result.col).toBe(0);
    }
  });

  it("colSpan>1인 병합 레이블 셀의 오른쪽 대상 = col + colSpan", () => {
    // 표0: [성명 (colSpan=2) | | 값칸]
    // cellAddr: 성명=col0, 빈칸=col1(병합), 값칸=col2
    const labelTc = makeSimpleTcXml(0, 0, ["성명"], 2, 1); // colSpan=2
    // col=2에 값칸
    const valueTc = makeSimpleTcXml(2, 0, [""]);
    const tbl = makeSimpleTblXml(1, [labelTc, valueTc]);
    const xml = makeSectionXml([tbl]);

    const result = resolveLabelTarget(xml, "성명", "right");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.col).toBe(2); // 0 + 2 = 2
    }
  });

  it("레이블을 찾을 수 없으면 한국어 오류를 반환한다", () => {
    const tbl = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["다른레이블"])]);
    const xml = makeSectionXml([tbl]);

    const result = resolveLabelTarget(xml, "존재안함", "right");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("찾을 수 없습니다");
    }
  });

  it("레이블이 중복이면 한국어 오류를 반환한다 (ambiguity)", () => {
    // 두 표에 같은 레이블
    const tbl0 = makeSimpleTblXml(1, [
      makeSimpleTcXml(0, 0, ["성명"]),
      makeSimpleTcXml(1, 0, [""]),
    ]);
    const tbl1 = makeSimpleTblXml(2, [
      makeSimpleTcXml(0, 0, ["성명"]),
      makeSimpleTcXml(1, 0, [""]),
    ]);
    const xml = makeSectionXml([tbl0, tbl1]);

    const result = resolveLabelTarget(xml, "성명", "right");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("여러 셀에서 발견");
    }
  });

  it("tableIndex로 범위를 좁히면 중복 레이블도 정상 해석", () => {
    const tbl0 = makeSimpleTblXml(1, [
      makeSimpleTcXml(0, 0, ["성명"]),
      makeSimpleTcXml(1, 0, [""]),
    ]);
    const tbl1 = makeSimpleTblXml(2, [
      makeSimpleTcXml(0, 0, ["성명"]),
      makeSimpleTcXml(1, 0, [""]),
    ]);
    const xml = makeSectionXml([tbl0, tbl1]);

    // tableIndex=1로 두 번째 표만 탐색
    const result = resolveLabelTarget(xml, "성명", "right", 1);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.tableIndex).toBe(1);
    }
  });

  it("대상 셀이 존재하지 않으면 한국어 오류를 반환한다", () => {
    // 1열짜리 표 — right 방향으로 가면 col=1이 없음
    const tbl = makeSimpleTblXml(1, [makeSimpleTcXml(0, 0, ["레이블"])]);
    const xml = makeSectionXml([tbl]);

    const result = resolveLabelTarget(xml, "레이블", "right");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("존재하지 않습니다");
    }
  });
});

describe("Capability B — 입력 모드 검증(핸들러)", () => {
  // 스키마는 JSON Schema 변환을 위해 전 필드 optional(z.undefined·union 미사용),
  // 좌표 XOR 라벨 검증은 propose 핸들러에서 수행 → 오류 문자열 반환 + 파일 무수정.
  it("스키마는 두 모드 입력을 모두 파싱한다(검증은 핸들러)", () => {
    expect(
      cellEditItemSchema.safeParse({ label: "성명", row: 0, col: 1, newText: "값" }).success,
    ).toBe(true);
    expect(cellEditItemSchema.safeParse({ newText: "값" }).success).toBe(true);
  });

  it("label과 row/col을 동시에 지정하면 핸들러가 오류 반환(수정 안 함)", async () => {
    const hwpxBuf = await markdownToHwpx("| 성명 |  |\n| --- | --- |");
    const dir = join(testDir, `validate-both-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "f.hwpx"), Buffer.from(hwpxBuf));
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "f.hwpx",
        edits: [{ label: "성명", row: 0, col: 1, newText: "값" }],
        summary: "x",
      },
      ctx: makeCtx(dir),
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("동시에 지정할 수 없");
  });

  it("label도 없고 row/col도 없으면 핸들러가 오류 반환", async () => {
    const hwpxBuf = await markdownToHwpx("| 성명 |  |\n| --- | --- |");
    const dir = join(testDir, `validate-neither-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "f.hwpx"), Buffer.from(hwpxBuf));
    const result = await proposeCellEditTool.propose?.({
      input: { path: "f.hwpx", edits: [{ newText: "값" }], summary: "x" },
      ctx: makeCtx(dir),
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("하나");
  });
});

// ─────────────────────────────────────────────────────────
// 5. 레이블 모드 통합 테스트 (실제 HWPX)
// ─────────────────────────────────────────────────────────

describe("Capability A+B 통합 테스트 — 레이블 모드로 빈 셀 채우기", () => {
  it("markdownToHwpx로 생성한 양식 표에서 레이블 모드로 빈 셀을 채우고 kordoc 재파싱 확인", async () => {
    // 1. 양식형 표 HWPX 생성 (성명 | 빈칸 구조)
    const md = "| 성명 |  |\n| --- | --- |\n| 주소 |  |";
    const hwpxBuf = await markdownToHwpx(md);

    // 2. 임시 파일 저장
    const fixtureDir = join(testDir, `label-integration-${Date.now()}`);
    await mkdir(fixtureDir, { recursive: true });
    const fixturePath = join(fixtureDir, "form.hwpx");
    await writeFile(fixturePath, Buffer.from(hwpxBuf));

    // 3. 레이블 모드로 '성명' 오른쪽 셀 채우기
    const ctx = makeCtx(fixtureDir);
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "form.hwpx",
        edits: [
          {
            label: "성명",
            direction: "right",
            newText: "홍길동",
            expectedText: "", // 빈 셀 예상
          },
        ],
        summary: "성명 옆 칸에 홍길동 입력",
      },
      ctx,
    });

    // 오류 문자열이 아닌 proposal 객체여야 함
    expect(typeof result).not.toBe("string");

    const outcome = result as {
      proposal: import("@kodocagent/shared").Proposal;
      commit: () => Promise<string>;
    };

    // diff에 레이블 정보 및 새 텍스트 포함
    expect(outcome.proposal.diff).toContain("홍길동");

    // 4. commit
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain("저장 완료");

    // 5. kordoc으로 재파싱하여 값 확인
    const savedBuf = await readFile(fixturePath);
    const afterResult = await parse(savedBuf.buffer as ArrayBuffer);
    expect(afterResult.success).toBe(true);

    if (afterResult.success) {
      const tableBlock = afterResult.blocks.find((b) => b.type === "table");
      expect(tableBlock).toBeDefined();
      if (tableBlock?.type === "table" && tableBlock.table) {
        // 첫 번째 행 두 번째 셀에 홍길동이 있어야 함
        const firstRow = tableBlock.table.cells[0];
        const valueCell = firstRow?.[1];
        expect(valueCell?.text).toBe("홍길동");
      }
    }
  }, 30000);

  it("좌표 모드로도 빈 셀(markdownToHwpx 생성)을 채울 수 있다", async () => {
    const md = "| 직함 |  |\n| --- | --- |";
    const hwpxBuf = await markdownToHwpx(md);

    const fixtureDir = join(testDir, `coord-empty-${Date.now()}`);
    await mkdir(fixtureDir, { recursive: true });
    const fixturePath = join(fixtureDir, "empty.hwpx");
    await writeFile(fixturePath, Buffer.from(hwpxBuf));

    // kordoc parse로 표 구조 파악 (col=1이 빈 셀)
    const parsedBuf = await readFile(fixturePath);
    const parsed = await parse(parsedBuf.buffer as ArrayBuffer);
    expect(parsed.success).toBe(true);

    const ctx = makeCtx(fixtureDir);
    // col=1 (두 번째 셀) — markdownToHwpx에서 빈 문자열 셀은 <hp:t/> 또는 <hp:t></hp:t>로 표현됨
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "empty.hwpx",
        edits: [{ tableIndex: 0, row: 0, col: 1, newText: "부장", expectedText: "" }],
        summary: "직함 칸에 부장 입력",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as {
      proposal: import("@kodocagent/shared").Proposal;
      commit: () => Promise<string>;
    };

    await outcome.commit();

    const savedBuf = await readFile(fixturePath);
    const afterResult = await parse(savedBuf.buffer as ArrayBuffer);
    expect(afterResult.success).toBe(true);
    if (afterResult.success) {
      const tableBlock = afterResult.blocks.find((b) => b.type === "table");
      if (tableBlock?.type === "table" && tableBlock.table) {
        const valueCell = tableBlock.table.cells[0]?.[1];
        expect(valueCell?.text).toBe("부장");
      }
    }
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// OLE2 .hwp 바이너리 가드
// ─────────────────────────────────────────────────────────

describe("proposeCellEditTool — OLE2 .hwp 바이너리 가드", () => {
  it("OLE2 시그니처 바이트(.hwp)가 감지되면 친절한 안내 메시지를 반환하고 파일을 쓰지 않는다", async () => {
    const subDir = join(testDir, `ole2-guard-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // OLE2/CFB 매직 바이트(D0 CF 11 E0 A1 B1 1A E1)로 시작하는 실제 .hwp 바이너리를 모사
    const oleBytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    const hwpPath = join(subDir, "form.hwp");
    await writeFile(hwpPath, oleBytes);

    const ctx = makeCtx(subDir);
    const result = await proposeCellEditTool.propose?.({
      input: {
        path: "form.hwp",
        edits: [{ tableIndex: 0, row: 0, col: 0, newText: "새값" }],
        summary: "hwp OLE 셀 편집 시도",
      },
      ctx,
    });

    // 오류 문자열이 반환되어야 함
    expect(typeof result).toBe("string");
    const msg = result as string;

    // 안내 메시지에 .hwpx 언급 + propose_edit 언급 + 변환 안내 포함
    expect(msg).toContain("hwpx");
    expect(msg).toContain("propose_edit");
    expect(msg).toContain("다른 이름으로 저장");

    // 파일이 수정되지 않았는지 확인 (원본 bytes 그대로)
    const afterBytes = await readFile(hwpPath);
    expect(Buffer.from(afterBytes).equals(oleBytes)).toBe(true);
  }, 10000);
});
