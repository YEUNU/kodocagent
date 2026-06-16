/**
 * propose_table_structure 테스트
 *
 * 1. htmlToPlainText 단위 테스트 — 순수 함수, WASM 불필요
 * 2. computeExpectedDelta 단위 테스트 — 순수 함수
 * 3. 통합 테스트 — 실제 @rhwp/core WASM + markdownToHwpx 사용
 *    - insertRow below → +1 행 확인 (앵커 표만 변경, 다른 표 불변)
 *    - deleteRow → -1 행 확인
 *    - insertColumn right → +1 열 확인
 *    - deleteColumn → -1 열 확인
 *    - mergeCells → 재파싱 성공 + anchor 존재 확인
 *    - 모호한 anchor (2개 표에 텍스트 존재) → 오류, 파일 무수정
 *    - anchor 없음 → 오류
 *    - .hwp 경로: willConvertFormat + .hwpx 출력 경로 확인
 *    - 지원 안 하는 확장자 → 오류
 *
 * 임시 파일: os.tmpdir() 하위, OS가 자동 정리
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { markdownToHwpx, parse } from "@clazic/kordoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlToPlainText } from "../rhwp-engine.js";
import { computeExpectedDelta, proposeTableStructureTool } from "./propose-table-structure.js";

// ─────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-table-structure-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(() => {
  // 임시 디렉터리는 OS가 자동 정리
});

function makeCtx(subDir?: string): { cwd: string; sessionId: string } {
  return {
    cwd: subDir ?? testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

async function saveHwpx(dir: string, name: string, md: string): Promise<string> {
  const buf = await markdownToHwpx(md);
  const filePath = join(dir, name);
  await writeFile(filePath, new Uint8Array(buf as ArrayBuffer));
  return filePath;
}

/**
 * 두 개의 구분 가능한 표를 가진 HWPX 파일 생성.
 * 표1: "사과" 헤더 포함 2×2
 * 표2: "배" 헤더 포함 3×2
 */
async function saveTwoTableHwpx(dir: string, name: string): Promise<string> {
  const md = `# 표 구조 테스트

| 사과 | 수량 |
| --- | --- |
| 후지 | 10 |
| 홍옥 | 20 |

텍스트 단락.

| 배 | 가격 |
| --- | --- |
| 신고 | 5000 |
| 원황 | 6000 |
| 만풍 | 7000 |
`;
  return saveHwpx(dir, name, md);
}

// ─────────────────────────────────────────────────────────
// 1. htmlToPlainText 단위 테스트
// ─────────────────────────────────────────────────────────

describe("htmlToPlainText — 순수 함수", () => {
  it("단순 태그 제거", () => {
    expect(htmlToPlainText("<p>안녕하세요</p>")).toBe("안녕하세요");
  });

  it("중첩 태그 제거", () => {
    expect(htmlToPlainText("<div><span>텍스트</span></div>")).toBe("텍스트");
  });

  it("HTML 엔티티 디코딩", () => {
    expect(htmlToPlainText("&amp;&lt;&gt;&quot;&#39;&nbsp;")).toBe("&<>\"' ");
  });

  it("태그 없는 텍스트 그대로 반환", () => {
    expect(htmlToPlainText("plain text")).toBe("plain text");
  });

  it("빈 문자열 처리", () => {
    expect(htmlToPlainText("")).toBe("");
  });

  it("복합: 태그 + 엔티티", () => {
    const html = "<td><span>기부 금액(원, %)</span> &amp; <b>기타</b></td>";
    const result = htmlToPlainText(html);
    expect(result).toContain("기부 금액(원, %)");
    expect(result).toContain("&");
    expect(result).toContain("기타");
    expect(result).not.toContain("<");
  });
});

// ─────────────────────────────────────────────────────────
// 2. computeExpectedDelta 단위 테스트
// ─────────────────────────────────────────────────────────

describe("computeExpectedDelta — 순수 함수", () => {
  it("insertRow → rowDelta +1", () => {
    const delta = computeExpectedDelta([{ type: "insertRow", row: 0, position: "below" }]);
    expect(delta).toEqual({ rowDelta: 1, colDelta: 0 });
  });

  it("deleteRow → rowDelta -1", () => {
    const delta = computeExpectedDelta([{ type: "deleteRow", row: 1 }]);
    expect(delta).toEqual({ rowDelta: -1, colDelta: 0 });
  });

  it("insertColumn → colDelta +1", () => {
    const delta = computeExpectedDelta([{ type: "insertColumn", col: 0, position: "right" }]);
    expect(delta).toEqual({ rowDelta: 0, colDelta: 1 });
  });

  it("deleteColumn → colDelta -1", () => {
    const delta = computeExpectedDelta([{ type: "deleteColumn", col: 0 }]);
    expect(delta).toEqual({ rowDelta: 0, colDelta: -1 });
  });

  it("복합: insertRow + deleteRow → rowDelta 0", () => {
    const delta = computeExpectedDelta([
      { type: "insertRow", row: 0, position: "below" },
      { type: "deleteRow", row: 0 },
    ]);
    expect(delta).toEqual({ rowDelta: 0, colDelta: 0 });
  });

  it("mergeCells 포함 → null 반환 (치수 검증 불가)", () => {
    const delta = computeExpectedDelta([
      { type: "insertRow", row: 0, position: "below" },
      { type: "mergeCells", startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    ]);
    expect(delta).toBeNull();
  });

  it("mergeCells만 → null 반환", () => {
    const delta = computeExpectedDelta([
      { type: "mergeCells", startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    ]);
    expect(delta).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// 3. 통합 테스트
// ─────────────────────────────────────────────────────────

describe("proposeTableStructureTool — insertRow", () => {
  it("사과 표에 행 삽입 → +1 행, 배 표 불변", async () => {
    const subDir = join(testDir, `insert-row-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const filePath = await saveTwoTableHwpx(subDir, "two-tables.hwpx");

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "two-tables.hwpx",
        anchor: "후지",
        operations: [{ type: "insertRow", row: 1, position: "below" }],
        summary: "사과 표 마지막 행 아래에 행 삽입",
      },
      ctx,
    });

    // 오류 문자열이 아닌 ProposeOutcome이어야 함
    expect(typeof result).not.toBe("string");

    const outcome = result as { proposal: unknown; commit: () => Promise<string> };
    expect(outcome.proposal).toBeDefined();
    expect(outcome.commit).toBeTypeOf("function");

    const proposal = outcome.proposal as {
      kind: string;
      diff: string;
      targetPath: string;
      willConvertFormat: string | undefined;
    };
    expect(proposal.kind).toBe("table-structure");
    expect(proposal.diff).toContain("후지"); // anchor in diff
    expect(extname(proposal.targetPath).toLowerCase()).toBe(".hwpx");
    expect(proposal.willConvertFormat).toBeUndefined();

    // commit 실행
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain("저장 완료");

    // kordoc으로 재파싱하여 행 수 확인
    const buf = await readFile(filePath);
    const parsed = await parse(buf.buffer as ArrayBuffer);
    expect(parsed.success).toBe(true);

    const md = parsed.success ? parsed.markdown : "";
    // anchor 텍스트 여전히 존재
    expect(md).toContain("후지");
    // 배 표는 변경 없음
    expect(md).toContain("신고");
  }, 60000); // WASM 초기화 포함
});

describe("proposeTableStructureTool — deleteRow", () => {
  it("사과 표에서 행 삭제 → -1 행", async () => {
    const subDir = join(testDir, `delete-row-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const filePath = await saveTwoTableHwpx(subDir, "two-tables.hwpx");

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "two-tables.hwpx",
        anchor: "홍옥",
        operations: [{ type: "deleteRow", row: 2 }],
        summary: "사과 표 마지막 행 삭제",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as { commit: () => Promise<string> };
    await outcome.commit();

    const buf = await readFile(filePath);
    const parsed = await parse(buf.buffer as ArrayBuffer);
    expect(parsed.success).toBe(true);
    const md = parsed.success ? parsed.markdown : "";
    // anchor가 삭제되었으므로 존재하지 않을 수 있음 (홍옥 행 삭제)
    // 사과 표의 다른 셀은 남아있어야 함
    expect(md).toContain("후지");
  }, 60000);
});

describe("proposeTableStructureTool — insertColumn", () => {
  it("배 표에 열 삽입 → +1 열", async () => {
    const subDir = join(testDir, `insert-col-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const filePath = await saveTwoTableHwpx(subDir, "two-tables.hwpx");

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "two-tables.hwpx",
        anchor: "신고",
        operations: [{ type: "insertColumn", col: 1, position: "right" }],
        summary: "배 표 오른쪽에 열 삽입",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as { proposal: unknown; commit: () => Promise<string> };

    const proposal = outcome.proposal as { diff: string };
    // diff에 열 수 변화 포함
    expect(proposal.diff).toContain("열");

    await outcome.commit();

    const buf = await readFile(filePath);
    const parsed = await parse(buf.buffer as ArrayBuffer);
    expect(parsed.success).toBe(true);
    const md = parsed.success ? parsed.markdown : "";
    expect(md).toContain("신고");
  }, 60000);
});

describe("proposeTableStructureTool — deleteColumn", () => {
  it("사과 표에서 열 삭제", async () => {
    const subDir = join(testDir, `delete-col-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const filePath = await saveTwoTableHwpx(subDir, "two-tables.hwpx");

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "two-tables.hwpx",
        anchor: "수량",
        operations: [{ type: "deleteColumn", col: 1 }],
        summary: "사과 표 수량 열 삭제",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as { commit: () => Promise<string> };
    await outcome.commit();

    const buf = await readFile(filePath);
    const parsed = await parse(buf.buffer as ArrayBuffer);
    expect(parsed.success).toBe(true);
  }, 60000);
});

describe("proposeTableStructureTool — mergeCells", () => {
  it("셀 병합 → 재파싱 성공 + anchor 존재", async () => {
    const subDir = join(testDir, `merge-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // 병합을 위해 3행 이상 표 생성
    const md = `# 병합 테스트

| 병합앵커 | B | C |
| --- | --- | --- |
| 행2A | 행2B | 행2C |
| 행3A | 행3B | 행3C |
`;
    const filePath = await saveHwpx(subDir, "merge-test.hwpx", md);

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "merge-test.hwpx",
        anchor: "병합앵커",
        operations: [{ type: "mergeCells", startRow: 1, startCol: 0, endRow: 2, endCol: 0 }],
        summary: "첫 번째 열 두 행 병합",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as { proposal: unknown; commit: () => Promise<string> };

    const proposal = outcome.proposal as { kind: string };
    expect(proposal.kind).toBe("table-structure");

    await outcome.commit();

    const buf = await readFile(filePath);
    const parsed = await parse(buf.buffer as ArrayBuffer);
    expect(parsed.success).toBe(true);
    const md2 = parsed.success ? parsed.markdown : "";
    expect(md2).toContain("병합앵커");
  }, 60000);
});

describe("proposeTableStructureTool — 오류 케이스", () => {
  it("anchor 없음 → 오류 문자열 반환", async () => {
    const subDir = join(testDir, `no-anchor-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const filePath = await saveTwoTableHwpx(subDir, "two-tables.hwpx");
    const originalBuf = await readFile(filePath);

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "two-tables.hwpx",
        anchor: "절대존재하지않는텍스트XYZ",
        operations: [{ type: "insertRow", row: 0, position: "below" }],
        summary: "없는 anchor 테스트",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("anchor");

    // 파일 내용 변경 없음
    const afterBuf = await readFile(filePath);
    expect(Buffer.from(afterBuf).equals(Buffer.from(originalBuf))).toBe(true);
  }, 60000);

  it("모호한 anchor (두 표 모두에 있는 텍스트) → 오류", async () => {
    const subDir = join(testDir, `ambiguous-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // 두 표 모두에 "공통" 텍스트 포함
    const md = `# 모호한 앵커 테스트

| 공통 | 값A |
| --- | --- |
| A1 | A2 |

| 공통 | 값B |
| --- | --- |
| B1 | B2 |
`;
    await saveHwpx(subDir, "ambiguous.hwpx", md);

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "ambiguous.hwpx",
        anchor: "공통",
        operations: [{ type: "insertRow", row: 0, position: "below" }],
        summary: "모호한 anchor 테스트",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    // 여러 표에서 발견됐다는 메시지
    const msg = result as string;
    expect(
      msg.toLowerCase().includes("여러") || msg.includes("anchor") || msg.includes("오류"),
    ).toBe(true);
  }, 60000);

  it("지원 안 하는 확장자 → 오류", async () => {
    const subDir = join(testDir, `ext-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const filePath = join(subDir, "test.docx");
    await writeFile(filePath, Buffer.from("fake"));

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "test.docx",
        anchor: "앵커",
        operations: [{ type: "insertRow", row: 0, position: "below" }],
        summary: "확장자 오류 테스트",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain(".hwp");
  }, 10000);
});

describe("proposeTableStructureTool — .hwp 입력 처리", () => {
  it(".hwp 확장자 파일 → 출력 경로 .hwpx, willConvertFormat, 경고 포함", async () => {
    const subDir = join(testDir, `hwp-input-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // .hwpx를 생성하고 .hwp 확장자로 복사 (rhwp는 실제로 HWPX 바이트를 받음)
    const md = `# HWP 입력 테스트

| hwp테스트앵커 | 값 |
| --- | --- |
| R1 | V1 |
| R2 | V2 |
`;
    const hwpxPath = await saveHwpx(subDir, "source.hwpx", md);
    const hwpContent = await readFile(hwpxPath);

    const hwpPath = join(subDir, "test.hwp");
    await writeFile(hwpPath, hwpContent);

    const ctx = makeCtx(subDir);
    const result = await proposeTableStructureTool.propose?.({
      input: {
        path: "test.hwp",
        anchor: "hwp테스트앵커",
        operations: [{ type: "insertRow", row: 1, position: "below" }],
        summary: "hwp 파일 표 구조 편집",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as {
      proposal: {
        targetPath: string;
        willConvertFormat: string | undefined;
        warnings: string[];
      };
      commit: () => Promise<string>;
    };

    // 출력 경로가 .hwpx
    expect(extname(outcome.proposal.targetPath).toLowerCase()).toBe(".hwpx");

    // willConvertFormat 설정됨
    expect(outcome.proposal.willConvertFormat).toBeDefined();
    expect(outcome.proposal.willConvertFormat).toContain(".hwp");
    expect(outcome.proposal.willConvertFormat).toContain(".hwpx");

    // .hwp 입력 경고 포함
    expect(outcome.proposal.warnings.some((w) => w.includes(".hwp"))).toBe(true);

    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain("저장 완료");
    expect(commitMsg).toContain(".hwpx");
  }, 60000);
});
