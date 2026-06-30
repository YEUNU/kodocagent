/**
 * 구조 지문(structural fingerprint) — 문서의 "양식 골격"을 캡처한다.
 *
 * kordoc IRBlock 에서 뽑을 수 있는 구조만(블록 타입 분포·제목 계층·표 격자·항목부호 추정).
 * ⚠️ 한계: kordoc IRBlock 은 글꼴·여백·색상·줄간격을 노출하지 않으므로 "완전한 서식(양식)"이
 * 아니라 **구조 골격**만 캡처한다. 그래도 (A) 새 문서 생성 가이드(extract_format_template)와
 * (B) 편집 후 양식 적합성 검증(propose_edit drift)에 충분하다.
 */

import type { IRBlock } from "kordoc";

export interface TableShape {
  rows: number;
  cols: number;
  hasHeader: boolean;
  caption?: string;
}

export interface StructuralFingerprint {
  /** 블록 타입별 개수 (paragraph/table/heading/list/image/separator) */
  blockHistogram: Record<string, number>;
  /** 제목 계층 (level + 텍스트 일부) */
  headingOutline: { level: number; text: string }[];
  /** 표 격자 목록 */
  tables: TableShape[];
  listCount: number;
  imageCount: number;
  footnoteCount: number;
  /** 추정 항목부호 체계 */
  numberingStyle: "법정(1. 가. 1) …)" | "보고서(□ ○ -)" | "혼합/없음";
}

const HEADING_TEXT_MAX = 50;

/** 법정 8단계 표식: "1." "가." "1)" "①" "ⅰ." 등 / 보고서 표식: "□ ○ - ㆍ ▪" */
const REPORT_MARKER = /^\s*[□■○●◦▪▫·ㆍ\-–]\s/;
const LEGAL_MARKER = /^\s*(?:\d+\.|[가-힣]\.|\d+\)|[①-⑮]|[ⅰ-ⅹ]\.?)\s/;

function isFootnote(b: IRBlock): boolean {
  return typeof (b as { footnoteText?: string }).footnoteText === "string";
}

/** 블록 트리에서 구조 골격을 계산한다(표 셀 내부 텍스트는 골격 대상 아님 — 표 격자만). */
export function computeStructuralFingerprint(blocks: IRBlock[]): StructuralFingerprint {
  const blockHistogram: Record<string, number> = {};
  const headingOutline: { level: number; text: string }[] = [];
  const tables: TableShape[] = [];
  let listCount = 0;
  let imageCount = 0;
  let footnoteCount = 0;
  let reportMarks = 0;
  let legalMarks = 0;

  const walk = (bs: IRBlock[]): void => {
    for (const b of bs) {
      blockHistogram[b.type] = (blockHistogram[b.type] ?? 0) + 1;
      if (isFootnote(b)) footnoteCount++;
      if (b.type === "heading") {
        headingOutline.push({
          level: b.level ?? 1,
          text: (b.text ?? "").slice(0, HEADING_TEXT_MAX),
        });
      } else if (b.type === "table" && b.table) {
        tables.push({
          rows: b.table.rows,
          cols: b.table.cols,
          hasHeader: b.table.hasHeader,
          ...(b.table.caption ? { caption: b.table.caption } : {}),
        });
      } else if (b.type === "list") {
        listCount++;
      } else if (b.type === "image") {
        imageCount++;
      }
      // 항목부호 추정 — 단락/제목 텍스트 선두 표식
      const t = b.text ?? "";
      if (REPORT_MARKER.test(t)) reportMarks++;
      else if (LEGAL_MARKER.test(t)) legalMarks++;
      // 중첩 리스트 아이템만 재귀(표 셀은 격자만 보므로 비재귀)
      if (b.children && b.children.length > 0) walk(b.children);
    }
  };
  walk(blocks);

  const numberingStyle: StructuralFingerprint["numberingStyle"] =
    reportMarks > legalMarks && reportMarks >= 2
      ? "보고서(□ ○ -)"
      : legalMarks > reportMarks && legalMarks >= 2
        ? "법정(1. 가. 1) …)"
        : "혼합/없음";

  return {
    blockHistogram,
    headingOutline,
    tables,
    listCount,
    imageCount,
    footnoteCount,
    numberingStyle,
  };
}

export interface FingerprintDrift {
  drift: boolean;
  details: string[];
}

const TYPE_LABELS: Record<string, string> = {
  paragraph: "단락",
  table: "표",
  heading: "제목",
  list: "목록",
  image: "이미지",
  separator: "구분선",
};

/**
 * 두 구조 지문을 비교해 양식 이탈(drift)을 보고한다.
 * 편집은 원래 양식 골격을 보존해야 한다 — 블록 타입 개수 변동·제목 계층 변화·표 격자 변동·
 * 이미지/각주 손실을 이탈로 본다(텍스트 내용 변경은 정상이므로 보지 않는다).
 */
export function compareFingerprints(
  before: StructuralFingerprint,
  after: StructuralFingerprint,
): FingerprintDrift {
  const details: string[] = [];

  // 1) 구조 블록 타입 개수 변동 — 표·제목·이미지·구분선만 본다.
  //    단락/목록 개수 변화는 일반 텍스트 편집이라 양식 이탈로 보지 않는다(노이즈 방지).
  const STRUCTURAL = ["table", "heading", "image", "separator"];
  for (const t of STRUCTURAL) {
    const b = before.blockHistogram[t] ?? 0;
    const a = after.blockHistogram[t] ?? 0;
    if (a !== b) details.push(`${TYPE_LABELS[t] ?? t} ${b}→${a}`);
  }

  // 2) 표 격자 — 개수가 같을 때 각 표의 행/열 변화(개수 변화는 1에서 이미 보고)
  if (before.tables.length === after.tables.length) {
    for (let i = 0; i < before.tables.length; i++) {
      const bt = before.tables[i];
      const at = after.tables[i];
      if (bt && at && (bt.rows !== at.rows || bt.cols !== at.cols)) {
        details.push(`표 ${i + 1} 격자 ${bt.rows}×${bt.cols}→${at.rows}×${at.cols}`);
      }
    }
  }

  // 3) 각주 손실(각주는 블록 타입이 아니라 별도 카운트)
  if (after.footnoteCount < before.footnoteCount) {
    details.push(`각주 ${before.footnoteCount}→${after.footnoteCount}`);
  }

  return { drift: details.length > 0, details };
}
