/**
 * detectStructuralLoss — kordoc 블록 히스토그램 기반 구조 손실 감지
 *
 * rhwp-engine.ts에서 분리된 순수 유틸리티.
 * propose_find_replace, propose_table_structure 등에서 공용으로 사용한다.
 */

import type { IRBlock } from "kordoc";

/** detectStructuralLoss 결과 */
export interface StructuralLossResult {
  lost: boolean;
  detail: string;
}

/**
 * 편집 전후 kordoc 블록 히스토그램을 비교하여 구조 손실을 감지한다.
 *
 * 히스토그램: block.type 별 개수 (paragraph, table, heading, list, image, separator)
 * ANY 타입에서 after.count < before.count이면 → lost:true, detail에 손실 목록 (한국어)
 *
 * 합법적인 find/replace 및 표 구조 편집(행/열/병합)은 블록 수를 바꾸지 않는다.
 * 따라서 카운트가 줄어드는 경우는 편집 엔진이 콘텐츠를 드롭한 것이다.
 *
 * XML 직접 패치 방식에서는 구조 손실이 발생하면 안 된다 (외과적 수술).
 * 손실이 감지되면 XML 편집에 버그가 있는 것이므로 중단해야 한다.
 *
 * @param beforeBlocks  원본 kordoc parse().blocks
 * @param afterBlocks   편집 후 재파싱한 kordoc parse().blocks
 */
export function detectStructuralLoss(
  beforeBlocks: IRBlock[],
  afterBlocks: IRBlock[],
): StructuralLossResult {
  // 블록 타입 한국어 레이블
  const LABELS: Record<string, string> = {
    paragraph: "단락",
    table: "표",
    heading: "제목",
    list: "목록",
    image: "이미지",
    separator: "구분선",
  };

  // 히스토그램 빌더
  function histogram(blocks: IRBlock[]): Record<string, number> {
    const h: Record<string, number> = {};
    for (const b of blocks) {
      h[b.type] = (h[b.type] ?? 0) + 1;
    }
    return h;
  }

  const beforeH = histogram(beforeBlocks);
  const afterH = histogram(afterBlocks);

  // before에 있는 모든 타입에 대해 after가 줄었는지 확인
  const dropParts: string[] = [];
  for (const [type, beforeCount] of Object.entries(beforeH)) {
    const afterCount = afterH[type] ?? 0;
    if (afterCount < beforeCount) {
      const label = LABELS[type] ?? type;
      dropParts.push(`${label} ${beforeCount}→${afterCount}`);
    }
  }

  if (dropParts.length > 0) {
    return { lost: true, detail: dropParts.join(", ") };
  }
  return { lost: false, detail: "" };
}
