/**
 * 문서 편집 검증 하네스 — Stage 1: 평가 스펙 (assert 순수 함수)
 *
 * EVAL_SPECS[n].assert(outputMarkdown) 는 순수 함수다.
 * Stage 2에서 실모델이 편집한 문서를 kordoc parse().markdown으로 추출한 뒤
 * 이 함수에 전달해 합격 여부를 판정한다.
 *
 * docs/EVAL-SET.md §2–§3 참조.
 */

export interface EvalSpec {
  /** EVAL-SET.md 번호 */
  id: string;
  /** 사용할 픽스처 이름 (makeF1/makeF2/makeF5Hwpx 등) */
  fixture: string;
  /** 사용자가 실제 입력할 한국어 지시문 */
  prompt: string;
  /**
   * 순수 assert 함수 — 편집 후 문서의 마크다운 텍스트를 받아
   * 합격 여부와 상세 사유를 반환한다.
   */
  assert: (outputMarkdown: string) => { pass: boolean; detail: string };
}

// ─────────────────────────────────────────────────────────
// #4 날짜 통일 (F1)
// ─────────────────────────────────────────────────────────
// 합격: 구 날짜 패턴 전부 사라지고 'YYYY. MM. DD.' 형식 1건 이상 존재

/** 구 날짜 패턴들 */
const OLD_DATE_PATTERNS = [
  /\d{4}년\s*\d+월\s*\d+일/,
  /\b\d{2}\.\d{1,2}\.\d{1,2}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
] as const;

/** 목표 날짜 형식: YYYY. MM. DD. */
const NEW_DATE_PATTERN = /\d{4}\.\s*\d{2}\.\s*\d{2}\./;

const specDateUnify: EvalSpec = {
  id: "#4",
  fixture: "F1",
  prompt:
    "F1 문서의 날짜 표기를 모두 'YYYY. MM. DD.' 형식으로 통일해 주세요. " +
    "'2026년 1월 1일', '26.1.1', '2026-01-01' 등 구 형식이 남아 있으면 안 됩니다.",
  assert(md: string) {
    const remaining = OLD_DATE_PATTERNS.filter((re) => re.test(md));
    if (remaining.length > 0) {
      return {
        pass: false,
        detail: `구 날짜 패턴 ${remaining.length}종 잔존: ${remaining.map((r) => r.toString()).join(", ")}`,
      };
    }
    if (!NEW_DATE_PATTERN.test(md)) {
      return {
        pass: false,
        detail: "'YYYY. MM. DD.' 형식의 날짜가 1건도 없습니다.",
      };
    }
    return { pass: true, detail: "모든 날짜가 YYYY. MM. DD. 형식으로 통일되었습니다." };
  },
};

// ─────────────────────────────────────────────────────────
// #6 금액 콤마 (F2)
// ─────────────────────────────────────────────────────────
// 합격: '1,500,000' 존재 & 콤마 없는 '1500000' 미존재

const specAmountComma: EvalSpec = {
  id: "#6",
  fixture: "F2",
  prompt: "F2 표의 금액 숫자에 천 단위 콤마를 추가해 주세요. 예: 1500000 → 1,500,000",
  assert(md: string) {
    if (!md.includes("1,500,000")) {
      return { pass: false, detail: "'1,500,000' 콤마 형식이 없습니다." };
    }
    // 콤마 없는 원문 패턴(숫자만 연속) 검사 — 단, 총액 1730000도 확인
    if (/\b1500000\b/.test(md)) {
      return { pass: false, detail: "콤마 없는 '1500000'이 여전히 존재합니다." };
    }
    return { pass: true, detail: "금액에 천 단위 콤마가 올바르게 추가되었습니다." };
  },
};

// ─────────────────────────────────────────────────────────
// #12 부서명 치환 (F1)
// ─────────────────────────────────────────────────────────
// '문화기획팀' → '문화사업팀' 전역 치환
// 합격: '문화기획팀' 미존재 & '문화사업팀' 존재

const OLD_DEPT = "문화기획팀";
const NEW_DEPT = "문화사업팀";

const specDeptRename: EvalSpec = {
  id: "#12",
  fixture: "F1",
  prompt: `조직개편을 반영해 문서의 '${OLD_DEPT}'를 모두 '${NEW_DEPT}'으로 바꿔 주세요.`,
  assert(md: string) {
    if (md.includes(OLD_DEPT)) {
      return {
        pass: false,
        detail: `'${OLD_DEPT}'이 여전히 존재합니다.`,
      };
    }
    if (!md.includes(NEW_DEPT)) {
      return {
        pass: false,
        detail: `'${NEW_DEPT}'이 없습니다.`,
      };
    }
    return {
      pass: true,
      detail: `'${OLD_DEPT}' → '${NEW_DEPT}' 치환이 완료되었습니다.`,
    };
  },
};

// ─────────────────────────────────────────────────────────
// #15 법령명 변경 (F1)
// ─────────────────────────────────────────────────────────
// '구 정보통신망법' → '정보통신망 이용촉진 및 정보보호 등에 관한 법률'
// 합격: 구 명칭 미존재 & 현행 명칭 존재

const OLD_LAW = "구 정보통신망법";
const NEW_LAW = "정보통신망 이용촉진 및 정보보호 등에 관한 법률";

const specLawRename: EvalSpec = {
  id: "#15",
  fixture: "F1",
  prompt: `문서의 '${OLD_LAW}'를 현행 법령 명칭인 '${NEW_LAW}'으로 변경해 주세요.`,
  assert(md: string) {
    if (md.includes(OLD_LAW)) {
      return {
        pass: false,
        detail: `'${OLD_LAW}'가 여전히 존재합니다.`,
      };
    }
    if (!md.includes(NEW_LAW)) {
      return {
        pass: false,
        detail: `현행 법령명 '${NEW_LAW}'이 없습니다.`,
      };
    }
    return {
      pass: true,
      detail: "법령명이 현행 명칭으로 올바르게 변경되었습니다.",
    };
  },
};

// ─────────────────────────────────────────────────────────
// #28 PII 마스킹 (F5)
// ─────────────────────────────────────────────────────────
// 합격: 원문 주민번호/전화/카드 패턴 미존재 & 마스킹 형태('***', '****') 1건 이상 존재

/** 원문 PII 패턴 — 탐지만 사용(실제 값 노출 없이 테스트) */
const RAW_PII_PATTERNS = [
  /\b\d{6}-[1-4]\d{6}\b/, // 주민등록번호
  /\b0\d{1,2}-\d{3,4}-\d{4}\b/, // 전화번호
  /\b\d{4}-\d{4}-\d{4}-\d{4}\b/, // 신용카드번호
] as const;

const specPiiMask: EvalSpec = {
  id: "#28",
  fixture: "F5",
  prompt:
    "개인정보 규정에 따라 문서의 주민등록번호, 전화번호, 이메일, 카드번호를 모두 마스킹 처리해 주세요.",
  assert(md: string) {
    const found = RAW_PII_PATTERNS.filter((re) => re.test(md));
    if (found.length > 0) {
      return {
        pass: false,
        detail: `원문 PII 패턴 ${found.length}종이 마스킹되지 않고 잔존합니다.`,
      };
    }
    // 마스킹 흔적 확인: *** 또는 **** 패턴
    if (!/\*{3,}/.test(md)) {
      return {
        pass: false,
        detail: "마스킹 처리된 형태('***' 이상)가 없습니다.",
      };
    }
    return { pass: true, detail: "원문 PII가 마스킹되었습니다." };
  },
};

// ─────────────────────────────────────────────────────────
// #3 오탈자·띄어쓰기 (F1)
// ─────────────────────────────────────────────────────────
// 합격: '제고' 존재 & '재고' 미존재 & '확대 합니다' 미존재

const specTypo: EvalSpec = {
  id: "#3",
  fixture: "F1",
  prompt:
    "F1 문서의 오탈자와 띄어쓰기 오류를 수정해 주세요: '재고'를 '제고'로, '확대 합니다'를 '확대합니다'로 바꿔 주세요.",
  assert(md: string) {
    if (!md.includes("제고")) {
      return { pass: false, detail: "'제고'가 존재하지 않습니다." };
    }
    if (md.includes("재고")) {
      return { pass: false, detail: "오탈자 '재고'가 여전히 존재합니다." };
    }
    if (md.includes("확대 합니다")) {
      return { pass: false, detail: "띄어쓰기 오류 '확대 합니다'가 여전히 존재합니다." };
    }
    return { pass: true, detail: "오탈자·띄어쓰기 오류가 모두 수정되었습니다." };
  },
};

// ─────────────────────────────────────────────────────────
// 배열 export
// ─────────────────────────────────────────────────────────

export const EVAL_SPECS: EvalSpec[] = [
  specTypo,
  specDateUnify,
  specAmountComma,
  specDeptRename,
  specLawRename,
  specPiiMask,
];
