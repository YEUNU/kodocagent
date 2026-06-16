/**
 * rhwp-engine — @rhwp/core WASM 지연 초기화 래퍼
 *
 * Phase 1: find/replace 및 HWP/HWPX 내보내기 전용.
 * Phase 2: 표 구조 편집(enumerateTables, findTableByAnchor) 추가.
 * 렌더 메서드(Canvas 필요)는 사용하지 않는다.
 *
 * 설계 원칙:
 *   - WASM(5.6MB)은 첫 번째 rhwp 툴 호출 시에만 로드 (지연 초기화).
 *   - 모듈 임포트 시점에는 WASM을 로드하지 않는다.
 *   - 이중 초기화를 module-level promise로 방지한다.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { HwpDocument } from "@rhwp/core";

// @rhwp/core 타입만 임포트 (런타임 바인딩은 동적 import)
export type { HwpDocument };

/** 초기화 promise — null이면 아직 시작 안 됨 */
let _initPromise: Promise<void> | null = null;

/**
 * @rhwp/core WASM을 지연 초기화한다.
 * 첫 호출 시에만 WASM 파일을 읽고 initSync를 실행한다.
 * 이후 호출은 캐시된 promise를 반환한다.
 */
async function ensureRhwpInit(): Promise<void> {
  if (_initPromise !== null) return _initPromise;

  _initPromise = (async () => {
    let initSync: (opts: { module: Uint8Array }) => void;
    try {
      const mod = await import("@rhwp/core");
      initSync = mod.initSync as (opts: { module: Uint8Array }) => void;
    } catch (e) {
      throw new Error(
        `@rhwp/core 로드 실패. 패키지가 설치되어 있는지 확인하세요. 원인: ${String(e)}`,
      );
    }

    // createRequire로 wasm 파일 경로를 해석한다.
    const _require = createRequire(import.meta.url);
    let wasmPath: string;
    try {
      wasmPath = _require.resolve("@rhwp/core/rhwp_bg.wasm");
    } catch (e) {
      throw new Error(
        `@rhwp/core/rhwp_bg.wasm 경로를 찾을 수 없습니다. ` +
          `패키지가 올바르게 설치되어 있는지 확인하세요. 원인: ${String(e)}`,
      );
    }

    let wasmBytes: Buffer;
    try {
      wasmBytes = await readFile(wasmPath);
    } catch (e) {
      throw new Error(`WASM 파일을 읽을 수 없습니다: ${wasmPath}. 원인: ${String(e)}`);
    }

    initSync({
      module: new Uint8Array(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength),
    });
  })();

  return _initPromise;
}

/**
 * WASM을 초기화하고 HWP/HWPX 파일 바이트에서 HwpDocument를 생성한다.
 *
 * @param bytes   HWP 또는 HWPX 파일의 바이트 (Uint8Array)
 * @returns       HwpDocument 인스턴스
 * @throws        WASM 초기화 실패, 파일 포맷 오류 등
 */
export async function loadRhwpDocument(bytes: Uint8Array): Promise<HwpDocument> {
  await ensureRhwpInit();

  const mod = await import("@rhwp/core");
  const HwpDocument = mod.HwpDocument as typeof import("@rhwp/core").HwpDocument;

  try {
    return new HwpDocument(bytes);
  } catch (e) {
    throw new Error(
      `HWP/HWPX 문서를 불러오지 못했습니다. 파일이 손상되었거나 지원하지 않는 포맷일 수 있습니다. ` +
        `원인: ${String(e)}`,
    );
  }
}

/**
 * 파일 확장자에 따라 HwpDocument를 적절한 포맷으로 내보낸다.
 *
 * @param doc   HwpDocument 인스턴스
 * @param ext   파일 확장자 (소문자, 점 포함) — ".hwp" 또는 ".hwpx"
 * @returns     내보낸 파일의 바이트
 * @throws      지원하지 않는 확장자
 *
 * 주의: doc.exportHwp() 는 편집 내용을 실제로 저장하지 않는다 (rhwp 이슈 #197).
 * 원본 파일을 그대로 반환하므로 편집된 결과 저장에는 사용하지 않는다.
 * propose_find_replace 는 항상 doc.exportHwpx() 를 직접 호출한다.
 */
export function exportByExt(doc: HwpDocument, ext: string): Uint8Array {
  if (ext === ".hwp") {
    // NOTE: exportHwp()는 편집 내용을 저장하지 않는다 (rhwp #197).
    // 이 분기는 레거시 호환 목적으로만 존재하며 실제로 사용하지 않는다.
    return doc.exportHwp();
  }
  if (ext === ".hwpx") {
    return doc.exportHwpx();
  }
  throw new Error(`지원하지 않는 확장자입니다: ${ext}. rhwp 엔진은 .hwp 및 .hwpx만 지원합니다.`);
}

/**
 * replaceAll 결과 JSON의 파싱된 형태.
 * 성공: { ok: true; count: number }
 * 실패 (파싱 오류): null
 */
export interface ReplaceAllResult {
  ok: true;
  count: number;
}

/**
 * doc.replaceAll() 결과 JSON을 파싱한다.
 * @throws  JSON 파싱 실패 시 오류
 */
export function parseReplaceAllResult(json: string): ReplaceAllResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`replaceAll 결과를 파싱할 수 없습니다: ${json}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    (parsed as Record<string, unknown>).ok !== true ||
    typeof (parsed as Record<string, unknown>).count !== "number"
  ) {
    throw new Error(`replaceAll 예상하지 못한 결과: ${json}`);
  }

  return { ok: true, count: (parsed as Record<string, unknown>).count as number };
}

// ─────────────────────────────────────────────────────────
// Phase 2: 표 열거 및 앵커 기반 표 탐색 (propose_table_structure 지원)
// ─────────────────────────────────────────────────────────

/** 문서 내 표 위치 정보 */
export interface TableAddress {
  sec: number;
  para: number;
  ctrl: number;
  rowCount: number;
  colCount: number;
}

/**
 * HTML 태그를 제거하고 기본 HTML 엔티티를 디코딩하여 플레인텍스트를 반환한다.
 * exportControlHtml() 결과 파싱에 사용한다.
 *
 * @param html  HTML 문자열
 * @returns     플레인텍스트
 */
export function htmlToPlainText(html: string): string {
  // 태그 제거
  const noTags = html.replace(/<[^>]*>/g, "");
  // 기본 엔티티 디코딩
  return noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * getTableDimensions 결과 JSON을 파싱한다.
 * 성공: { rowCount, colCount, cellCount }
 * 표가 없거나 오류: null 반환
 */
function parseTableDimensions(
  json: string,
): { rowCount: number; colCount: number; cellCount: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  // ok:false → 표 없음
  if ("ok" in p && p.ok === false) return null;
  if (
    typeof p.rowCount === "number" &&
    typeof p.colCount === "number" &&
    typeof p.cellCount === "number" &&
    p.rowCount > 0
  ) {
    return { rowCount: p.rowCount, colCount: p.colCount, cellCount: p.cellCount };
  }
  return null;
}

/**
 * 문서 내 모든 표를 열거한다.
 *
 * 탐색 방법:
 *   - 섹션(sec) 0..getSectionCount()-1
 *   - 단락(para) 0..getParagraphCount(sec)-1
 *   - 컨트롤(ctrl) 0..MAX_CTRL_PROBE-1 (표 아닌 컨트롤은 throw/ok:false → 건너뜀)
 *
 * rhwp의 표 열거 인덱스는 kordoc의 tableIndex와 일치하지 않는다.
 * (rhwp probe에서 확인: rhwp 8개 vs kordoc 10개 차이 발생)
 * 따라서 이 함수의 결과는 content-anchor 기반 탐색에만 사용한다.
 *
 * @param doc  HwpDocument 인스턴스
 * @returns    발견된 표 주소 목록
 */
export function enumerateTables(doc: HwpDocument): TableAddress[] {
  const MAX_CTRL_PROBE = 12; // 한 단락에서 확인할 최대 컨트롤 수
  const tables: TableAddress[] = [];

  let secCount = 0;
  try {
    const raw = doc.getSectionCount();
    const n = typeof raw === "number" ? raw : (JSON.parse(String(raw)) as unknown);
    secCount = typeof n === "number" ? n : ((n as { count?: number }).count ?? 0);
  } catch {
    return tables;
  }

  for (let sec = 0; sec < secCount; sec++) {
    let paraCount = 0;
    try {
      const raw = doc.getParagraphCount(sec);
      const n = typeof raw === "number" ? raw : (JSON.parse(String(raw)) as unknown);
      paraCount = typeof n === "number" ? n : ((n as { count?: number }).count ?? 0);
    } catch {
      continue;
    }

    for (let para = 0; para < paraCount; para++) {
      for (let ctrl = 0; ctrl < MAX_CTRL_PROBE; ctrl++) {
        try {
          const raw = doc.getTableDimensions(sec, para, ctrl);
          const dims = parseTableDimensions(raw);
          if (dims !== null) {
            tables.push({ sec, para, ctrl, rowCount: dims.rowCount, colCount: dims.colCount });
          }
          // dims null → ctrl에 표 없음, 다음 ctrl 시도
        } catch {
          // 예외 → 이 ctrl에 표 없음, 다음 ctrl 시도
        }
      }
    }
  }

  return tables;
}

/**
 * anchor 텍스트를 포함한 표를 찾는다. (content-anchor 기반 탐색)
 *
 * anchor가 정확히 1개의 표에 있으면 해당 표의 {sec, para, ctrl}을 반환.
 * 0개 또는 2개 이상이면 { error: string }을 반환한다.
 *
 * @param doc     HwpDocument 인스턴스
 * @param anchor  탐색할 텍스트 조각 (부분 일치, 트림)
 */
export function findTableByAnchor(
  doc: HwpDocument,
  anchor: string,
):
  | { sec: number; para: number; ctrl: number; rowCount: number; colCount: number }
  | { error: string } {
  const tables = enumerateTables(doc);
  const trimmedAnchor = anchor.trim();

  const matched: TableAddress[] = [];

  for (const t of tables) {
    let html = "";
    try {
      html = doc.exportControlHtml(t.sec, t.para, "[]", t.ctrl);
    } catch {
      // 이 컨트롤에 HTML 내보내기 실패 → 건너뜀
      continue;
    }
    const text = htmlToPlainText(html);
    if (text.includes(trimmedAnchor)) {
      matched.push(t);
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
    const locs = matched.map((t) => `(sec=${t.sec}, para=${t.para}, ctrl=${t.ctrl})`).join(", ");
    return {
      error:
        `anchor "${anchor}"이(가) 여러 표에서 발견되었습니다: ${locs}. ` +
        `더 구체적인 anchor 텍스트를 사용하여 표를 한 개만 선택할 수 있도록 하세요.`,
    };
  }

  const t = matched[0] as TableAddress;
  return { sec: t.sec, para: t.para, ctrl: t.ctrl, rowCount: t.rowCount, colCount: t.colCount };
}
