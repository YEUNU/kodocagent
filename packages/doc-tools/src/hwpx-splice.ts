/**
 * HWPX section XML splice 헬퍼 — kordoc 프리미티브 공용 래퍼
 *
 * kordoc-api-first 원칙: section XML 직접 편집을 정규식으로 재구현하지 않고
 * scanSectionXml(소스맵) + buildRangeSplices(t-도메인 범위치환, run/charPr·tab/br 보존)
 * + applySplices(겹침검증·역순)에 위임한다. find-replace·redact-pii 등 텍스트 범위
 * 치환 도구가 공유한다.
 */

import type { ScanParagraph, ScanTable, SectionScan, SpliceEdit } from "kordoc";
import { applySplices, buildRangeSplices, scanSectionXml } from "kordoc";

/** t-도메인 좌표 [start, end) 를 replacement(평문)로 치환. replacement는 splice가 XML-이스케이프한다. */
export interface TextRange {
  start: number;
  end: number;
  replacement: string;
}

/**
 * 섹션 스캔 결과의 모든 문단을 문서 순서(xml 오프셋)로 수집한다.
 * 본문 + 표(중첩 재귀) + 머리말/꼬리말 등 비가시 영역(excluded) + orphan 표.
 */
export function collectParasInDocOrder(scan: SectionScan): ScanParagraph[] {
  const out: ScanParagraph[] = [...scan.bodyParagraphs];
  const walkTable = (t: ScanTable): void => {
    for (const row of t.rows) {
      for (const cell of row) {
        out.push(...cell.paragraphs);
        for (const nested of cell.tables) walkTable(nested);
      }
    }
  };
  for (const t of scan.tables) walkTable(t);
  out.push(...scan.excludedParagraphs);
  for (const t of scan.orphanTables) walkTable(t);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 섹션 XML의 각 문단에 대해 `rangeFn(para.text)`가 돌려준 치환 범위들을 splice로 적용한다.
 *
 * - 매칭은 문단 t-도메인 텍스트(엔티티 디코딩, 여러 서식 런 통합)에서 수행되므로
 *   런 경계를 가로지르는 패턴도 처리된다.
 * - 어느 범위든 buildRangeSplices가 null(오프셋 정합 불가)이면 즉시 null을 반환해
 *   호출자가 구 경로로 폴백하게 한다(섹션 단위 all-or-nothing).
 *
 * @returns { xml, count } 또는 null(폴백 필요)
 */
export function applyRangeSplicesToSection(
  xml: string,
  rangeFn: (text: string) => TextRange[],
): { xml: string; count: number } | null {
  const scan = scanSectionXml(xml, 0);
  const paras = collectParasInDocOrder(scan);
  const splices: SpliceEdit[] = [];
  let count = 0;

  for (const p of paras) {
    const ranges = rangeFn(p.text);
    for (const r of ranges) {
      if (r.end <= r.start) continue;
      const s = buildRangeSplices(p, xml, r.start, r.end, r.replacement);
      if (s === null) return null; // 오프셋 정합 불가 — 섹션 전체 폴백
      splices.push(...s);
      count++;
    }
  }

  if (count === 0) return { xml, count: 0 };
  return { xml: applySplices(xml, splices), count };
}
