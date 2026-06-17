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
  /**
   * 평가 티어.
   * "feasible"  — ✅ 현재 도구로 실현 가능 (Stage 1/2 기본 포함)
   * "structural" — ⚠️ 구조 편집 티어 (셀/표/양식 개체 수정 관여)
   * 기본값: "feasible"
   */
  tier?: "feasible" | "structural";
  /**
   * 자동 검증 가능 여부. false면 라이브 러너가 pass/fail 집계에서 제외한다.
   * 예: 양식 개체(편집상자) 값은 kordoc parse().markdown에 노출되지 않아
   * markdown 기반 assert로 확인 불가 → list_form_objects 기반 검증은 향후 과제.
   */
  autoVerifiable?: boolean;
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
// ⚠️ structural 티어 스펙 — F3/F4 픽스처 기반
// ─────────────────────────────────────────────────────────

// ── #S1 셀 편집 (F3) ────────────────────────────────────
// F3의 "성명" 라벨 오른쪽 빈 셀에 "홍길동"을 채운다.
// 합격: 결과 마크다운에 "홍길동" 존재

const specCellEdit: EvalSpec = {
  id: "#S1",
  fixture: "F3",
  prompt:
    "신청서 양식 표에서 '성명' 옆 빈칸(값 칸)에 '홍길동'을 입력해 주세요. " +
    "propose_cell_edit의 label 모드를 사용하고 direction은 right 입니다.",
  assert(md: string) {
    if (!md.includes("홍길동")) {
      return { pass: false, detail: "'홍길동'이 결과 마크다운에 없습니다." };
    }
    return { pass: true, detail: "'홍길동'이 결과 마크다운에 존재합니다." };
  },
  tier: "structural",
};

// ── #S2 표 구조 (F3) ────────────────────────────────────
// F3 표에 행을 1개 추가한다.
// 합격: 마크다운 표 행 수가 원본(헤더 포함 5행) + 1 = 6행 이상

/**
 * 마크다운 텍스트에서 표 행 수를 근사 계산한다.
 * '|'로 시작하는 줄의 수를 센다(구분선 행 포함).
 */
function countMarkdownTableRows(md: string): number {
  return md.split("\n").filter((line) => /^\s*\|/.test(line)).length;
}

const specTableStructure: EvalSpec = {
  id: "#S2",
  fixture: "F3",
  prompt:
    "신청서 양식 표 맨 아래에 행을 1개 추가해 주세요. " +
    "새 행의 라벨 칸에는 '비고', 값 칸은 비워 두세요. " +
    "propose_table_structure 도구를 사용하세요.",
  assert(md: string) {
    // F3 원본: 헤더 행 + 구분선 + 데이터 3행 = 5행(마크다운 표 줄 기준)
    // 행 추가 후: 6행 이상
    const rowCount = countMarkdownTableRows(md);
    if (rowCount < 6) {
      return {
        pass: false,
        detail: `표 행 수가 ${rowCount}개 — 추가 후 6개 이상이어야 합니다.`,
      };
    }
    return { pass: true, detail: `표 행 수 ${rowCount}개 — 행이 추가되었습니다.` };
  },
  tier: "structural",
};

// ── #S3 양식 개체 (F4) ───────────────────────────────────
// F4의 "성명입력" 편집상자에 "홍길동"을 입력한다.
// 합격: 결과 마크다운 또는 list_form_objects 출력에 "홍길동" 존재
// (마크다운에는 양식 개체 텍스트가 포함되지 않으므로 assert는
//  kordoc parse가 form object 텍스트를 포함하는지 체크하는 대신
//  에이전트가 propose_form_object 후 list_form_objects를 호출하도록 유도하고
//  단순 substring 검사로 근사한다.)

const specFormObject: EvalSpec = {
  id: "#S3",
  fixture: "F4",
  prompt:
    "양식 개체 문서에서 '성명입력' 편집상자에 '홍길동'을 입력해 주세요. " +
    "propose_form_object 도구를 사용하고 name은 '성명입력', set.text='홍길동'입니다.",
  assert(md: string) {
    // kordoc parse()의 마크다운 출력에 양식 개체 텍스트가 반영될 경우 확인
    // 반영 안 될 수도 있으므로 pass 기준은 마크다운에 "홍길동"이 있거나
    // "성명입력" 개체가 언급되는 경우도 허용 (느슨한 근사)
    if (md.includes("홍길동")) {
      return { pass: true, detail: "'홍길동'이 결과 마크다운에 존재합니다." };
    }
    // 양식 개체 텍스트가 kordoc 마크다운에 나타나지 않는 경우도 있으므로
    // 문서가 편집됐다는 다른 증거(성명입력 등 라벨)를 허용하지 않고
    // 실제 값 존재를 요구한다. 이 assert는 라이브 실행 시 kordoc parse
    // 마크다운 기반이므로 편집상자 텍스트가 나타나지 않으면 실패 처리.
    return {
      pass: false,
      detail:
        "'홍길동'이 결과 마크다운에 없습니다. (양식 개체 텍스트가 kordoc 마크다운에 포함되지 않을 수 있음 — ⚠️ 티어 한계)",
    };
  },
  tier: "structural",
  // 양식 개체 값은 markdown에 노출되지 않아 라이브 자동 집계에서 제외(수동/list_form_objects 검증 필요)
  autoVerifiable: false,
};

// ─────────────────────────────────────────────────────────
// 배열 export
// ─────────────────────────────────────────────────────────

export const EVAL_SPECS: EvalSpec[] = [
  // ✅ feasible 티어 (기존 6종)
  specTypo,
  specDateUnify,
  specAmountComma,
  specDeptRename,
  specLawRename,
  specPiiMask,
  // ⚠️ structural 티어 (신규 3종)
  specCellEdit,
  specTableStructure,
  specFormObject,
];
