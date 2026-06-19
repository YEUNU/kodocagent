/**
 * propose_cell_edit 툴 — HWPX 표 셀 직접 XML 패치
 * docs/SPEC.md §6, §7
 *
 * propose_edit/propose_form_fill은 마크다운 기반 패치(patchHwpx)라
 * 셀 좌표를 직접 지정하거나 병합(cellSpan) 구조를 다루기 어렵다.
 * 이 툴은 좌표 지정·merges 보존 셀 편집을 지원한다.
 *
 * kordoc-api-first 원칙: 자체 XML 토크나이저 대신 kordoc 프리미티브를 사용한다.
 *   - 표/셀 소스맵: `scanSectionXml` (ScanTable.cellByAnchor "r,c", colSpan/rowSpan, 셀 문단)
 *   - 셀 텍스트 쓰기: `buildParagraphSplices` (첫 hp:t에 새 텍스트·나머지 비움, run/charPr 보존,
 *     hp:t가 없으면 삽입 — 빈 셀 채우기) + `applySplices`
 * 병합(cellSpan) 구조는 셀 텍스트 문단만 수술하고 표 구조를 건드리지 않으므로 보존된다.
 *
 * tableIndex 순서 정책:
 *   - kordoc parse().blocks의 table 블록 순서와 일치 (0-based, 최상위 표만, 중첩·머리말/꼬리말 제외).
 *     scanSectionXml.tables가 동일 기준이므로 read_document가 보여주는 tableIndex와 정합한다.
 *   - tableIndex는 전체 섹션에 걸쳐 연속(section0 → section1 → …).
 *
 * 기능:
 *   A. 빈 셀 채우기: hp:t가 없는 셀(<hp:t/> 등)도 buildParagraphSplices가 삽입하여 값 주입.
 *   B. 레이블 기반 셀 타겟팅: label + direction으로 인접 셀을 찾아 편집(병합 span 반영).
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import type { ScanCell, ScanTable, SpliceEdit } from "kordoc";
import { applySplices, buildParagraphSplices, scanSectionXml } from "kordoc";
import { z } from "zod";
import {
  assertFileSizeWithinLimit,
  assertZipNotBomb,
  hwpStructuralGuard,
  isZipBinary,
  resolveSafePath,
} from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

/**
 * 편집 항목: 좌표 모드(tableIndex+row+col) 또는 레이블 모드(label[+direction]) 중 하나.
 *
 * 모든 주소 필드를 optional로 두고(좌표 XOR 라벨 검증은 propose 핸들러에서 수행),
 * JSON Schema 변환이 가능하도록 z.undefined()·union을 쓰지 않는다.
 */
export const cellEditItemSchema = z
  .object({
    tableIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "좌표 모드: 0-based 표 인덱스(read_document의 kordoc 블록 순서, 중첩표 제외). " +
          "레이블 모드에선 탐색 범위 제한용(선택).",
      ),
    row: z.number().int().nonnegative().optional().describe("좌표 모드: 셀의 rowAddr (0-based)"),
    col: z.number().int().nonnegative().optional().describe("좌표 모드: 셀의 colAddr (0-based)"),
    label: z
      .string()
      .optional()
      .describe(
        "레이블 모드: 기준 셀 텍스트(트림 비교). 이 셀의 direction 방향 인접 셀에 newText를 기록. " +
          "좌표 모드면 생략.",
      ),
    direction: z
      .enum(["right", "below"])
      .optional()
      .describe("레이블 모드 방향. 기본 right(오른쪽 셀), below(아래 셀). 병합 span 고려."),
    newText: z.string().describe("셀에 쓸 새 텍스트"),
    expectedText: z
      .string()
      .optional()
      .describe(
        "현재 셀 텍스트(안전 검증용). 불일치 시 수정하지 않음. 잘못된 셀 수정 방지를 위해 권장.",
      ),
  })
  .describe(
    "편집 항목. 좌표 모드(tableIndex+row+col) 또는 레이블 모드(label[+direction]) 중 하나를 사용하세요. " +
      "둘 다 지정하거나 둘 다 생략하면 오류입니다.",
  );

export const proposeCellEditSchema = z.object({
  path: z.string().describe("수정할 .hwpx 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  edits: z
    .array(cellEditItemSchema)
    .min(1)
    .describe(
      "편집 목록. 각 항목은 좌표 모드(tableIndex+row+col) 또는 레이블 모드(label+direction) 중 하나",
    ),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type CellEditItem = z.infer<typeof cellEditItemSchema>;
export type ProposeCellEditInput = z.infer<typeof proposeCellEditSchema>;

// ─────────────────────────────────────────────────────────
// scanSectionXml 기반 셀 모델 헬퍼
// ─────────────────────────────────────────────────────────

/** 셀의 자체 텍스트(문단 t-도메인 텍스트 연결, 중첩표 제외 — scanSectionXml이 분리해 제공). */
function cellOwnText(cell: ScanCell): string {
  return cell.paragraphs.map((p) => p.text).join("");
}

/** 최상위 표의 셀을 (row,col) 앵커로 조회. 없으면 undefined. */
function cellAt(table: ScanTable, row: number, col: number): ScanCell | undefined {
  return table.cellByAnchor.get(`${row},${col}`);
}

export interface CellEditRequest {
  tableIndex: number;
  row: number;
  col: number;
  newText: string;
  expectedText?: string;
}

export interface CellEditResult {
  success: boolean;
  /** 편집 전 셀 텍스트 */
  oldText?: string;
  error?: string;
}

/**
 * 셀 하나에 newText를 쓰는 splice를 만든다.
 * 첫 문단 첫 run에 새 텍스트(buildParagraphSplices가 XML-이스케이프), 나머지 문단·run은 비운다.
 * @returns splice 배열, 또는 null(쓰기 불가 — 셀 구조 문제)
 */
function buildCellWriteSplices(cell: ScanCell, newText: string): SpliceEdit[] | null {
  const paras = cell.paragraphs;
  if (paras.length === 0) return null;
  const firstParagraph = paras[0];
  if (firstParagraph === undefined) return null;
  const first = buildParagraphSplices(firstParagraph, newText, undefined);
  if (first === null) return null;
  const splices: SpliceEdit[] = [...first];
  // 나머지 문단은 비운다(구 동작: 첫 run만 남기고 모두 비움). 비우기 실패는 무시.
  for (let i = 1; i < paras.length; i++) {
    const para = paras[i];
    if (para === undefined) continue;
    const clear = buildParagraphSplices(para, "", undefined);
    if (clear !== null) splices.push(...clear);
  }
  return splices;
}

/**
 * 섹션 XML에 셀 편집을 적용한다. 순수 함수.
 *
 * @param xml     원본 섹션 XML 문자열
 * @param edits   편집 목록 (tableIndex는 이 섹션 기준 상대 인덱스)
 * @returns       { newXml, results } — results[i]에 편집 성공/실패 정보
 *
 * 실패한 편집이 하나라도 있으면 newXml === xml (XML 무변경).
 */
export function applyCellEditsToSectionXml(
  xml: string,
  edits: CellEditRequest[],
): { newXml: string; results: CellEditResult[] } {
  const scan = scanSectionXml(xml, 0);
  const tables = scan.tables;
  const results: CellEditResult[] = edits.map(() => ({ success: false }));
  const allSplices: SpliceEdit[] = [];

  for (let ei = 0; ei < edits.length; ei++) {
    const edit = edits[ei];
    if (edit === undefined) continue;

    const table = tables[edit.tableIndex];
    if (table === undefined) {
      results[ei] = {
        success: false,
        error: `표 ${edit.tableIndex}를 찾을 수 없습니다. 이 섹션에 총 ${tables.length}개의 최상위 표가 있습니다.`,
      };
      continue;
    }

    const cell = cellAt(table, edit.row, edit.col);
    if (cell === undefined) {
      results[ei] = {
        success: false,
        error:
          `표 ${edit.tableIndex}에서 셀 (행 ${edit.row}, 열 ${edit.col})을 찾을 수 없습니다. ` +
          `cellAddr colAddr="${edit.col}" rowAddr="${edit.row}"에 해당하는 셀이 없습니다.`,
      };
      continue;
    }

    const currentText = cellOwnText(cell);

    // expectedText 낙관적-동시성 가드도 NFC 정규화 후 비교(NFD/NFC 불일치로 정당한 편집이
    // 헛발 실패하는 것 방지 — 라벨 매칭과 동일한 한글 정규화 처리).
    if (
      edit.expectedText !== undefined &&
      edit.expectedText.normalize("NFC") !== currentText.normalize("NFC")
    ) {
      results[ei] = {
        success: false,
        oldText: currentText,
        error:
          `셀 (표 ${edit.tableIndex}, 행 ${edit.row}, 열 ${edit.col})의 현재 텍스트가 예상값과 다릅니다. ` +
          `예상: "${edit.expectedText}", 실제: "${currentText}". 수정하지 않습니다.`,
      };
      continue;
    }

    const splices = buildCellWriteSplices(cell, edit.newText);
    if (splices === null) {
      results[ei] = {
        success: false,
        oldText: currentText,
        error:
          `셀 (표 ${edit.tableIndex}, 행 ${edit.row}, 열 ${edit.col})에 텍스트 런이 없습니다. ` +
          `편집 가능한 문단/런이 없어 값을 쓸 수 없습니다. 셀 구조를 확인하세요.`,
      };
      continue;
    }

    allSplices.push(...splices);
    results[ei] = { success: true, oldText: currentText };
  }

  // 실패한 편집이 있으면 XML 무변경
  if (results.some((r) => !r.success)) {
    return { newXml: xml, results };
  }

  return { newXml: applySplices(xml, allSplices), results };
}

/**
 * XML에서 특정 표·셀의 현재 텍스트를 읽는다 (단위 테스트용).
 * tableIndex: kordoc 순서 (최상위 표만, 0-based)
 * row/col: cellAddr rowAddr/colAddr
 * 반환: 셀의 텍스트, 또는 null (표/셀 미발견)
 */
export function readCellTextFromXml(
  xml: string,
  tableIndex: number,
  row: number,
  col: number,
): string | null {
  const scan = scanSectionXml(xml, 0);
  const table = scan.tables[tableIndex];
  if (table === undefined) return null;
  const cell = cellAt(table, row, col);
  if (cell === undefined) return null;
  return cellOwnText(cell);
}

// ─────────────────────────────────────────────────────────
// 레이블 기반 셀 탐색 (Capability B)
// ─────────────────────────────────────────────────────────

/** 레이블 기반 셀 탐색 결과. */
export type LabelTargetResult =
  | { tableIndex: number; row: number; col: number }
  | { error: string };

/** 셀 앵커 키 "r,c"를 [row, col] 숫자로 파싱. */
function parseAnchor(key: string): { row: number; col: number } {
  const [r, c] = key.split(",");
  return { row: Number(r), col: Number(c) };
}

/** 한 섹션 스캔에서 레이블과 일치하는 셀(앵커·span 포함) 목록을 모은다. */
function findLabelMatchesInScan(
  tables: ScanTable[],
  trimmedLabel: string,
  startIdx: number,
  endIdx: number,
): Array<{ tableIndex: number; row: number; col: number; colSpan: number; rowSpan: number }> {
  const out: Array<{
    tableIndex: number;
    row: number;
    col: number;
    colSpan: number;
    rowSpan: number;
  }> = [];
  for (let ti = startIdx; ti <= endIdx; ti++) {
    const table = tables[ti];
    if (table === undefined) continue;
    for (const [key, cell] of table.cellByAnchor) {
      if (cellOwnText(cell).trim().normalize("NFC") === trimmedLabel.normalize("NFC")) {
        const { row, col } = parseAnchor(key);
        out.push({ tableIndex: ti, row, col, colSpan: cell.colSpan, rowSpan: cell.rowSpan });
      }
    }
  }
  return out;
}

/** 레이블 셀 + 방향 → 대상 셀 좌표 계산(병합 span 반영). */
function targetFromLabel(
  m: { row: number; col: number; colSpan: number; rowSpan: number },
  direction: "right" | "below",
): { row: number; col: number } {
  return direction === "right"
    ? { row: m.row, col: m.col + m.colSpan }
    : { row: m.row + m.rowSpan, col: m.col };
}

/**
 * XML 문자열에서 레이블로 인접 셀의 좌표를 찾는다 (단일 섹션).
 *
 * 탐색 방식:
 *   1. searchTableIndex가 주어지면 해당 표에서만, 없으면 모든 최상위 표에서 탐색.
 *   2. 각 셀의 자체 텍스트를 트림하여 label과 비교. 여럿이면 ambiguity 오류.
 *   3. direction "right": target = (rowAddr, colAddr + colSpan)
 *      direction "below": target = (rowAddr + rowSpan, colAddr)
 *   4. 대상 cellAddr를 가진 셀이 없으면 오류.
 */
export function resolveLabelTarget(
  xml: string,
  label: string,
  direction: "right" | "below",
  searchTableIndex?: number,
): LabelTargetResult {
  const scan = scanSectionXml(xml, 0);
  const tables = scan.tables;
  const trimmedLabel = label.trim().normalize("NFC");

  const startIdx = searchTableIndex ?? 0;
  const endIdx = searchTableIndex !== undefined ? searchTableIndex : tables.length - 1;

  const matches = findLabelMatchesInScan(tables, trimmedLabel, startIdx, endIdx);

  if (matches.length === 0) {
    const scope = searchTableIndex !== undefined ? `표 ${searchTableIndex}` : "문서 내 모든 표";
    return {
      error: `레이블 "${label}"을(를) ${scope}에서 찾을 수 없습니다. read_document로 표 내용을 확인하세요.`,
    };
  }

  if (matches.length > 1) {
    const locs = matches.map((m) => `표 ${m.tableIndex} (행 ${m.row}, 열 ${m.col})`).join(", ");
    return {
      error:
        `레이블 "${label}"이(가) 여러 셀에서 발견되었습니다: ${locs}. ` +
        `tableIndex로 탐색 범위를 좁히거나 좌표(row/col)를 직접 지정하세요.`,
    };
  }

  const match = matches[0] as (typeof matches)[number];
  const target = targetFromLabel(match, direction);

  const table = tables[match.tableIndex];
  if (table === undefined) {
    return { error: `표 ${match.tableIndex}를 찾을 수 없습니다 (내부 오류).` };
  }
  if (cellAt(table, target.row, target.col) === undefined) {
    const dirLabel = direction === "right" ? "오른쪽" : "아래";
    return {
      error:
        `레이블 "${label}" (표 ${match.tableIndex}, 행 ${match.row}, 열 ${match.col})의 ` +
        `${dirLabel} 셀 (행 ${target.row}, 열 ${target.col})이 존재하지 않습니다. ` +
        `direction 또는 좌표를 확인하세요.`,
    };
  }

  return { tableIndex: match.tableIndex, row: target.row, col: target.col };
}

// ─────────────────────────────────────────────────────────
// ZIP 처리 (다중 섹션 — tableIndex 전역 연속)
// ─────────────────────────────────────────────────────────

const SECTION_RE = /^Contents\/section\d+\.xml$/;

/** .hwpx의 섹션 XML과 섹션별 최상위 표 수·전역 오프셋을 읽는다. */
async function readSections(
  zip: JSZip,
): Promise<Array<{ name: string; xml: string; tblCount: number; globalOffset: number }>> {
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => SECTION_RE.test(name))
    .sort();
  const out: Array<{ name: string; xml: string; tblCount: number; globalOffset: number }> = [];
  let globalOffset = 0;
  for (const name of sectionFiles) {
    const entry = zip.file(name);
    const xml = entry ? await entry.async("string") : "";
    const tblCount = scanSectionXml(xml, 0).tables.length;
    out.push({ name, xml, tblCount, globalOffset });
    globalOffset += tblCount;
  }
  return out;
}

/**
 * .hwpx 파일의 모든 섹션 XML에서 편집을 적용하고 새 ZIP 버퍼를 반환한다.
 * tableIndex는 전체 섹션에 걸쳐 연속적이다 (section0 → section1 → …).
 *
 * zip과 sections를 외부에서 전달받아 ZIP 이중 해제를 방지한다.
 */
async function applyEditsToHwpx(
  hwpxBuffer: Uint8Array,
  edits: CellEditRequest[],
  preloadedZip?: JSZip,
  preloadedSections?: Array<{ name: string; xml: string; tblCount: number; globalOffset: number }>,
): Promise<{ buffer: Uint8Array; results: CellEditResult[] }> {
  const zip = preloadedZip ?? (await JSZip.loadAsync(hwpxBuffer));
  const sections = preloadedSections ?? (await readSections(zip));
  const totalTables = sections.reduce((a, s) => a + s.tblCount, 0);

  // 섹션별 편집 분배 (전역 tableIndex → 섹션 내 상대 인덱스)
  interface SectionEdit extends CellEditRequest {
    originalEditIdx: number;
  }
  const sectionEdits: SectionEdit[][] = sections.map(() => []);
  for (let ei = 0; ei < edits.length; ei++) {
    const edit = edits[ei];
    if (edit === undefined) continue;
    for (let si = 0; si < sections.length; si++) {
      const s = sections[si];
      if (s === undefined) continue;
      if (edit.tableIndex >= s.globalOffset && edit.tableIndex < s.globalOffset + s.tblCount) {
        sectionEdits[si]?.push({
          tableIndex: edit.tableIndex - s.globalOffset,
          row: edit.row,
          col: edit.col,
          newText: edit.newText,
          expectedText: edit.expectedText,
          originalEditIdx: ei,
        });
        break;
      }
    }
  }

  const allResults: CellEditResult[] = edits.map((edit, ei) => ({
    success: false,
    error: `표 ${edit?.tableIndex ?? ei}를 찾을 수 없습니다. 문서에 총 ${totalTables}개의 최상위 표가 있습니다.`,
  }));

  const newSectionXmls = sections.map((s) => s.xml);
  for (let si = 0; si < sections.length; si++) {
    const sEdits = sectionEdits[si] ?? [];
    if (sEdits.length === 0) continue;
    const srcXml = sections[si]?.xml ?? "";
    const { newXml, results } = applyCellEditsToSectionXml(srcXml, sEdits);
    newSectionXmls[si] = newXml;
    for (let i = 0; i < sEdits.length; i++) {
      const sEdit = sEdits[i];
      const res = results[i];
      if (sEdit && res) allResults[sEdit.originalEditIdx] = res;
    }
  }

  // 실패가 있으면 ZIP 생성 안 함 (원자성)
  if (allResults.some((r) => !r.success)) {
    return { buffer: hwpxBuffer, results: allResults };
  }

  // 새 ZIP 생성 (mimetype은 STORE로 첫 번째)
  const out = new JSZip();
  const mimetypeEntry = zip.file("mimetype");
  if (mimetypeEntry) {
    out.file("mimetype", await mimetypeEntry.async("uint8array"), { compression: "STORE" });
  }
  const nameToIdx = new Map(sections.map((s, i) => [s.name, i]));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "mimetype" || entry.dir) continue;
    const idx = nameToIdx.get(name);
    if (idx !== undefined) {
      out.file(name, newSectionXmls[idx] ?? "");
    } else {
      out.file(name, await entry.async("uint8array"));
    }
  }
  const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer: new Uint8Array(buf as unknown as ArrayBuffer), results: allResults };
}

/**
 * 전체 문서(다중 섹션)에서 레이블로 셀을 탐색해 전역 좌표로 해석한다.
 * 레이블 탐색은 섹션 경계를 넘어 "문서 전체" 관점으로 수행한다.
 */
function resolveLabelAcrossSections(
  sections: Array<{ xml: string; tblCount: number; globalOffset: number }>,
  label: string,
  direction: "right" | "below",
  scopedGlobalTableIndex?: number,
): { tableIndex: number; row: number; col: number } | { error: string } {
  const trimmedLabel = label.trim().normalize("NFC");
  interface GlobalMatch {
    globalTableIndex: number;
    row: number;
    col: number;
    colSpan: number;
    rowSpan: number;
  }
  const matches: GlobalMatch[] = [];

  for (const s of sections) {
    const tables = scanSectionXml(s.xml, 0).tables;
    let localStart = 0;
    let localEnd = s.tblCount - 1;
    if (scopedGlobalTableIndex !== undefined) {
      const localIdx = scopedGlobalTableIndex - s.globalOffset;
      if (localIdx < 0 || localIdx >= s.tblCount) continue; // 이 섹션에 없음
      localStart = localIdx;
      localEnd = localIdx;
    }
    for (const m of findLabelMatchesInScan(tables, trimmedLabel, localStart, localEnd)) {
      matches.push({
        globalTableIndex: s.globalOffset + m.tableIndex,
        row: m.row,
        col: m.col,
        colSpan: m.colSpan,
        rowSpan: m.rowSpan,
      });
    }
  }

  if (matches.length === 0) {
    const scope =
      scopedGlobalTableIndex !== undefined ? `표 ${scopedGlobalTableIndex}` : "문서 내 모든 표";
    return {
      error: `레이블 "${label}"을(를) ${scope}에서 찾을 수 없습니다. read_document로 표 내용을 확인하세요.`,
    };
  }
  if (matches.length > 1) {
    const locs = matches
      .map((m) => `표 ${m.globalTableIndex} (행 ${m.row}, 열 ${m.col})`)
      .join(", ");
    return {
      error:
        `레이블 "${label}"이(가) 여러 셀에서 발견되었습니다: ${locs}. ` +
        `tableIndex로 탐색 범위를 좁히거나 좌표(row/col)를 직접 지정하세요.`,
    };
  }

  const match = matches[0] as GlobalMatch;
  const target = targetFromLabel(match, direction);

  // 대상 셀 존재 확인 (같은 섹션·같은 표)
  const section = sections.find(
    (s) =>
      match.globalTableIndex >= s.globalOffset &&
      match.globalTableIndex < s.globalOffset + s.tblCount,
  );
  if (section === undefined) {
    return { error: `표 ${match.globalTableIndex}를 찾을 수 없습니다 (내부 오류).` };
  }
  const localIdx = match.globalTableIndex - section.globalOffset;
  const table = scanSectionXml(section.xml, 0).tables[localIdx];
  if (table === undefined || cellAt(table, target.row, target.col) === undefined) {
    const dirLabel = direction === "right" ? "오른쪽" : "아래";
    return {
      error:
        `레이블 "${label}" (표 ${match.globalTableIndex}, 행 ${match.row}, 열 ${match.col})의 ` +
        `${dirLabel} 셀 (행 ${target.row}, 열 ${target.col})이 존재하지 않습니다. ` +
        `direction 또는 좌표를 확인하세요.`,
    };
  }

  return { tableIndex: match.globalTableIndex, row: target.row, col: target.col };
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const proposeCellEditTool: ToolDefinition<ProposeCellEditInput> = {
  name: "propose_cell_edit",
  description:
    "HWPX 문서의 표 셀 내용을 좌표/레이블 지정으로 수정합니다. " +
    "병합 셀(cellSpan/rowSpan)이 있는 표에서도 병합 구조를 완전히 보존합니다. " +
    "빈 셀도 채울 수 있어 양식(form) 편집에 적합합니다. " +
    "셀 주소 지정 방법: " +
    "(1) 좌표 모드 — tableIndex + row + col 직접 지정. " +
    "(2) 레이블 모드 — label(인접 레이블 셀 텍스트) + direction(right/below, 기본 right) + 선택적 tableIndex로 " +
    "레이블 옆/아래 셀을 자동으로 찾아 편집. 병합 레이블 셀도 colSpan/rowSpan을 반영하여 대상 셀을 계산합니다. " +
    "propose_edit/propose_form_fill은 마크다운 라운드트립으로 병합 셀을 소실시키므로, " +
    "병합 셀이 있는 표를 수정할 때는 이 툴을 사용하세요. " +
    ".hwpx 파일 전용입니다. .hwp는 지원하지 않으며 Hancom에서 .hwpx로 저장 후 사용하세요. " +
    "수정 전에 반드시 read_document로 원본을 읽고, expectedText를 지정하여 안전하게 수정하세요. " +
    "변경 사항은 diff 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: proposeCellEditSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeCellEditInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // .hwpx 전용 — .hwp 및 기타 거부 (확장자 기반 조기 검사)
    if (ext !== ".hwpx" && ext !== ".hwp") {
      return (
        `오류: propose_cell_edit은 .hwpx 파일만 지원합니다. 현재 파일: ${ext}. ` +
        "표 셀 직접 편집은 .hwpx 포맷에서만 가능합니다."
      );
    }

    // 파일 크기 가드 — 원본 readFile 직전
    try {
      await assertFileSizeWithinLimit(safePath);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
    }

    // 파일 읽기 — 읽기 직후 mtime을 캡처해 lost-update 베이스라인으로 사용
    let originalBuffer: Buffer;
    let sourceMtimeMs: number | undefined;
    try {
      originalBuffer = await readFile(safePath);
      sourceMtimeMs = (await stat(safePath)).mtimeMs;
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하거나 read_document로 먼저 확인하세요.`;
    }

    const originalBytes = new Uint8Array(originalBuffer.buffer as ArrayBuffer);

    // OLE2/HWP 바이너리 가드 — 콘텐츠 기반 감지 (확장자 오인식 포함)
    const structuralGuard = hwpStructuralGuard(ext, originalBytes);
    if (structuralGuard !== null) {
      return structuralGuard;
    }

    // ZIP 매직 바이트 검증 (PK = 0x504B) — kordoc isZipFile 위임. 비-ZIP .hwpx 거부
    if (!isZipBinary(originalBytes)) {
      return (
        "오류: 파일이 유효한 .hwpx(ZIP) 포맷이 아닙니다. " +
        "파일이 손상되었거나 구형 .hwp(OLE 바이너리) 포맷입니다. " +
        "한글 프로그램에서 .hwpx로 저장 후 다시 시도하세요."
      );
    }

    // 압축 폭탄 가드 — JSZip.loadAsync 직전
    try {
      assertZipNotBomb(originalBytes);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
    }

    // 레이블 기반 편집을 좌표로 해석하고 applyEditsToHwpx가 재사용할 수 있도록
    // ZIP을 한 번만 loadAsync한다 (동일 버퍼 이중 해제 방지).
    const sharedZip = await JSZip.loadAsync(new Uint8Array(originalBuffer.buffer as ArrayBuffer));
    const sections = await readSections(sharedZip);

    // 편집 항목을 좌표 기반으로 정규화
    const resolvedEdits: Array<{
      tableIndex: number;
      row: number;
      col: number;
      newText: string;
      expectedText?: string;
      /** diff 표시용 원본 표현 */
      label?: string;
    }> = [];
    const resolveErrors: string[] = [];

    for (let i = 0; i < input.edits.length; i++) {
      const e = input.edits[i];
      if (!e) continue;

      if (e.label !== undefined && (e.row !== undefined || e.col !== undefined)) {
        // 좌표·레이블 동시 지정 — 모호하므로 거부
        resolveErrors.push(
          `편집 #${i + 1}: label과 row/col을 동시에 지정할 수 없습니다. ` +
            `좌표 모드(tableIndex+row+col) 또는 레이블 모드(label) 중 하나만 사용하세요.`,
        );
      } else if (e.label !== undefined) {
        // 레이블 모드
        const direction = (e.direction ?? "right") as "right" | "below";
        const resolved = resolveLabelAcrossSections(sections, e.label, direction, e.tableIndex);
        if ("error" in resolved) {
          resolveErrors.push(`편집 #${i + 1} (레이블 "${e.label}"): ${resolved.error}`);
        } else {
          resolvedEdits.push({
            tableIndex: resolved.tableIndex,
            row: resolved.row,
            col: resolved.col,
            newText: e.newText,
            expectedText: e.expectedText,
            label: e.label,
          });
        }
      } else if (e.tableIndex !== undefined && e.row !== undefined && e.col !== undefined) {
        // 좌표 모드
        resolvedEdits.push({
          tableIndex: e.tableIndex,
          row: e.row,
          col: e.col,
          newText: e.newText,
          expectedText: e.expectedText,
        });
      } else {
        // 좌표·레이블 둘 다 불완전
        resolveErrors.push(
          `편집 #${i + 1}: 좌표 모드(tableIndex+row+col) 또는 레이블 모드(label) 중 하나를 ` +
            `완전히 지정하세요. read_document로 표 내용을 먼저 확인하세요.`,
        );
      }
    }

    if (resolveErrors.length > 0) {
      return `오류: 다음 레이블을 해석할 수 없어 파일을 수정하지 않았습니다.\n${resolveErrors.join("\n")}`;
    }

    // 편집 적용
    const editRequests: CellEditRequest[] = resolvedEdits.map((e) => ({
      tableIndex: e.tableIndex,
      row: e.row,
      col: e.col,
      newText: e.newText,
      expectedText: e.expectedText,
    }));

    const { buffer: newBuffer, results } = await applyEditsToHwpx(
      new Uint8Array(originalBuffer.buffer as ArrayBuffer),
      editRequests,
      sharedZip,
      sections,
    );

    // 실패한 편집 확인
    const failedResults = results.map((r, i) => ({ r, i })).filter(({ r }) => !r.success);

    if (failedResults.length > 0) {
      const messages = failedResults.map(({ r, i }) => {
        const e = resolvedEdits[i];
        const label = e?.label ? `레이블 "${e.label}" → ` : "";
        return (
          `편집 #${i + 1} (${label}표 ${e?.tableIndex ?? "?"}, ` +
          `행 ${e?.row ?? "?"}, 열 ${e?.col ?? "?"}): ${r.error}`
        );
      });
      return `오류: 다음 편집을 적용할 수 없어 파일을 수정하지 않았습니다.\n${messages.join("\n")}`;
    }

    // diff 생성 (표·셀 변경 표)
    const diffLines = ["| 표·셀 | 이전 | 이후 |", "| --- | --- | --- |"];
    for (let i = 0; i < resolvedEdits.length; i++) {
      const e = resolvedEdits[i];
      if (!e) continue;
      const oldText = results[i]?.oldText ?? "";
      const addr = e.label
        ? `레이블 "${e.label}" → #${e.tableIndex} (${e.row},${e.col})`
        : `#${e.tableIndex} (${e.row},${e.col})`;
      diffLines.push(`| ${addr} | ${oldText} | ${e.newText} |`);
    }
    const diff = diffLines.join("\n");

    // 스테이징
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);
    const stagedPath = await stageFile(ctx.sessionId, safePath, newBuffer);

    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "cell-edit",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings: [],
        willConvertFormat,
        sourcePath: safePath,
        sourceMtimeMs,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(safePath, undefined, { summary: input.summary });
        // ① 포맷 변환 시 출력 경로 기존 파일도 별도 백업 (data-loss 방지)
        if (outputPath !== safePath) {
          await backupFile(outputPath, undefined, { summary: input.summary });
        }
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
