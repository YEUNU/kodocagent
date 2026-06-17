/**
 * find_in_document 툴 — HWPX 문서 내 텍스트 위치 탐색 (읽기 전용)
 *
 * 표 셀 매칭 결과에는 propose_cell_edit에서 바로 쓸 수 있는
 * tableIndex / row / col 좌표를 반환한다.
 *
 * tableIndex 정책은 propose-cell-edit의 applyEditsToHwpx와 동일:
 *   - Contents/section*.xml을 sort()한 순서로 처리
 *   - 각 섹션에서 depth=0의 tbl_open 토큰만 카운팅
 *   - globalOffset으로 섹션 간 연속 인덱스 유지
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import type { ToolContext, ToolDefinition } from "../types.js";
import {
  collectDirectTcRanges,
  findTopLevelTableRange,
  readOwnTextFromTc,
  tokenizeHwpxXml,
} from "./propose-cell-edit.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

export const findInDocumentSchema = z.object({
  path: z.string().describe("검색할 .hwpx 문서 경로"),
  query: z.string().min(1).describe("찾을 텍스트"),
  caseSensitive: z.boolean().optional().describe("대소문자 구분 (기본 false)"),
});

export type FindInDocumentInput = z.infer<typeof findInDocumentSchema>;

// ─────────────────────────────────────────────────────────
// Hit 타입
// ─────────────────────────────────────────────────────────

export type Hit =
  | {
      kind: "표";
      tableIndex: number;
      row: number;
      col: number;
      text: string;
    }
  | {
      kind: "본문";
      section: number;
      text: string;
    };

// ─────────────────────────────────────────────────────────
// XML 이스케이프 해제 (propose-find-replace의 unescapeXml과 동일)
// ─────────────────────────────────────────────────────────

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * 매칭 주변 ~60자 윈도우 텍스트를 만든다.
 */
function windowText(text: string, query: string, caseSensitive: boolean, maxLen = 60): string {
  const compare = caseSensitive ? text : text.toLowerCase();
  const compareQuery = caseSensitive ? query : query.toLowerCase();
  const idx = compare.indexOf(compareQuery);
  if (idx < 0) return text.slice(0, maxLen);
  const half = Math.floor((maxLen - query.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, idx + query.length + half);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}

// ─────────────────────────────────────────────────────────
// 순수 탐색 함수 (단위 테스트 가능)
// ─────────────────────────────────────────────────────────

/**
 * 섹션 XML 문자열 배열에서 query를 탐색하여 Hit 목록을 반환한다.
 *
 * tableIndex / row / col 좌표는 propose_cell_edit의 applyEditsToHwpx와
 * 완전히 동일한 로직으로 계산된다:
 *   - 각 섹션 XML에서 tokenizeHwpxXml → depth=0 tbl_open 카운팅
 *   - globalOffset += localCount 로 섹션 간 연속 인덱스
 *   - row = cellAddr rowAddr, col = cellAddr colAddr (0-based)
 *
 * 본문 매칭은 tbl 깊이=0인 구간의 <hp:t>...</hp:t> 노드만 대상으로 한다.
 */
export function findInSectionXmls(xmls: string[], query: string, caseSensitive: boolean): Hit[] {
  const hits: Hit[] = [];
  let globalOffset = 0;

  for (let si = 0; si < xmls.length; si++) {
    const xml = xmls[si] ?? "";
    const tokens = tokenizeHwpxXml(xml);

    // ── 최상위 표 수 계산 (propose-cell-edit lines 718-727과 동일) ──
    let localCount = 0;
    {
      let depth = 0;
      for (const tok of tokens) {
        if (tok.kind === "tbl_open") {
          if (depth === 0) localCount++;
          depth++;
        } else if (tok.kind === "tbl_close") {
          depth--;
        }
      }
    }

    // ── 표 셀 탐색 ──
    for (let ti = 0; ti < localCount; ti++) {
      const range = findTopLevelTableRange(tokens, ti);
      if (!range) continue;

      const cells = collectDirectTcRanges(tokens, range.start, range.end);
      // cellAddr 토큰을 빠르게 조회하기 위해 범위 안 토큰만 미리 필터링
      const tblTokens = tokens.filter((t) => t.pos >= range.start && t.pos < range.end);

      for (const cell of cells) {
        const cellText = readOwnTextFromTc(xml, tokens, cell.start, cell.end);

        const compare = caseSensitive ? cellText : cellText.toLowerCase();
        const compareQuery = caseSensitive ? query : query.toLowerCase();
        if (!compare.includes(compareQuery)) continue;

        // row / col: cellAddr 토큰에서 읽기
        const cellTokens = tblTokens.filter((t) => t.pos >= cell.start && t.pos < cell.end);
        const addrTok = cellTokens.find((t) => t.kind === "cell_addr");
        if (addrTok === undefined) continue;
        const row = addrTok.rowAddr ?? 0;
        const col = addrTok.colAddr ?? 0;

        const truncated = cellText.length > 60 ? `${cellText.slice(0, 57)}…` : cellText;

        hits.push({
          kind: "표",
          tableIndex: globalOffset + ti,
          row,
          col,
          text: truncated,
        });
      }
    }

    // ── 본문 텍스트 탐색 (tbl 깊이 = 0인 구간만) ──
    // <hp:t>...</hp:t> 노드를 직접 스캔. 표 깊이를 추적하여
    // 표 안의 텍스트는 이미 위에서 처리했으므로 여기서는 깊이=0만.
    {
      // tbl_open/tbl_close 토큰으로 깊이 구간을 계산한 뒤
      // 깊이=0 구간의 <hp:t>...</hp:t>를 정규식으로 스캔한다.
      // 구간을 [start, end) 쌍으로 수집.
      const bodySegments: Array<{ start: number; end: number }> = [];
      let tblDepth = 0;
      let segStart = 0;

      for (const tok of tokens) {
        if (tok.kind === "tbl_open") {
          if (tblDepth === 0) {
            // 표 시작 전까지가 본문
            if (tok.pos > segStart) {
              bodySegments.push({ start: segStart, end: tok.pos });
            }
          }
          tblDepth++;
        } else if (tok.kind === "tbl_close") {
          tblDepth--;
          if (tblDepth === 0) {
            segStart = tok.end;
          }
        }
      }
      // 마지막 표 이후 본문
      if (segStart < xml.length) {
        bodySegments.push({ start: segStart, end: xml.length });
      }

      const tRe = /<hp:t>([\s\S]*?)<\/hp:t>/g;
      for (const seg of bodySegments) {
        const slice = xml.slice(seg.start, seg.end);
        tRe.lastIndex = 0;
        let m = tRe.exec(slice);
        while (m !== null) {
          const rawText = m[1] ?? "";
          const decodedText = unescapeXml(rawText);
          const compare = caseSensitive ? decodedText : decodedText.toLowerCase();
          const compareQuery = caseSensitive ? query : query.toLowerCase();
          if (compare.includes(compareQuery)) {
            hits.push({
              kind: "본문",
              section: si,
              text: windowText(decodedText, query, caseSensitive),
            });
          }
          m = tRe.exec(slice);
        }
      }
    }

    globalOffset += localCount;
  }

  return hits;
}

// ─────────────────────────────────────────────────────────
// 결과 포맷
// ─────────────────────────────────────────────────────────

const MAX_HITS = 50;

function formatHits(hits: Hit[], query: string): string {
  const shown = hits.slice(0, MAX_HITS);
  const lines = shown.map((h) => {
    if (h.kind === "표") {
      return (
        `[표] tableIndex=${h.tableIndex}, row=${h.row}, col=${h.col} — ` +
        `"${h.text}"  (propose_cell_edit으로 수정 가능)`
      );
    }
    return `[본문] 섹션 ${h.section} — "…${h.text}…"  (propose_find_replace로 수정 가능)`;
  });

  const notice =
    hits.length > MAX_HITS ? `\n(총 ${hits.length}개 매칭 중 ${MAX_HITS}개만 표시됩니다.)` : "";

  return `"${query}" 검색 결과: ${hits.length}개\n\n${lines.join("\n")}${notice}`;
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const findInDocumentTool: ToolDefinition<FindInDocumentInput> = {
  name: "find_in_document",
  description:
    "문서에서 특정 텍스트가 **어디에 있는지** 위치를 찾아 줍니다. " +
    "표 안의 셀이면 propose_cell_edit에서 바로 쓸 수 있는 tableIndex·row·col 좌표를, " +
    "본문이면 주변 맥락을 반환합니다. " +
    "큰 문서에서 전체를 읽지 않고 수정 대상을 정확히 지정할 때 사용하세요. " +
    ".hwpx 전용.",
  inputSchema: findInDocumentSchema,
  requiresApproval: false,

  execute: async ({
    input,
    ctx,
  }: {
    input: FindInDocumentInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }): Promise<string> => {
    // 경로 검증
    let safePath: string;
    try {
      safePath = await resolveSafePath(ctx.cwd, input.path);
    } catch (err) {
      return `오류: 경로를 확인할 수 없습니다: ${input.path}. ${String(err)}`;
    }

    const ext = extname(safePath).toLowerCase();
    if (ext !== ".hwpx") {
      return (
        "find_in_document는 .hwpx 전용입니다. " +
        "본문 텍스트 검색은 read_document의 search 모드를 사용하세요. " +
        "(.hwp 파일은 한글에서 다른 이름으로 저장 → .hwpx로 변환 후 사용하세요.)"
      );
    }

    // 파일 읽기
    let bytes: Buffer;
    try {
      bytes = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }

    // ZIP 매직 바이트 검증 (PK = 0x504B)
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return (
        "오류: 파일이 유효한 .hwpx(ZIP) 포맷이 아닙니다. " +
        "파일이 손상되었거나 구형 .hwp(OLE 바이너리) 포맷입니다. " +
        "한글 프로그램에서 .hwpx로 저장 후 다시 시도하세요."
      );
    }

    // ZIP 열기
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch (err) {
      return `오류: .hwpx ZIP을 열 수 없습니다: ${String(err)}`;
    }

    // 섹션 XML 수집 (propose-cell-edit의 sectionFiles 정렬과 동일)
    const sectionNames = Object.keys(zip.files)
      .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
      .sort();

    const xmls: string[] = [];
    for (const name of sectionNames) {
      try {
        const entry = zip.file(name);
        const xml = entry ? await entry.async("string") : "";
        xmls.push(xml);
      } catch {
        xmls.push("");
      }
    }

    if (xmls.length === 0) {
      return `오류: .hwpx 파일에서 섹션 XML을 찾을 수 없습니다: ${input.path}`;
    }

    // 탐색
    const caseSensitive = input.caseSensitive ?? false;
    let hits: Hit[];
    try {
      hits = findInSectionXmls(xmls, input.query, caseSensitive);
    } catch (err) {
      return `오류: 문서 탐색 중 예외가 발생했습니다: ${String(err)}`;
    }

    if (hits.length === 0) {
      return `문서에서 "${input.query}"를 찾지 못했습니다: ${input.path}`;
    }

    return formatHits(hits, input.query);
  },
};
