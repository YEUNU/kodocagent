/**
 * propose_table_structure 툴 — HWPX 표 구조 직접 XML 패치
 *
 * rhwp 엔진을 사용하지 않습니다. JSZip으로 .hwpx ZIP을 열고,
 * Contents/section*.xml 안의 <hp:tbl> 블록을 직접 수술하여 재조립합니다.
 *
 * 지원 연산:
 *   insertRow    — 행 삽입 (위/아래), rowAddr 시프트, rowCnt 증가
 *   deleteRow    — 행 삭제, rowAddr 시프트, rowCnt 감소
 *   insertColumn — 열 삽입 (왼쪽/오른쪽), colAddr 시프트, colCnt 증가
 *   deleteColumn — 열 삭제, colAddr 시프트, colCnt 감소
 *   mergeCells   — 셀 병합, 덮여지는 tc 제거, cellSpan 설정
 *
 * 표 찾기 (anchor 기반):
 *   각 최상위 <hp:tbl>의 <hp:t> 텍스트를 수집하여 anchor 부분 일치로 표를 식별한다.
 *   0개 → 한국어 오류; 2개 이상 → 모호함 오류.
 *   propose_cell_edit의 depth-aware 토크나이저를 재사용한다.
 *
 * 병합 셀 안전 처리:
 *   연산이 기존 병합 셀과 겹치면 안전하게 처리할 수 없는 경우
 *   한국어 오류를 반환하고 파일을 변경하지 않는다.
 *
 * 연산 순서:
 *   연산은 지정된 순서대로 적용된다. 나중 연산의 row/col 인덱스는
 *   앞 연산이 적용된 후의 표 상태를 기준으로 한다.
 *
 * 자기검증 게이트:
 *   1. kordoc parse()로 재파싱 성공 확인.
 *   2. 예상 행/열 수 vs 실제 표 구조 비교 (병합 전용 연산은 스킵).
 *   3. 블록 히스토그램 비교 (structural-loss.ts detectStructuralLoss).
 *
 * .hwpx 전용 — .hwp 거부 (ZIP 매직 검증 포함).
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "kordoc";
import JSZip from "jszip";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import { detectStructuralLoss } from "../structural-loss.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

const insertRowOpSchema = z.object({
  type: z.literal("insertRow"),
  row: z.number().int().nonnegative().describe("기준 행 인덱스 (0-based)"),
  position: z.enum(["above", "below"]).describe("삽입 위치: above=row 위에, below=row 아래에"),
});

const deleteRowOpSchema = z.object({
  type: z.literal("deleteRow"),
  row: z.number().int().nonnegative().describe("삭제할 행 인덱스 (0-based)"),
});

const insertColumnOpSchema = z.object({
  type: z.literal("insertColumn"),
  col: z.number().int().nonnegative().describe("기준 열 인덱스 (0-based)"),
  position: z.enum(["left", "right"]).describe("삽입 위치: left=col 왼쪽에, right=col 오른쪽에"),
});

const deleteColumnOpSchema = z.object({
  type: z.literal("deleteColumn"),
  col: z.number().int().nonnegative().describe("삭제할 열 인덱스 (0-based)"),
});

const mergeCellsOpSchema = z.object({
  type: z.literal("mergeCells"),
  startRow: z.number().int().nonnegative().describe("병합 시작 행 (0-based)"),
  startCol: z.number().int().nonnegative().describe("병합 시작 열 (0-based)"),
  endRow: z.number().int().nonnegative().describe("병합 끝 행 (0-based, 포함)"),
  endCol: z.number().int().nonnegative().describe("병합 끝 열 (0-based, 포함)"),
});

const operationSchema = z
  .discriminatedUnion("type", [
    insertRowOpSchema,
    deleteRowOpSchema,
    insertColumnOpSchema,
    deleteColumnOpSchema,
    mergeCellsOpSchema,
  ])
  .describe("표 구조 연산. 나중 연산의 row/col 인덱스는 앞 연산 적용 후 상태를 기준으로 한다.");

export type TableStructureOperation = z.infer<typeof operationSchema>;

export const proposeTableStructureSchema = z.object({
  path: z.string().describe("수정할 .hwpx 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  anchor: z
    .string()
    .min(1)
    .describe(
      "대상 표를 식별하는 앵커 텍스트. 표 안에만 있는 독특한 셀 텍스트를 지정하세요. " +
        "(부분 일치, 공백 트림) — read_document로 확인 후 사용 권장.",
    ),
  operations: z
    .array(operationSchema)
    .min(1)
    .describe(
      "적용할 표 구조 연산 목록 (순서대로 실행). " +
        "각 연산은 이전 연산이 적용된 후의 표 상태 기준으로 row/col을 지정해야 합니다.",
    ),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type ProposeTableStructureInput = z.infer<typeof proposeTableStructureSchema>;

// ─────────────────────────────────────────────────────────
// XML 토크나이저 (propose-cell-edit.ts와 동일 설계, 표 구조 ops용으로 확장)
// ─────────────────────────────────────────────────────────

type TokenKind =
  | "tbl_open"
  | "tbl_close"
  | "tr_open"
  | "tr_close"
  | "tc_open"
  | "tc_close"
  | "t_open"
  | "t_empty"
  | "t_close"
  | "cell_addr"
  | "cell_span"
  | "cell_sz"
  | "tbl_attr"; // <hp:tbl rowCnt/colCnt 속성 태그 자체

interface XmlToken {
  kind: TokenKind;
  pos: number;
  end: number;
  // cell_addr
  colAddr?: number;
  rowAddr?: number;
  // cell_span
  colSpan?: number;
  rowSpan?: number;
}

/**
 * 섹션 XML에서 관련 토큰을 순서대로 추출한다.
 * propose-cell-edit 토크나이저를 확장: tr_open/tr_close 추가.
 */
function tokenizeHwpxXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const re =
    /<hp:tbl[\s>]|<\/hp:tbl>|<hp:tr[\s>]|<\/hp:tr>|<hp:tc[\s>]|<\/hp:tc>|<hp:t\/>|<hp:t>|<\/hp:t>|<hp:cellAddr[^/>]*|<hp:cellSpan[^/>]*|<hp:cellSz[^/>]*/g;
  let m = re.exec(xml);
  while (m !== null) {
    const raw = m[0];
    const pos = m.index;
    if (raw.startsWith("<hp:tbl")) {
      tokens.push({ kind: "tbl_open", pos, end: pos + raw.length });
    } else if (raw === "</hp:tbl>") {
      tokens.push({ kind: "tbl_close", pos, end: pos + raw.length });
    } else if (raw.startsWith("<hp:tr")) {
      tokens.push({ kind: "tr_open", pos, end: pos + raw.length });
    } else if (raw === "</hp:tr>") {
      tokens.push({ kind: "tr_close", pos, end: pos + raw.length });
    } else if (raw.startsWith("<hp:tc")) {
      tokens.push({ kind: "tc_open", pos, end: pos + raw.length });
    } else if (raw === "</hp:tc>") {
      tokens.push({ kind: "tc_close", pos, end: pos + raw.length });
    } else if (raw === "<hp:t/>") {
      tokens.push({ kind: "t_empty", pos, end: pos + raw.length });
    } else if (raw === "<hp:t>") {
      tokens.push({ kind: "t_open", pos, end: pos + raw.length });
    } else if (raw === "</hp:t>") {
      tokens.push({ kind: "t_close", pos, end: pos + raw.length });
    } else if (raw.startsWith("<hp:cellAddr")) {
      const colM = raw.match(/colAddr="(\d+)"/);
      const rowM = raw.match(/rowAddr="(\d+)"/);
      if (colM && rowM) {
        const selfClose = xml.indexOf("/>", pos);
        const end = selfClose >= 0 ? selfClose + 2 : pos + raw.length;
        tokens.push({
          kind: "cell_addr",
          pos,
          end,
          colAddr: Number(colM[1]),
          rowAddr: Number(rowM[1]),
        });
      }
    } else if (raw.startsWith("<hp:cellSpan")) {
      const colM = raw.match(/colSpan="(\d+)"/);
      const rowM = raw.match(/rowSpan="(\d+)"/);
      const selfClose = xml.indexOf("/>", pos);
      const end = selfClose >= 0 ? selfClose + 2 : pos + raw.length;
      tokens.push({
        kind: "cell_span",
        pos,
        end,
        colSpan: colM ? Number(colM[1]) : 1,
        rowSpan: rowM ? Number(rowM[1]) : 1,
      });
    } else if (raw.startsWith("<hp:cellSz")) {
      const selfClose = xml.indexOf("/>", pos);
      const end = selfClose >= 0 ? selfClose + 2 : pos + raw.length;
      tokens.push({ kind: "cell_sz", pos, end });
    }
    m = re.exec(xml);
  }
  return tokens;
}

// ─────────────────────────────────────────────────────────
// 최상위 표 범위 탐색 (depth-aware)
// ─────────────────────────────────────────────────────────

interface TableRange {
  start: number; // <hp:tbl 시작 위치
  end: number; // </hp:tbl> 끝 위치 (exclusive)
  index: number; // 최상위 표 인덱스 (0-based)
}

/**
 * XML에서 모든 최상위 <hp:tbl> 범위를 열거한다.
 * 중첩된 <hp:tbl>은 별도 카운팅하지 않는다.
 */
function findAllTopLevelTableRanges(tokens: XmlToken[]): TableRange[] {
  const ranges: TableRange[] = [];
  let depth = 0;
  let topCount = 0;
  let startPos = -1;

  for (const tok of tokens) {
    if (tok.kind === "tbl_open") {
      if (depth === 0) {
        startPos = tok.pos;
      }
      depth++;
    } else if (tok.kind === "tbl_close") {
      depth--;
      if (depth === 0 && startPos >= 0) {
        ranges.push({ start: startPos, end: tok.end, index: topCount });
        topCount++;
        startPos = -1;
      }
    }
  }
  return ranges;
}

// ─────────────────────────────────────────────────────────
// 표 내 텍스트 수집 (anchor 매칭용)
// ─────────────────────────────────────────────────────────

/**
 * 특정 표 범위 안의 모든 <hp:t>...<hp:t> 텍스트를 이어붙인다 (엔티티 디코딩).
 */
function collectTableText(
  xml: string,
  tokens: XmlToken[],
  tblStart: number,
  tblEnd: number,
): string {
  const parts: string[] = [];
  const tblTokens = tokens.filter((t) => t.pos >= tblStart && t.pos < tblEnd);
  for (const tok of tblTokens) {
    if (tok.kind === "t_open") {
      const closePos = xml.indexOf("</hp:t>", tok.end);
      if (closePos >= 0 && closePos < tblEnd) {
        const raw = xml.substring(tok.end, closePos);
        parts.push(raw.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
      }
    }
  }
  return parts.join("");
}

// ─────────────────────────────────────────────────────────
// 표 구조 파싱 (행 범위, 셀 메타데이터)
// ─────────────────────────────────────────────────────────

interface CellMeta {
  colAddr: number;
  rowAddr: number;
  colSpan: number;
  rowSpan: number;
  tcStart: number; // <hp:tc 시작
  tcEnd: number; // </hp:tc> 끝
}

interface RowMeta {
  trStart: number; // <hp:tr 시작
  trEnd: number; // </hp:tr> 끝
  cells: CellMeta[];
}

/**
 * 표 블록(tblStart..tblEnd) 안에서 직접 자식 <hp:tr>과 그 안의 셀 메타를 파싱한다.
 * 중첩 표의 tc/tr은 제외한다.
 */
function parseTableRows(
  _xml: string,
  tokens: XmlToken[],
  tblStart: number,
  tblEnd: number,
): RowMeta[] {
  const tblTokens = tokens.filter((t) => t.pos > tblStart && t.pos < tblEnd);

  const rows: RowMeta[] = [];
  const trStack: Array<{ pos: number }> = [];
  const tcStack: Array<{ pos: number }> = [];
  let innerTblDepth = 0;

  // cells being built for current tr
  let currentRowCells: CellMeta[] = [];

  for (const tok of tblTokens) {
    if (tok.kind === "tbl_open") {
      innerTblDepth++;
    } else if (tok.kind === "tbl_close") {
      innerTblDepth--;
    } else if (innerTblDepth > 0) {
      // inside nested table — ignore
    } else if (tok.kind === "tr_open") {
      trStack.push({ pos: tok.pos });
      currentRowCells = [];
    } else if (tok.kind === "tr_close") {
      const trEntry = trStack.pop();
      if (trEntry !== undefined) {
        rows.push({ trStart: trEntry.pos, trEnd: tok.end, cells: currentRowCells });
        currentRowCells = [];
      }
    } else if (tok.kind === "tc_open") {
      tcStack.push({ pos: tok.pos });
    } else if (tok.kind === "tc_close") {
      const tcEntry = tcStack.pop();
      if (tcEntry !== undefined) {
        // find cell_addr and cell_span within this tc
        const tcTokens = tblTokens.filter(
          (t) => t.pos >= tcEntry.pos && t.pos < tok.end && innerTblDepth === 0,
        );
        let colAddr = -1;
        let rowAddr = -1;
        let colSpan = 1;
        let rowSpan = 1;
        for (const t of tcTokens) {
          if (t.kind === "cell_addr" && t.colAddr !== undefined && t.rowAddr !== undefined) {
            colAddr = t.colAddr;
            rowAddr = t.rowAddr;
          } else if (t.kind === "cell_span" && t.colSpan !== undefined && t.rowSpan !== undefined) {
            colSpan = t.colSpan;
            rowSpan = t.rowSpan;
          }
        }
        if (colAddr >= 0 && rowAddr >= 0) {
          currentRowCells.push({
            colAddr,
            rowAddr,
            colSpan,
            rowSpan,
            tcStart: tcEntry.pos,
            tcEnd: tok.end,
          });
        }
      }
    }
  }

  return rows;
}

/**
 * rowCnt 및 colCnt 속성을 읽는다.
 * <hp:tbl rowCnt="N" colCnt="M" ...> 태그에서.
 */
function parseTblDimensions(xml: string, tblStart: number): { rowCnt: number; colCnt: number } {
  // tblStart → 첫 >
  const tagEnd = xml.indexOf(">", tblStart);
  const tagStr = xml.substring(tblStart, tagEnd + 1);
  const rowM = tagStr.match(/rowCnt="(\d+)"/);
  const colM = tagStr.match(/colCnt="(\d+)"/);
  return {
    rowCnt: rowM ? Number(rowM[1]) : 0,
    colCnt: colM ? Number(colM[1]) : 0,
  };
}

// ─────────────────────────────────────────────────────────
// <hp:tbl> 블록 교체 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * <hp:tbl ...> 태그의 rowCnt 또는 colCnt 속성값을 업데이트한다.
 */
function updateTblAttr(tblBlock: string, attr: "rowCnt" | "colCnt", newVal: number): string {
  return tblBlock.replace(new RegExp(`(${attr}=")\\d+(")`), `$1${newVal}$2`);
}

// ─────────────────────────────────────────────────────────
// 순수 표 구조 XML 변환 함수 (단위 테스트 가능)
// ─────────────────────────────────────────────────────────

export type TableOpResult = { ok: true; xml: string } | { ok: false; error: string };

/**
 * 빈 <hp:t/> self-closing 으로 텍스트를 지운다.
 * 셀 안의 <hp:t>...</hp:t> 런을 <hp:t/> 로 교체하고,
 * 그 외의 추가 <hp:t>...</hp:t> 런은 내용을 비운다.
 */
function clearCellText(tcXml: string): string {
  // Replace first <hp:t>content</hp:t> with <hp:t/>
  // and remove content from subsequent <hp:t>content</hp:t> runs
  let first = true;
  return tcXml.replace(/<hp:t>([\s\S]*?)<\/hp:t>/g, (_match, _content) => {
    if (first) {
      first = false;
      return "<hp:t/>";
    }
    return "<hp:t/>";
  });
}

/**
 * cellAddr rowAddr を N に書き換える。
 */
function setCellRowAddr(tcXml: string, newRow: number): string {
  return tcXml.replace(/(rowAddr=")(\d+)(")/, `$1${newRow}$3`);
}

/**
 * cellAddr colAddr を N に書き換える。
 */
function setCellColAddr(tcXml: string, newCol: number): string {
  return tcXml.replace(/(colAddr=")(\d+)(")/, `$1${newCol}$3`);
}

/**
 * cellSpan を colSpan=1 rowSpan=1 に書き換える。
 */
function resetCellSpan(tcXml: string): string {
  return tcXml.replace(/(colSpan=")(\d+)(")/, `$11$3`).replace(/(rowSpan=")(\d+)(")/, `$11$3`);
}

/**
 * cellSpan を指定値に書き換える。
 */
function setCellSpan(tcXml: string, colSpan: number, rowSpan: number): string {
  return tcXml
    .replace(/(colSpan=")(\d+)(")/, `$1${colSpan}$3`)
    .replace(/(rowSpan=")(\d+)(")/, `$1${rowSpan}$3`);
}

// ─────────────────────────────────────────────────────────
// insertRow
// ─────────────────────────────────────────────────────────

/**
 * 표 XML ブロックに行を挿入する。
 *
 * @param tblXml   対象表 <hp:tbl>...</hp:tbl> ブロック文字列
 * @param row      기준 행 인덱스 (0-based, rowAddr 기준)
 * @param below    true=row 아래, false=row 위에 삽입
 */
export function insertRowInTbl(tblXml: string, row: number, below: boolean): TableOpResult {
  const tokens = tokenizeHwpxXml(tblXml);

  // tblXml 전체가 하나의 <hp:tbl>이므로 tblStart=0
  const tblStart = 0;
  const tblEnd = tblXml.length;

  const rows = parseTableRows(tblXml, tokens, tblStart, tblEnd);
  const dims = parseTblDimensions(tblXml, tblStart);

  if (rows.length === 0) {
    return { ok: false, error: "표에 행이 없어 삽입할 수 없습니다." };
  }

  // 삽입 기준 행 범위 찾기
  const targetRow = rows.find((r) => r.cells.some((c) => c.rowAddr === row));
  if (!targetRow) {
    return {
      ok: false,
      error: `행 ${row}을 찾을 수 없습니다. 표에 rowAddr ${row}인 셀이 없습니다.`,
    };
  }

  // 병합 셀 충돌 검사: 삽입 위치와 교차하는 병합이 있는지 확인
  // 삽입 위치: below=true → newRowAddr = row+1, 삽입 전 row+1 이상의 행에 있는 셀들은 +1 시프트
  // below=false → newRowAddr = row
  const newRowAddr = below ? row + 1 : row;
  // 기존 셀 중 rowAddr < newRowAddr < rowAddr + rowSpan 인 셀은 병합을 가로지름
  for (const r of rows) {
    for (const c of r.cells) {
      if (c.rowSpan > 1) {
        // 이 셀의 병합 범위: c.rowAddr .. c.rowAddr + c.rowSpan - 1
        const spanEnd = c.rowAddr + c.rowSpan - 1;
        if (c.rowAddr < newRowAddr && newRowAddr <= spanEnd) {
          return {
            ok: false,
            error:
              `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
              `(셀 (행 ${c.rowAddr}, 열 ${c.colAddr})의 rowSpan=${c.rowSpan}이 삽입 위치 행 ${newRowAddr}을 가로지릅니다). ` +
              `병합을 해제한 후 시도하세요.`,
          };
        }
      }
    }
  }

  // 삽입할 새 tr 생성: targetRow를 복제하여 텍스트 비우기 + rowAddr 업데이트 + span 리셋
  // Note: targetRow.cells 좌표는 tblXml 기준이므로, tr 서브스트링의 오프셋으로 변환한다.
  const trOffset = targetRow.trStart;
  let modifiedTr = tblXml.substring(targetRow.trStart, targetRow.trEnd);

  // 각 셀을 역순으로 수정 (오프셋 보정 위해 역순)
  const sortedCells = [...targetRow.cells].sort((a, b) => b.tcStart - a.tcStart);

  for (const cell of sortedCells) {
    // tblXml 기준 위치를 modifiedTr 기준으로 변환
    const tcLocalStart = cell.tcStart - trOffset;
    const tcLocalEnd = cell.tcEnd - trOffset;
    let tcXml = modifiedTr.substring(tcLocalStart, tcLocalEnd);
    tcXml = setCellRowAddr(tcXml, newRowAddr);
    tcXml = resetCellSpan(tcXml);
    tcXml = clearCellText(tcXml);
    modifiedTr = modifiedTr.substring(0, tcLocalStart) + tcXml + modifiedTr.substring(tcLocalEnd);
  }

  // row 이상(below=false) 또는 row+1 이상(below=true)의 기존 행 rowAddr 시프트 (+1)
  // 원본 tblXml의 모든 셀 rowAddr를 시프트
  // 시프트 기준: newRowAddr 이상인 rowAddr → +1
  // (새 행 자체는 아직 삽입 전이므로 원본에서 시프트)
  let result = tblXml;

  // 셀 rowAddr 시프트: newRowAddr 이상 → +1 (역순 패치)
  // 전체 tblXml의 cellAddr 토큰에서 rowAddr >= newRowAddr인 것만 시프트
  const allTokens = tokenizeHwpxXml(result);
  const addrPatches: Array<{ pos: number; end: number; newAddr: number }> = [];

  for (const tok of allTokens) {
    if (tok.kind === "cell_addr" && tok.rowAddr !== undefined && tok.rowAddr >= newRowAddr) {
      addrPatches.push({ pos: tok.pos, end: tok.end, newAddr: tok.rowAddr + 1 });
    }
  }

  // 역순으로 패치 (오프셋 보전)
  addrPatches.sort((a, b) => b.pos - a.pos);
  for (const p of addrPatches) {
    const oldTag = result.substring(p.pos, p.end);
    const newTag = oldTag.replace(/(rowAddr=")(\d+)(")/, `$1${p.newAddr}$3`);
    result = result.substring(0, p.pos) + newTag + result.substring(p.end);
  }

  // targetRow は既に newRowAddr+1 にシフトされた — 挿入位置を決定
  // targetRow のシフト後の新しい位置を再計算する必要がある
  // 逆順に시프트したので、targetRow.trStart/End は変わる可能性がある
  // 最も確実な方法: シフト後の result から再度 targetRow 行の位置を探す
  const resultTokens = tokenizeHwpxXml(result);
  const resultRows = parseTableRows(result, resultTokens, 0, result.length);

  let insertAfterPos: number;
  let insertBeforePos: number;

  if (below) {
    // シフト後の row (rowAddr=row 行はシフトされていない → まだ row)
    // below=true: シフトは newRowAddr=row+1 以上 → row 行はそのまま
    const refRow = resultRows.find((r) => r.cells.some((c) => c.rowAddr === row));
    if (!refRow) {
      return { ok: false, error: "삽입 기준 행을 찾을 수 없습니다 (내부 오류)." };
    }
    insertAfterPos = refRow.trEnd;
  } else {
    // above=true: シフトは newRowAddr=row 以上 → 元の row 行はシフトされて row+1
    // 新しい行を挿入する位置 = 元の row 行の前 (シフト後は row+1 になっている)
    const refRow = resultRows.find((r) => r.cells.some((c) => c.rowAddr === row + 1));
    if (!refRow) {
      // row=0 で above の場合、最初の tr の前
      const firstRow = resultRows[0];
      if (!firstRow) {
        return { ok: false, error: "삽입 위치를 결정할 수 없습니다 (내부 오류)." };
      }
      insertBeforePos = firstRow.trStart;
    } else {
      insertBeforePos = refRow.trStart;
    }
    insertAfterPos = -1;
  }

  // 挿入
  if (below) {
    result = result.substring(0, insertAfterPos) + modifiedTr + result.substring(insertAfterPos);
  } else {
    result =
      result.substring(0, insertBeforePos!) + modifiedTr + result.substring(insertBeforePos!);
  }

  // rowCnt 増加
  result = updateTblAttr(result, "rowCnt", dims.rowCnt + 1);

  return { ok: true, xml: result };
}

// ─────────────────────────────────────────────────────────
// deleteRow
// ─────────────────────────────────────────────────────────

/**
 * 表 XML ブロックから行を削除する。
 */
export function deleteRowInTbl(tblXml: string, row: number): TableOpResult {
  const tokens = tokenizeHwpxXml(tblXml);
  const rows = parseTableRows(tblXml, tokens, 0, tblXml.length);
  const dims = parseTblDimensions(tblXml, 0);

  if (rows.length === 0) {
    return { ok: false, error: "표에 행이 없습니다." };
  }

  const targetRow = rows.find((r) => r.cells.some((c) => c.rowAddr === row));
  if (!targetRow) {
    return {
      ok: false,
      error: `행 ${row}을 찾을 수 없습니다. 표에 rowAddr ${row}인 셀이 없습니다.`,
    };
  }

  // 병합 셀 충돌 검사: 삭제할 행에 rowSpan>1인 셀이 있거나
  // 다른 행의 셀이 이 행을 걸치는 경우
  for (const cell of targetRow.cells) {
    if (cell.rowSpan > 1) {
      return {
        ok: false,
        error:
          `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
          `(행 ${row}의 셀 (열 ${cell.colAddr})에 rowSpan=${cell.rowSpan} 병합이 있습니다). ` +
          `병합을 해제한 후 시도하세요.`,
      };
    }
  }
  // 다른 행의 병합이 이 행을 걸치는지 확인
  for (const r of rows) {
    if (r.trStart === targetRow.trStart) continue;
    for (const c of r.cells) {
      if (c.rowSpan > 1) {
        const spanEnd = c.rowAddr + c.rowSpan - 1;
        if (c.rowAddr < row && row <= spanEnd) {
          return {
            ok: false,
            error:
              `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
              `(다른 행 셀 (행 ${c.rowAddr}, 열 ${c.colAddr})의 rowSpan=${c.rowSpan}이 삭제할 행 ${row}을 포함합니다). ` +
              `병합을 해제한 후 시도하세요.`,
          };
        }
      }
    }
  }

  // 행 삭제 + rowAddr 시프트 (row 초과하는 행을 -1)
  let result = tblXml;

  // 1. 行を削除
  result = result.substring(0, targetRow.trStart) + result.substring(targetRow.trEnd);

  // 2. rowAddr > row のセルを -1 シフト
  const afterTokens = tokenizeHwpxXml(result);
  const addrPatches: Array<{ pos: number; end: number; newAddr: number }> = [];
  for (const tok of afterTokens) {
    if (tok.kind === "cell_addr" && tok.rowAddr !== undefined && tok.rowAddr > row) {
      addrPatches.push({ pos: tok.pos, end: tok.end, newAddr: tok.rowAddr - 1 });
    }
  }
  addrPatches.sort((a, b) => b.pos - a.pos);
  for (const p of addrPatches) {
    const oldTag = result.substring(p.pos, p.end);
    const newTag = oldTag.replace(/(rowAddr=")(\d+)(")/, `$1${p.newAddr}$3`);
    result = result.substring(0, p.pos) + newTag + result.substring(p.end);
  }

  // 3. rowCnt 减少
  result = updateTblAttr(result, "rowCnt", dims.rowCnt - 1);

  return { ok: true, xml: result };
}

// ─────────────────────────────────────────────────────────
// insertColumn
// ─────────────────────────────────────────────────────────

/**
 * 表 XML ブロックに列を挿入する。
 * 各行に新しい <hp:tc> を挿入する。
 */
export function insertColumnInTbl(tblXml: string, col: number, right: boolean): TableOpResult {
  const tokens = tokenizeHwpxXml(tblXml);
  const rows = parseTableRows(tblXml, tokens, 0, tblXml.length);
  const dims = parseTblDimensions(tblXml, 0);

  if (rows.length === 0) {
    return { ok: false, error: "표에 행이 없어 열을 삽입할 수 없습니다." };
  }

  const newColAddr = right ? col + 1 : col;

  // 병합 셀 충돌 검사
  for (const r of rows) {
    for (const c of r.cells) {
      if (c.colSpan > 1) {
        const spanEnd = c.colAddr + c.colSpan - 1;
        if (c.colAddr < newColAddr && newColAddr <= spanEnd) {
          return {
            ok: false,
            error:
              `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
              `(셀 (행 ${c.rowAddr}, 열 ${c.colAddr})의 colSpan=${c.colSpan}이 삽입 위치 열 ${newColAddr}을 가로지릅니다). ` +
              `병합을 해제한 후 시도하세요.`,
          };
        }
      }
    }
  }

  // Step 1: colAddr >= newColAddr のセルを +1 シフト
  let result = tblXml;
  const allTokens = tokenizeHwpxXml(result);
  const addrPatches: Array<{ pos: number; end: number; newAddr: number }> = [];
  for (const tok of allTokens) {
    if (tok.kind === "cell_addr" && tok.colAddr !== undefined && tok.colAddr >= newColAddr) {
      addrPatches.push({ pos: tok.pos, end: tok.end, newAddr: tok.colAddr + 1 });
    }
  }
  addrPatches.sort((a, b) => b.pos - a.pos);
  for (const p of addrPatches) {
    const oldTag = result.substring(p.pos, p.end);
    const newTag = oldTag.replace(/(colAddr=")(\d+)(")/, `$1${p.newAddr}$3`);
    result = result.substring(0, p.pos) + newTag + result.substring(p.end);
  }

  // Step 2: 각 행에 새 tc 삽입 (역순으로 처리)
  const resultTokens2 = tokenizeHwpxXml(result);
  const resultRows = parseTableRows(result, resultTokens2, 0, result.length);

  // 行を逆順に処理
  const sortedRows = [...resultRows].sort((a, b) => b.trStart - a.trStart);

  for (const r of sortedRows) {
    // この行で参照セルを見つける (right=true → col, right=false → newColAddr(= col) )
    // 新しいセルのrowAddr = 行の最初のセルのrowAddr
    const refRowAddr = r.cells[0]?.rowAddr ?? 0;

    // 参照セル: right=true → シフト後のcol (今はcol+1) → 삽입할 위치 기준으로 인접 셀 선택
    // cloneするセル: right=true → シフト前のcol (== 現在のcol, まだシフト前なら... しかしStep1でシフト済み)
    // シフト後: 元のcol→col+1、元のcol-1→col-1(変わらず)
    // right=true: 新規列はnewColAddr=col+1 → 元のcol セル(現在col+1)をclone対象
    // right=false: 新規列はnewColAddr=col → 元のcol セル(現在col+1)をclone対象 (also)
    // 결론: シフト後のcol+1(元のcol)のセルをクローン対象とする
    const cloneSourceCell = r.cells.find((c) => c.colAddr === col + 1);
    // フォールバック: 隣接する任意のセルをclone
    const anyCell = cloneSourceCell ?? r.cells[0];

    if (!anyCell) continue;

    // 新しい tc を生成: cloneして colAddr=newColAddr, rowAddr=refRowAddr, span=1x1, テキストクリア
    let newTcXml = result.substring(anyCell.tcStart, anyCell.tcEnd);
    newTcXml = setCellColAddr(newTcXml, newColAddr);
    newTcXml = setCellRowAddr(newTcXml, refRowAddr);
    newTcXml = resetCellSpan(newTcXml);
    newTcXml = clearCellText(newTcXml);

    // 挿入位置決定: right=true → cloneSourceCellの前 (シフト後のcol+1セルの前 = 元colとcol+1の間)
    // right=false → シフト後のcol+1セルの前
    // 実際には: 新しいセルをnewColAddr位置に挿入
    // newColAddrのセルはシフト後なのでcol+1(right=true)またはcol+1(right=false)
    const refCell = r.cells.find((c) => c.colAddr === col + 1);
    let insertPos: number;
    if (refCell) {
      insertPos = refCell.tcStart;
    } else {
      // 末尾挿入
      const lastCell = r.cells[r.cells.length - 1];
      insertPos = lastCell ? lastCell.tcEnd : r.trEnd - "</hp:tr>".length;
    }

    result = result.substring(0, insertPos) + newTcXml + result.substring(insertPos);
  }

  // Step 3: colCnt 增加
  result = updateTblAttr(result, "colCnt", dims.colCnt + 1);

  return { ok: true, xml: result };
}

// ─────────────────────────────────────────────────────────
// deleteColumn
// ─────────────────────────────────────────────────────────

/**
 * 表 XML ブロックから列を削除する。
 */
export function deleteColumnInTbl(tblXml: string, col: number): TableOpResult {
  const tokens = tokenizeHwpxXml(tblXml);
  const rows = parseTableRows(tblXml, tokens, 0, tblXml.length);
  const dims = parseTblDimensions(tblXml, 0);

  if (rows.length === 0) {
    return { ok: false, error: "표에 행이 없습니다." };
  }

  // 병합 셀 충돌 검사
  for (const r of rows) {
    const cell = r.cells.find((c) => c.colAddr === col);
    if (cell && cell.colSpan > 1) {
      return {
        ok: false,
        error:
          `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
          `(열 ${col}의 셀 (행 ${cell.rowAddr})에 colSpan=${cell.colSpan} 병합이 있습니다). ` +
          `병합을 해제한 후 시도하세요.`,
      };
    }
    // 다른 열의 병합이 이 열을 걸치는지
    for (const c of r.cells) {
      if (c.colAddr !== col && c.colSpan > 1) {
        const spanEnd = c.colAddr + c.colSpan - 1;
        if (c.colAddr < col && col <= spanEnd) {
          return {
            ok: false,
            error:
              `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
              `(셀 (행 ${c.rowAddr}, 열 ${c.colAddr})의 colSpan=${c.colSpan}이 삭제할 열 ${col}을 포함합니다). ` +
              `병합을 해제한 후 시도하세요.`,
          };
        }
      }
    }
  }

  // Step 1: 각 행에서 col 셀 제거 (역순)
  let result = tblXml;
  const sortedRows = [...rows].sort((a, b) => b.trStart - a.trStart);
  // 각 행에서 colAddr===col인 tc를 역순으로 제거
  for (const r of sortedRows) {
    const cell = r.cells.find((c) => c.colAddr === col);
    if (cell) {
      result = result.substring(0, cell.tcStart) + result.substring(cell.tcEnd);
    }
  }

  // Step 2: colAddr > col のセルを -1 シフト
  const afterTokens = tokenizeHwpxXml(result);
  const addrPatches: Array<{ pos: number; end: number; newAddr: number }> = [];
  for (const tok of afterTokens) {
    if (tok.kind === "cell_addr" && tok.colAddr !== undefined && tok.colAddr > col) {
      addrPatches.push({ pos: tok.pos, end: tok.end, newAddr: tok.colAddr - 1 });
    }
  }
  addrPatches.sort((a, b) => b.pos - a.pos);
  for (const p of addrPatches) {
    const oldTag = result.substring(p.pos, p.end);
    const newTag = oldTag.replace(/(colAddr=")(\d+)(")/, `$1${p.newAddr}$3`);
    result = result.substring(0, p.pos) + newTag + result.substring(p.end);
  }

  // Step 3: colCnt 減少
  result = updateTblAttr(result, "colCnt", dims.colCnt - 1);

  return { ok: true, xml: result };
}

// ─────────────────────────────────────────────────────────
// mergeCells
// ─────────────────────────────────────────────────────────

/**
 * 表 XML ブロックでセルを結合する。
 * 左上セルのcellSpanを設定し、カバーされるセルを除去する。
 */
export function mergeCellsInTbl(
  tblXml: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): TableOpResult {
  if (startRow === endRow && startCol === endCol) {
    return { ok: false, error: "병합 범위가 단일 셀입니다. 최소 2개 이상의 셀을 지정하세요." };
  }
  if (startRow > endRow || startCol > endCol) {
    return { ok: false, error: "병합 범위가 잘못되었습니다 (start > end)." };
  }

  const tokens = tokenizeHwpxXml(tblXml);
  const rows = parseTableRows(tblXml, tokens, 0, tblXml.length);

  // 병합 범위 내 모든 셀 수집
  const rangeCells: CellMeta[] = [];
  for (const r of rows) {
    for (const c of r.cells) {
      if (
        c.rowAddr >= startRow &&
        c.rowAddr <= endRow &&
        c.colAddr >= startCol &&
        c.colAddr <= endCol
      ) {
        rangeCells.push(c);
      }
    }
  }

  if (rangeCells.length === 0) {
    return {
      ok: false,
      error: `병합 범위 (${startRow},${startCol})~(${endRow},${endCol})에 셀이 없습니다.`,
    };
  }

  // 기존 병합과의 충돌 검사: 범위 안에 이미 병합된 셀이 있으면 거부
  for (const c of rangeCells) {
    if (c.colSpan > 1 || c.rowSpan > 1) {
      return {
        ok: false,
        error:
          `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
          `(셀 (행 ${c.rowAddr}, 열 ${c.colAddr})이 이미 colSpan=${c.colSpan}, rowSpan=${c.rowSpan}으로 병합되어 있습니다). ` +
          `기존 병합을 해제한 후 시도하세요.`,
      };
    }
  }

  // 범위 밖에서 안을 걸치는 병합이 있는지도 확인
  for (const r of rows) {
    for (const c of r.cells) {
      if (c.colSpan <= 1 && c.rowSpan <= 1) continue;
      // 범위 안에 있는 셀은 위에서 이미 처리
      const inRange =
        c.rowAddr >= startRow &&
        c.rowAddr <= endRow &&
        c.colAddr >= startCol &&
        c.colAddr <= endCol;
      if (inRange) continue;
      // 범위 밖의 병합이 범위 안에 걸치는지
      const colEnd = c.colAddr + c.colSpan - 1;
      const rowEnd = c.rowAddr + c.rowSpan - 1;
      if (c.colAddr <= endCol && colEnd >= startCol && c.rowAddr <= endRow && rowEnd >= startRow) {
        return {
          ok: false,
          error:
            `이 표의 기존 병합 셀과 겹쳐 안전하게 처리할 수 없습니다 ` +
            `(셀 (행 ${c.rowAddr}, 열 ${c.colAddr})의 span이 병합 범위와 겹칩니다). ` +
            `기존 병합을 해제한 후 시도하세요.`,
        };
      }
    }
  }

  const colSpan = endCol - startCol + 1;
  const rowSpan = endRow - startRow + 1;

  // 좌상단 셀 (startRow, startCol) 찾기
  const topLeftCell = rangeCells.find((c) => c.rowAddr === startRow && c.colAddr === startCol);
  if (!topLeftCell) {
    return {
      ok: false,
      error: `병합 범위의 좌상단 셀 (행 ${startRow}, 열 ${startCol})이 없습니다.`,
    };
  }

  // 제거할 셀 (좌상단 제외)
  const cellsToRemove = rangeCells.filter(
    (c) => !(c.rowAddr === startRow && c.colAddr === startCol),
  );

  // 역순으로 제거 (오프셋 보전)
  let result = tblXml;
  const sortedRemove = [...cellsToRemove].sort((a, b) => b.tcStart - a.tcStart);
  for (const c of sortedRemove) {
    result = result.substring(0, c.tcStart) + result.substring(c.tcEnd);
  }

  // 좌상단 셀의 cellSpan 업데이트
  // 제거 후 인덱스が変わる可能性があるので再検索
  const afterTokens = tokenizeHwpxXml(result);
  const afterRows = parseTableRows(result, afterTokens, 0, result.length);
  const afterTopLeft = afterRows
    .flatMap((r) => r.cells)
    .find((c) => c.rowAddr === startRow && c.colAddr === startCol);

  if (!afterTopLeft) {
    return { ok: false, error: "병합 후 좌상단 셀을 찾을 수 없습니다 (내부 오류)." };
  }

  let tcXml = result.substring(afterTopLeft.tcStart, afterTopLeft.tcEnd);
  tcXml = setCellSpan(tcXml, colSpan, rowSpan);
  result = result.substring(0, afterTopLeft.tcStart) + tcXml + result.substring(afterTopLeft.tcEnd);

  return { ok: true, xml: result };
}

// ─────────────────────────────────────────────────────────
// 섹션 XML 내 표 찾기 (anchor 기반)
// ─────────────────────────────────────────────────────────

/**
 * 섹션 XML에서 anchor를 포함한 최상위 표의 범위를 반환한다.
 * 0개 → 오류, 2개 이상 → 모호함 오류.
 */
function findTableByAnchorInXml(
  xml: string,
  anchor: string,
): { range: TableRange; sectionXml: string } | { error: string } {
  const tokens = tokenizeHwpxXml(xml);
  const allRanges = findAllTopLevelTableRanges(tokens);
  const trimmedAnchor = anchor.trim();

  const matched: TableRange[] = [];
  for (const r of allRanges) {
    const text = collectTableText(xml, tokens, r.start, r.end);
    if (text.includes(trimmedAnchor)) {
      matched.push(r);
    }
  }

  if (matched.length === 0) {
    return {
      error:
        `anchor를 포함한 표를 찾지 못했습니다: "${anchor}". ` +
        `read_document로 표 내용을 확인하고 표 안에 있는 독특한 텍스트를 anchor로 지정하세요.`,
    };
  }

  if (matched.length > 1) {
    return {
      error:
        `anchor "${anchor}"이(가) ${matched.length}개의 표에서 발견되었습니다. ` +
        `더 구체적인 anchor 텍스트를 사용하여 표를 한 개만 선택할 수 있도록 하세요.`,
    };
  }

  return { range: matched[0] as TableRange, sectionXml: xml };
}

// ─────────────────────────────────────────────────────────
// 연산 적용 + ZIP 처리
// ─────────────────────────────────────────────────────────

/**
 * 연산 목록에서 예상 행·열 수의 순증감을 계산한다.
 * mergeCells 연산이 포함되면 null 반환 (행·열 수 변화 없음, 치수 검증 불가).
 */
export function computeExpectedDelta(
  ops: TableStructureOperation[],
): { rowDelta: number; colDelta: number } | null {
  let rowDelta = 0;
  let colDelta = 0;
  for (const op of ops) {
    if (op.type === "mergeCells") return null;
    if (op.type === "insertRow") rowDelta++;
    else if (op.type === "deleteRow") rowDelta--;
    else if (op.type === "insertColumn") colDelta++;
    else if (op.type === "deleteColumn") colDelta--;
  }
  return { rowDelta, colDelta };
}

/**
 * <hp:tbl> 블록에서 현재 rowCnt와 colCnt를 읽는다.
 */
function getTblDims(tblXml: string): { rowCnt: number; colCnt: number } {
  return parseTblDimensions(tblXml, 0);
}

/**
 * .hwpx ZIP 버퍼에서 anchor 표에 연산을 적용하고 새 ZIP 버퍼를 반환한다.
 */
async function applyOpsToHwpx(
  hwpxBuffer: Uint8Array,
  anchor: string,
  operations: TableStructureOperation[],
): Promise<
  | {
      ok: true;
      buffer: Uint8Array;
      beforeDims: { rowCnt: number; colCnt: number };
      afterDims: { rowCnt: number; colCnt: number };
      anchorTableIndex: number;
    }
  | { ok: false; error: string }
> {
  const zip = await JSZip.loadAsync(hwpxBuffer);

  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort();

  // anchor 표 탐색
  let targetSectionIdx = -1;
  let targetRange: TableRange | null = null;
  const sectionXmls: string[] = [];

  for (let si = 0; si < sectionFiles.length; si++) {
    const entry = zip.file(sectionFiles[si] ?? "");
    const xml = entry ? await entry.async("string") : "";
    sectionXmls.push(xml);

    if (targetSectionIdx === -1) {
      const found = findTableByAnchorInXml(xml, anchor);
      if ("range" in found) {
        targetSectionIdx = si;
        targetRange = found.range;
      } else if (found.error.includes("이(가)") && found.error.includes("개의 표에서")) {
        // 모호함 오류 → 즉시 반환
        return { ok: false, error: `오류: ${found.error}` };
      }
    }
  }

  // 나머지 섹션 로드
  for (let si = sectionXmls.length; si < sectionFiles.length; si++) {
    const entry = zip.file(sectionFiles[si] ?? "");
    const xml = entry ? await entry.async("string") : "";
    sectionXmls.push(xml);
  }

  if (targetSectionIdx === -1 || targetRange === null) {
    // 전체 섹션에서 못 찾음
    return {
      ok: false,
      error:
        `오류: anchor를 포함한 표를 찾지 못했습니다: "${anchor}". ` +
        `read_document로 표 내용을 확인하고 표 안에 있는 독특한 텍스트를 anchor로 지정하세요.`,
    };
  }

  const sectionXml = sectionXmls[targetSectionIdx] ?? "";
  let tblBlock = sectionXml.substring(targetRange.start, targetRange.end);
  const beforeDims = getTblDims(tblBlock);

  // 연산 순서대로 적용
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op) continue;

    let opResult: TableOpResult;
    if (op.type === "insertRow") {
      opResult = insertRowInTbl(tblBlock, op.row, op.position === "below");
    } else if (op.type === "deleteRow") {
      opResult = deleteRowInTbl(tblBlock, op.row);
    } else if (op.type === "insertColumn") {
      opResult = insertColumnInTbl(tblBlock, op.col, op.position === "right");
    } else if (op.type === "deleteColumn") {
      opResult = deleteColumnInTbl(tblBlock, op.col);
    } else {
      // mergeCells
      opResult = mergeCellsInTbl(tblBlock, op.startRow, op.startCol, op.endRow, op.endCol);
    }

    if (!opResult.ok) {
      return {
        ok: false,
        error:
          `오류: 연산 #${i + 1} (${op.type}) 실패. 파일을 변경하지 않았습니다. ` +
          `원인: ${opResult.error}`,
      };
    }

    tblBlock = opResult.xml;
  }

  const afterDims = getTblDims(tblBlock);

  // 섹션 XML에 표 블록 반영
  const newSectionXml =
    sectionXml.substring(0, targetRange.start) + tblBlock + sectionXml.substring(targetRange.end);

  sectionXmls[targetSectionIdx] = newSectionXml;

  // 새 ZIP 생성 (mimetype STORE 첫 번째)
  const out = new JSZip();
  const mimetypeEntry = zip.file("mimetype");
  if (mimetypeEntry) {
    out.file("mimetype", await mimetypeEntry.async("uint8array"), { compression: "STORE" });
  }

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "mimetype" || entry.dir) continue;
    const sectionIdx = sectionFiles.indexOf(name);
    if (sectionIdx >= 0) {
      out.file(name, sectionXmls[sectionIdx] ?? "");
    } else {
      out.file(name, await entry.async("uint8array"));
    }
  }

  const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    ok: true,
    buffer: new Uint8Array(buf as unknown as ArrayBuffer),
    beforeDims,
    afterDims,
    anchorTableIndex: targetRange.index,
  };
}

// ─────────────────────────────────────────────────────────
// 자기검증: 결과 표 치수 확인
// ─────────────────────────────────────────────────────────

/**
 * 새 ZIP에서 anchor 표의 치수를 읽어 기대값과 비교한다.
 * kordoc parse() 성공 + 블록 히스토그램 비교 포함.
 */
async function verifyOutputDims(
  newBytes: Uint8Array,
  anchor: string,
  expectedRowCnt: number,
  expectedColCnt: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const zip = await JSZip.loadAsync(newBytes);
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort();

  for (const sf of sectionFiles) {
    const entry = zip.file(sf);
    const xml = entry ? await entry.async("string") : "";
    const tokens = tokenizeHwpxXml(xml);
    const allRanges = findAllTopLevelTableRanges(tokens);
    const trimmedAnchor = anchor.trim();

    for (const r of allRanges) {
      const text = collectTableText(xml, tokens, r.start, r.end);
      if (text.includes(trimmedAnchor)) {
        const tblBlock = xml.substring(r.start, r.end);
        const dims = getTblDims(tblBlock);
        if (dims.rowCnt !== expectedRowCnt || dims.colCnt !== expectedColCnt) {
          return {
            ok: false,
            error:
              `자기검증 실패 — 예상 치수 (${expectedRowCnt}행 × ${expectedColCnt}열)와 ` +
              `실제 치수 (${dims.rowCnt}행 × ${dims.colCnt}열)가 다릅니다.`,
          };
        }
        return { ok: true };
      }
    }
  }

  // anchor를 찾지 못했으나 deleteRow/deleteColumn이 원인일 수 있음 → 오류 안 냄
  return { ok: true };
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const proposeTableStructureTool: ToolDefinition<ProposeTableStructureInput> = {
  name: "propose_table_structure",
  description:
    "HWPX 문서에서 anchor 텍스트로 식별된 표의 구조(행/열/셀 병합)를 수정합니다. " +
    "ZIP XML 직접 패치 방식으로 동작합니다(rhwp 미사용). " +
    "이미지·중첩표 등 복잡한 문서도 구조 손실 없이 안전하게 편집 가능합니다. " +
    "anchor는 대상 표 안에만 있는 독특한 셀 텍스트를 지정하세요 — " +
    "먼저 read_document로 문서를 읽어 표 내용을 확인하세요. " +
    "연산은 지정된 순서대로 적용되며, 나중 연산의 row/col 인덱스는 " +
    "앞 연산 적용 후의 표 상태를 기준으로 합니다. " +
    ".hwpx 전용입니다 (.hwp는 지원하지 않으며, Hancom에서 .hwpx로 저장 후 사용하세요). " +
    "기존 병합 셀과 교차하는 연산은 안전을 위해 거부될 수 있습니다. " +
    "변경 사항은 자기검증 게이트를 통과한 후 사용자 승인을 받아야만 저장됩니다.",
  inputSchema: proposeTableStructureSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeTableStructureInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // .hwpx 전용
    if (ext === ".hwp") {
      return (
        "오류: propose_table_structure는 .hwpx 파일만 지원합니다. " +
        ".hwp(구형 OLE 바이너리)는 XML 직접 편집이 불가합니다. " +
        "한글 프로그램에서 '다른 이름으로 저장 → .hwpx'로 저장한 후 다시 시도하세요."
      );
    }
    if (ext !== ".hwpx") {
      return (
        `오류: propose_table_structure는 .hwpx 파일만 지원합니다. 현재 파일 확장자: ${ext}. ` +
        ".hwpx 파일을 지정하세요."
      );
    }

    // 파일 읽기
    let originalBuf: Buffer;
    try {
      originalBuf = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }

    // ZIP 매직 바이트 검증 (PK = 0x504B)
    if (originalBuf[0] !== 0x50 || originalBuf[1] !== 0x4b) {
      return (
        "오류: 파일이 유효한 .hwpx(ZIP) 포맷이 아닙니다. " +
        "파일이 손상되었거나 구형 .hwp(OLE 바이너리) 포맷입니다. " +
        "한글 프로그램에서 .hwpx로 저장 후 다시 시도하세요."
      );
    }

    const originalBytes = new Uint8Array(
      originalBuf.buffer,
      originalBuf.byteOffset,
      originalBuf.byteLength,
    );

    // 원본 kordoc parse (구조 손실 게이트용)
    let originalBlocks: import("kordoc").IRBlock[] | null = null;
    try {
      const origResult = await parse(originalBuf.buffer as ArrayBuffer);
      if (origResult.success) {
        originalBlocks = origResult.blocks;
      }
    } catch {
      // parse 실패 → 게이트 스킵
    }

    // XML 직접 패치로 연산 적용
    let applyResult: Awaited<ReturnType<typeof applyOpsToHwpx>>;
    try {
      applyResult = await applyOpsToHwpx(originalBytes, input.anchor, input.operations);
    } catch (e) {
      return `오류: 표 구조 편집 중 예외가 발생했습니다. ${String(e)}`;
    }

    if (!applyResult.ok) {
      return applyResult.error;
    }

    const { buffer: newBytes, beforeDims, afterDims } = applyResult;
    const warnings: string[] = [];

    // ── 자기검증 게이트 ──────────────────────────────────

    // (1) kordoc parse()로 재파싱 성공 + anchor 텍스트 존재 확인
    let exportedMd = "";
    let kordocOk = false;
    let exportedBlocks: import("kordoc").IRBlock[] | null = null;
    try {
      const exportedResult = await parse(newBytes.buffer as ArrayBuffer);
      if (exportedResult.success) {
        exportedMd = exportedResult.markdown;
        exportedBlocks = exportedResult.blocks;
        kordocOk = true;
      }
    } catch {
      // 파싱 실패 → 아래서 처리
    }

    if (!kordocOk) {
      return (
        `오류: 내보낸 문서를 kordoc으로 재파싱하지 못했습니다. ` +
        `문서가 손상되었을 수 있으므로 파일을 저장하지 않았습니다.`
      );
    }

    // (2) 구조 손실 게이트
    if (originalBlocks !== null && exportedBlocks !== null) {
      const lossResult = detectStructuralLoss(originalBlocks, exportedBlocks);
      if (lossResult.lost) {
        return (
          `오류: XML 편집 후 구조 손실이 감지되었습니다(${lossResult.detail}). ` +
          `XML 패치에 버그가 있을 수 있습니다. 파일을 저장하지 않았습니다.`
        );
      }
    }

    // (3) anchor 텍스트 존재 확인
    const hasDeleteOp = input.operations.some(
      (op) => op.type === "deleteRow" || op.type === "deleteColumn",
    );
    const anchorInExported = exportedMd.includes(input.anchor.trim());
    if (!anchorInExported) {
      if (!hasDeleteOp) {
        return (
          `오류: 자기검증 실패 — 내보낸 문서에서 anchor "${input.anchor}"를 찾을 수 없습니다. ` +
          `표 구조가 손상되었을 수 있으므로 파일을 저장하지 않았습니다.`
        );
      }
      warnings.push(
        `자기검증: 내보낸 문서에서 anchor "${input.anchor}"가 보이지 않습니다. ` +
          `삭제 연산으로 anchor가 포함된 행/열이 제거되었을 수 있습니다. 결과를 직접 확인하세요.`,
      );
    }

    // (4) 예상 치수 검증 (병합 없는 연산만)
    const delta = computeExpectedDelta(input.operations);
    if (delta !== null) {
      const expectedRowCnt = beforeDims.rowCnt + delta.rowDelta;
      const expectedColCnt = beforeDims.colCnt + delta.colDelta;

      if (afterDims.rowCnt !== expectedRowCnt || afterDims.colCnt !== expectedColCnt) {
        return (
          `오류: 자기검증 실패 — 예상 치수 (${expectedRowCnt}행 × ${expectedColCnt}열)와 ` +
          `실제 치수 (${afterDims.rowCnt}행 × ${afterDims.colCnt}열)가 다릅니다. ` +
          `파일을 저장하지 않았습니다.`
        );
      }

      // ZIP 재파싱으로 치수 재확인 (anchor가 살아있는 경우만)
      if (anchorInExported) {
        const dimVerify = await verifyOutputDims(
          newBytes,
          input.anchor,
          expectedRowCnt,
          expectedColCnt,
        );
        if (!dimVerify.ok) {
          return `오류: ${dimVerify.error} 파일을 저장하지 않았습니다.`;
        }
      }
    }
    // ── 게이트 종료 ────────────────────────────────────────

    // 출력 경로 결정
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);

    // diff 텍스트 생성
    const opDescriptions = input.operations.map((op, i) => {
      if (op.type === "insertRow")
        return `  ${i + 1}. 행 ${op.row} ${op.position === "below" ? "아래" : "위"}에 행 삽입`;
      if (op.type === "deleteRow") return `  ${i + 1}. 행 ${op.row} 삭제`;
      if (op.type === "insertColumn")
        return `  ${i + 1}. 열 ${op.col} ${op.position === "right" ? "오른쪽" : "왼쪽"}에 열 삽입`;
      if (op.type === "deleteColumn") return `  ${i + 1}. 열 ${op.col} 삭제`;
      return `  ${i + 1}. (${op.startRow},${op.startCol})~(${op.endRow},${op.endCol}) 셀 병합`;
    });

    const diff =
      `anchor: "${input.anchor}" (표 인덱스 ${applyResult.anchorTableIndex})\n` +
      `이전: ${beforeDims.rowCnt}행 × ${beforeDims.colCnt}열\n` +
      `이후: ${afterDims.rowCnt}행 × ${afterDims.colCnt}열\n` +
      `연산 (${input.operations.length}개):\n${opDescriptions.join("\n")}`;

    // 스테이징
    const stagedPath = await stageFile(ctx.sessionId, outputPath, newBytes);
    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "table-structure",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings,
        willConvertFormat,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(safePath);
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
