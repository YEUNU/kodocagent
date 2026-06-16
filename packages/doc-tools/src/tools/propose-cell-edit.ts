/**
 * propose_cell_edit 툴 — HWPX 표 셀 직접 XML 패치
 * docs/SPEC.md §6, §7
 *
 * 기존 propose_edit/propose_form_fill은 kordoc markdownToHwpx를 통해
 * 마크다운 라운드트립을 하기 때문에 병합 셀(cellSpan)이 소실된다.
 * 이 툴은 .hwpx ZIP 안의 section XML을 직접 수정하여 merges를 보존한다.
 *
 * tableIndex 순서 정책:
 *   - kordoc parse().blocks의 table 블록 순서와 일치 (0-based)
 *   - 즉, XML 소스 순서의 최상위 <hp:tbl>만 카운팅 (중첩된 <hp:tbl>는 제외)
 *   - 이 순서는 kordoc이 read_document로 반환하는 순서와 동일하므로
 *     에이전트가 read_document로 확인한 tableIndex를 그대로 사용할 수 있다
 *   - 실증: table-vpos-01.hwpx — XML에 <hp:tbl> 11개, 그 중 1개가 중첩.
 *     kordoc은 10개를 반환하며, 순서는 XML 소스 순서에서 중첩을 제외한 것과 동일.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

export const cellEditItemSchema = z.object({
  tableIndex: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "0-based 표 인덱스. read_document로 읽은 kordoc 블록 순서와 동일 (중첩 표는 별도 카운팅 안 함)",
    ),
  row: z
    .number()
    .int()
    .nonnegative()
    .describe("셀의 rowAddr (0-based, <hp:cellAddr rowAddr=..> 값)"),
  col: z
    .number()
    .int()
    .nonnegative()
    .describe("셀의 colAddr (0-based, <hp:cellAddr colAddr=..> 값)"),
  newText: z.string().describe("셀에 쓸 새 텍스트"),
  expectedText: z
    .string()
    .optional()
    .describe(
      "현재 셀 텍스트 (안전 검증용). 제공 시 현재 셀 텍스트와 일치하지 않으면 수정하지 않음. " +
        "잘못된 셀 수정을 방지하려면 반드시 사용하세요.",
    ),
});

export const proposeCellEditSchema = z.object({
  path: z.string().describe("수정할 .hwpx 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  edits: z
    .array(cellEditItemSchema)
    .min(1)
    .describe("편집 목록. 각 항목은 표 인덱스·행·열·새 텍스트로 구성"),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type CellEditItem = z.infer<typeof cellEditItemSchema>;
export type ProposeCellEditInput = z.infer<typeof proposeCellEditSchema>;

// ─────────────────────────────────────────────────────────
// 순수 XML 편집 함수 (단위 테스트 가능)
// ─────────────────────────────────────────────────────────

/**
 * XML 토크나이저 — <hp:tbl>, </hp:tbl>, <hp:tc>, </hp:tc>, <hp:t>, </hp:t>
 * 등의 태그 위치를 선형으로 스캔한다.
 */
type TokenKind = "tbl_open" | "tbl_close" | "tc_open" | "tc_close" | "t_open" | "cell_addr";

interface XmlToken {
  kind: TokenKind;
  pos: number; // 태그 시작 위치
  end: number; // 태그 끝 위치 (exclusive)
  colAddr?: number; // cellAddr 전용
  rowAddr?: number;
}

/**
 * XML 문자열에서 관련 토큰을 순서대로 추출한다.
 * 정규식은 단순 태그 감지용 — 중첩 구조는 스택으로 처리한다.
 */
function tokenizeHwpxXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const re = /<hp:tbl[\s>]|<\/hp:tbl>|<hp:tc[\s>]|<\/hp:tc>|<hp:t>|<hp:cellAddr[^/]*/g;
  let startPos = 0;
  let m = re.exec(xml);
  while (m !== null) {
    const raw = m[0];
    const pos = m.index;
    if (raw.startsWith("<hp:tbl")) {
      tokens.push({ kind: "tbl_open", pos, end: pos + raw.length });
    } else if (raw === "</hp:tbl>") {
      tokens.push({ kind: "tbl_close", pos, end: pos + raw.length });
    } else if (raw.startsWith("<hp:tc")) {
      tokens.push({ kind: "tc_open", pos, end: pos + raw.length });
    } else if (raw === "</hp:tc>") {
      tokens.push({ kind: "tc_close", pos, end: pos + raw.length });
    } else if (raw === "<hp:t>") {
      tokens.push({ kind: "t_open", pos, end: pos + raw.length });
    } else if (raw.startsWith("<hp:cellAddr")) {
      // <hp:cellAddr colAddr="3" rowAddr="2"/>
      const colM = raw.match(/colAddr="(\d+)"/);
      const rowM = raw.match(/rowAddr="(\d+)"/);
      if (colM && rowM) {
        // cellAddr는 self-closing이므로 /> 위치를 end로
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
    }
    startPos = re.lastIndex;
    m = re.exec(xml);
  }
  // suppress unused warning for startPos — it's harmless bookkeeping
  void startPos;
  return tokens;
}

/**
 * XML 특수문자를 이스케이프한다.
 */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface TcRange {
  start: number;
  end: number;
  /** targetTbl 기준 내부 tbl 깊이 (0 = 직접 자식) */
  depth: number;
}

/**
 * 특정 표의 직접 자식 tc 범위 목록을 반환한다 (중첩 표의 tc 제외).
 *
 * tblStart는 해당 표의 <hp:tbl> 오프닝 태그 위치이다.
 * 이 함수는 타겟 표 자체의 tbl_open을 내부 중첩 깊이 카운터에 포함하지 않아야 한다.
 * 따라서 tblStart 이후의 토큰만 처리하되 tblEnd 미만만 포함하며,
 * innerDepth는 tblStart 직후부터 카운팅 시작 (타겟 표 자체는 이미 열려있음).
 */
function collectDirectTcRanges(tokens: XmlToken[], tblStart: number, tblEnd: number): TcRange[] {
  // tblStart 위치의 tbl_open 태그는 "이미 열려있는" 타겟 표이므로 건너뜀
  // innerDepth=0: 타겟 표 직속, 1: 첫 번째 중첩 표, ...
  const tblTokens = tokens.filter((t) => t.pos > tblStart && t.pos < tblEnd);
  const tcRanges: TcRange[] = [];
  const tcStack: Array<{ pos: number; depth: number }> = [];
  let innerDepth = 0;

  for (const tok of tblTokens) {
    if (tok.kind === "tbl_open") {
      innerDepth++;
    } else if (tok.kind === "tbl_close") {
      innerDepth--;
    } else if (tok.kind === "tc_open") {
      tcStack.push({ pos: tok.pos, depth: innerDepth });
    } else if (tok.kind === "tc_close") {
      const entry = tcStack.pop();
      if (entry !== undefined) {
        tcRanges.push({ start: entry.pos, end: tok.end, depth: entry.depth });
      }
    }
  }

  return tcRanges.filter((tc) => tc.depth === 0);
}

/**
 * 특정 tc 안에서 직접 <hp:t> 런의 텍스트를 읽는다 (중첩 표의 t는 제외).
 * 반환값은 XML 엔티티 디코딩 완료.
 */
function readOwnTextFromTc(
  xml: string,
  tokens: XmlToken[],
  tcStart: number,
  tcEnd: number,
): string {
  const tcTokens = tokens.filter((t) => t.pos >= tcStart && t.pos < tcEnd);
  let innerDepth = 0;
  let text = "";
  for (const t of tcTokens) {
    if (t.kind === "tbl_open") innerDepth++;
    else if (t.kind === "tbl_close") innerDepth--;
    else if (t.kind === "t_open" && innerDepth === 0) {
      const closePos = xml.indexOf("</hp:t>", t.end);
      if (closePos >= 0) {
        text += xml.substring(t.end, closePos);
      }
    }
  }
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * 최상위 표의 범위(start, end)를 반환한다.
 * tableIndex: 0-based, kordoc 순서와 동일 (중첩 표는 별도 카운팅 안 함).
 */
function findTopLevelTableRange(
  tokens: XmlToken[],
  tableIndex: number,
): { start: number; end: number } | null {
  let topLevelCount = 0;
  let depth = 0;
  let targetStart = -1;

  for (const tok of tokens) {
    if (tok.kind === "tbl_open") {
      if (depth === 0) {
        if (topLevelCount === tableIndex) {
          targetStart = tok.pos;
        }
        topLevelCount++;
      }
      depth++;
    } else if (tok.kind === "tbl_close") {
      depth--;
      if (depth === 0 && topLevelCount === tableIndex + 1 && targetStart >= 0) {
        return { start: targetStart, end: tok.end };
      }
    }
  }
  return null;
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
  const tokens = tokenizeHwpxXml(xml);
  const tblRange = findTopLevelTableRange(tokens, tableIndex);
  if (!tblRange) return null;

  const directTcs = collectDirectTcRanges(tokens, tblRange.start, tblRange.end);
  const tblTokens = tokens.filter((t) => t.pos >= tblRange.start && t.pos < tblRange.end);

  for (const tc of directTcs) {
    const tcTokens = tblTokens.filter((t) => t.pos >= tc.start && t.pos < tc.end);
    const hasAddr = tcTokens.some(
      (t) => t.kind === "cell_addr" && t.colAddr === col && t.rowAddr === row,
    );
    if (!hasAddr) continue;
    return readOwnTextFromTc(xml, tokens, tc.start, tc.end);
  }
  return null;
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
  const tokens = tokenizeHwpxXml(xml);
  const results: CellEditResult[] = edits.map(() => ({ success: false }));

  // 최상위 표 수 계산 (오류 메시지용)
  let totalTopLevelTbls = 0;
  {
    let d = 0;
    for (const tok of tokens) {
      if (tok.kind === "tbl_open") {
        if (d === 0) totalTopLevelTbls++;
        d++;
      } else if (tok.kind === "tbl_close") {
        d--;
      }
    }
  }

  interface Replacement {
    editIdx: number;
    patches: Array<{ from: number; to: number; text: string }>;
  }
  const replacements: Replacement[] = [];

  for (let ei = 0; ei < edits.length; ei++) {
    const edit = edits[ei] as CellEditRequest; // noUncheckedIndexedAccess: length guard
    const tblRange = findTopLevelTableRange(tokens, edit.tableIndex);
    if (!tblRange) {
      results[ei] = {
        success: false,
        error: `표 ${edit.tableIndex}를 찾을 수 없습니다. 이 섹션에 총 ${totalTopLevelTbls}개의 최상위 표가 있습니다.`,
      };
      continue;
    }

    const directTcs = collectDirectTcRanges(tokens, tblRange.start, tblRange.end);
    const tblTokens = tokens.filter((t) => t.pos >= tblRange.start && t.pos < tblRange.end);

    let found = false;
    for (const tc of directTcs) {
      const tcTokens = tblTokens.filter((t) => t.pos >= tc.start && t.pos < tc.end);
      const hasAddr = tcTokens.some(
        (t) => t.kind === "cell_addr" && t.colAddr === edit.col && t.rowAddr === edit.row,
      );
      if (!hasAddr) continue;

      // 직접 <hp:t> 런 수집 (중첩 표 안의 t는 제외)
      let innerDepth = 0;
      const ownTRuns: Array<{ openEnd: number; closePos: number }> = [];
      for (const t of tokens.filter((x) => x.pos >= tc.start && x.pos < tc.end)) {
        if (t.kind === "tbl_open") innerDepth++;
        else if (t.kind === "tbl_close") innerDepth--;
        else if (t.kind === "t_open" && innerDepth === 0) {
          const closePos = xml.indexOf("</hp:t>", t.end);
          if (closePos >= 0) {
            ownTRuns.push({ openEnd: t.end, closePos });
          }
        }
      }

      // 현재 텍스트
      const currentText = ownTRuns
        .map((r) => xml.substring(r.openEnd, r.closePos))
        .join("")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");

      // expectedText 검증
      if (edit.expectedText !== undefined && edit.expectedText !== currentText) {
        results[ei] = {
          success: false,
          oldText: currentText,
          error:
            `셀 (표 ${edit.tableIndex}, 행 ${edit.row}, 열 ${edit.col})의 현재 텍스트가 예상값과 다릅니다. ` +
            `예상: "${edit.expectedText}", 실제: "${currentText}". 수정하지 않습니다.`,
        };
        found = true;
        break;
      }

      if (ownTRuns.length === 0) {
        results[ei] = {
          success: false,
          oldText: currentText,
          error: `셀 (표 ${edit.tableIndex}, 행 ${edit.row}, 열 ${edit.col})에 <hp:t> 런이 없습니다.`,
        };
        found = true;
        break;
      }

      // 패치 생성
      const escapedNew = escapeXml(edit.newText);
      const patches: Array<{ from: number; to: number; text: string }> = [];

      // 첫 번째 <hp:t>에 새 텍스트 삽입
      const firstRun = ownTRuns[0] as { openEnd: number; closePos: number };
      patches.push({ from: firstRun.openEnd, to: firstRun.closePos, text: escapedNew });

      // 나머지 <hp:t>는 빈 문자열로 (combined text == newText)
      for (let ri = 1; ri < ownTRuns.length; ri++) {
        const run = ownTRuns[ri] as { openEnd: number; closePos: number };
        patches.push({ from: run.openEnd, to: run.closePos, text: "" });
      }

      replacements.push({ editIdx: ei, patches });
      results[ei] = { success: true, oldText: currentText };
      found = true;
      break;
    }

    if (!found) {
      results[ei] = {
        success: false,
        error:
          `표 ${edit.tableIndex}에서 셀 (행 ${edit.row}, 열 ${edit.col})을 찾을 수 없습니다. ` +
          `cellAddr colAddr="${edit.col}" rowAddr="${edit.row}"에 해당하는 셀이 없습니다.`,
      };
    }
  }

  // 실패한 편집이 있으면 XML 무변경
  if (results.some((r) => !r.success)) {
    return { newXml: xml, results };
  }

  // 모든 패치를 뒤에서 앞으로 적용 (오프셋 보정)
  const allPatches = replacements.flatMap((r) => r.patches).sort((a, b) => b.from - a.from);

  let result = xml;
  for (const patch of allPatches) {
    result = result.substring(0, patch.from) + patch.text + result.substring(patch.to);
  }

  return { newXml: result, results };
}

// ─────────────────────────────────────────────────────────
// ZIP 처리
// ─────────────────────────────────────────────────────────

/**
 * .hwpx 파일의 모든 섹션 XML에서 편집을 적용하고 새 ZIP 버퍼를 반환한다.
 * tableIndex는 전체 섹션에 걸쳐 연속적이다 (section0 → section1 → …).
 */
async function applyEditsToHwpx(
  hwpxBuffer: Uint8Array,
  edits: CellEditRequest[],
): Promise<{ buffer: Uint8Array; results: CellEditResult[] }> {
  const zip = await JSZip.loadAsync(hwpxBuffer);

  // 섹션 파일 목록 수집 (section0, section1, …)
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort();

  // 각 섹션 XML 읽기 및 최상위 표 수 계산
  const sectionXmls: string[] = [];
  const sectionTblCounts: number[] = [];

  for (const sf of sectionFiles) {
    const entry = zip.file(sf);
    const xml = entry ? await entry.async("string") : "";
    sectionXmls.push(xml);

    const tokens = tokenizeHwpxXml(xml);
    let count = 0;
    let depth = 0;
    for (const tok of tokens) {
      if (tok.kind === "tbl_open") {
        if (depth === 0) count++;
        depth++;
      } else if (tok.kind === "tbl_close") {
        depth--;
      }
    }
    sectionTblCounts.push(count);
  }

  // 섹션별 편집 분배
  interface SectionEdit extends CellEditRequest {
    originalEditIdx: number;
  }
  const sectionEdits: SectionEdit[][] = sectionFiles.map(() => []);

  let offset = 0;
  for (let si = 0; si < sectionFiles.length; si++) {
    const count = sectionTblCounts[si] ?? 0;
    for (let ei = 0; ei < edits.length; ei++) {
      const edit = edits[ei] as CellEditRequest;
      if (edit.tableIndex >= offset && edit.tableIndex < offset + count) {
        const secEdits = sectionEdits[si];
        if (secEdits) {
          secEdits.push({
            tableIndex: edit.tableIndex - offset, // 섹션 내 상대 인덱스
            row: edit.row,
            col: edit.col,
            newText: edit.newText,
            expectedText: edit.expectedText,
            originalEditIdx: ei,
          });
        }
      }
    }
    offset += count;
  }

  // 전체 편집 결과 초기화
  const totalTables = sectionTblCounts.reduce((a, b) => a + b, 0);
  const allResults: CellEditResult[] = edits.map((edit, ei) => ({
    success: false,
    error: `표 ${edit?.tableIndex ?? ei}를 찾을 수 없습니다. 문서에 총 ${totalTables}개의 최상위 표가 있습니다.`,
  }));

  // 각 섹션에 편집 적용
  const newSectionXmls = [...sectionXmls];
  for (let si = 0; si < sectionFiles.length; si++) {
    const sEdits = sectionEdits[si] ?? [];
    if (sEdits.length === 0) continue;
    const srcXml = sectionXmls[si] ?? "";

    const { newXml, results } = applyCellEditsToSectionXml(srcXml, sEdits);
    newSectionXmls[si] = newXml;

    for (let i = 0; i < sEdits.length; i++) {
      const sEdit = sEdits[i];
      const res = results[i];
      if (sEdit && res) {
        allResults[sEdit.originalEditIdx] = res;
      }
    }
  }

  // 실패가 있으면 ZIP 생성 안 함
  if (allResults.some((r) => !r.success)) {
    return { buffer: hwpxBuffer, results: allResults };
  }

  // 새 ZIP 생성 (mimetype은 STORE로 첫 번째)
  const out = new JSZip();
  const mimetypeEntry = zip.file("mimetype");
  if (mimetypeEntry) {
    out.file("mimetype", await mimetypeEntry.async("uint8array"), { compression: "STORE" });
  }

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "mimetype" || entry.dir) continue;
    const sectionIdx = sectionFiles.indexOf(name);
    if (sectionIdx >= 0) {
      out.file(name, newSectionXmls[sectionIdx] ?? "");
    } else {
      out.file(name, await entry.async("uint8array"));
    }
  }

  const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return { buffer: new Uint8Array(buf as unknown as ArrayBuffer), results: allResults };
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const proposeCellEditTool: ToolDefinition<ProposeCellEditInput> = {
  name: "propose_cell_edit",
  description:
    "HWPX 문서의 표 셀 내용을 XML 직접 패치 방식으로 수정합니다. " +
    "병합 셀(cellSpan/rowSpan)이 있는 표에서도 병합 구조를 완전히 보존합니다. " +
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

    // .hwpx 전용 검증
    if (ext === ".hwp") {
      return (
        "오류: propose_cell_edit은 .hwpx 파일만 지원합니다. " +
        ".hwp(구형 OLE 바이너리)는 직접 편집이 불가합니다. " +
        "한글 프로그램에서 '다른 이름으로 저장 → .hwpx'로 저장한 후 다시 시도하세요. " +
        "또는 propose_edit을 사용할 수 있으나, 병합 셀이 소실될 수 있습니다."
      );
    }
    if (ext !== ".hwpx") {
      return (
        `오류: propose_cell_edit은 .hwpx 파일만 지원합니다. 현재 파일: ${ext}. ` +
        "표 셀 직접 편집은 .hwpx 포맷에서만 가능합니다."
      );
    }

    // 파일 읽기
    let originalBuffer: Buffer;
    try {
      originalBuffer = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하거나 read_document로 먼저 확인하세요.`;
    }

    // ZIP 매직 바이트 검증 (PK = 0x504B)
    if (originalBuffer[0] !== 0x50 || originalBuffer[1] !== 0x4b) {
      return (
        "오류: 파일이 유효한 .hwpx(ZIP) 포맷이 아닙니다. " +
        "파일이 손상되었거나 구형 .hwp(OLE 바이너리) 포맷입니다. " +
        "한글 프로그램에서 .hwpx로 저장 후 다시 시도하세요."
      );
    }

    // 편집 적용
    const editRequests: CellEditRequest[] = input.edits.map((e) => ({
      tableIndex: e.tableIndex,
      row: e.row,
      col: e.col,
      newText: e.newText,
      expectedText: e.expectedText,
    }));

    const { buffer: newBuffer, results } = await applyEditsToHwpx(
      new Uint8Array(originalBuffer.buffer as ArrayBuffer),
      editRequests,
    );

    // 실패한 편집 확인
    const failedResults = results.map((r, i) => ({ r, i })).filter(({ r }) => !r.success);

    if (failedResults.length > 0) {
      const messages = failedResults.map(({ r, i }) => {
        const edit = input.edits[i];
        return (
          `편집 #${i + 1} (표 ${edit?.tableIndex ?? "?"}, ` +
          `행 ${edit?.row ?? "?"}, 열 ${edit?.col ?? "?"}): ${r.error}`
        );
      });
      return `오류: 다음 편집을 적용할 수 없어 파일을 수정하지 않았습니다.\n${messages.join("\n")}`;
    }

    // diff 생성 (표·셀 변경 표)
    const diffLines = ["| 표·셀 | 이전 | 이후 |", "| --- | --- | --- |"];
    for (let i = 0; i < input.edits.length; i++) {
      const e = input.edits[i];
      if (!e) continue;
      const oldText = results[i]?.oldText ?? "";
      diffLines.push(`| #${e.tableIndex} (${e.row},${e.col}) | ${oldText} | ${e.newText} |`);
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
