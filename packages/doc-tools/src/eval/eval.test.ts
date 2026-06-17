/**
 * 문서 편집 검증 하네스 — Stage 1: 단위 테스트
 *
 * 테스트 분류:
 *  A) 픽스처 생성 → kordoc parse() 성공 여부 (합성 round-trip 확인)
 *  B) 각 spec.assert를 BEFORE(실패 예상) / AFTER(성공 예상) 마크다운으로
 *     결정론적으로 검증 (모델 호출 없음)
 *
 * Stage 2 (실모델 e2e)는 KODOC_EVAL_LIVE=1 환경변수로 별도 활성화한다.
 */

import { parse } from "kordoc";
import { describe, expect, it } from "vitest";
import { makeF1, makeF2, makeF5Hwpx, makeF5Md } from "./fixtures.js";
import { EVAL_SPECS } from "./specs.js";

// ─────────────────────────────────────────────────────────
// A) 픽스처 생성 · parse round-trip
// ─────────────────────────────────────────────────────────

describe("픽스처 생성 및 kordoc parse round-trip", () => {
  it("F1 — .hwpx 생성 후 parse() 성공", async () => {
    const f = await makeF1();
    expect(f.ext).toBe(".hwpx");
    expect(f.bytes.length).toBeGreaterThan(0);

    const result = await parse(f.bytes.buffer as ArrayBuffer);
    expect(result.success).toBe(true);
  });

  it("F2 — .hwpx 생성 후 parse() 성공", async () => {
    const f = await makeF2();
    expect(f.ext).toBe(".hwpx");
    expect(f.bytes.length).toBeGreaterThan(0);

    const result = await parse(f.bytes.buffer as ArrayBuffer);
    expect(result.success).toBe(true);
  });

  it("F5 (hwpx) — .hwpx 생성 후 parse() 성공", async () => {
    const f = await makeF5Hwpx();
    expect(f.ext).toBe(".hwpx");
    expect(f.bytes.length).toBeGreaterThan(0);

    const result = await parse(f.bytes.buffer as ArrayBuffer);
    expect(result.success).toBe(true);
  });

  it("F5 (md) — .md 바이트 비어 있지 않음", () => {
    const f = makeF5Md();
    expect(f.ext).toBe(".md");
    expect(f.bytes.length).toBeGreaterThan(0);
    const text = new TextDecoder().decode(f.bytes);
    expect(text).toContain("개인정보");
  });
});

// ─────────────────────────────────────────────────────────
// B) spec.assert 순수 함수 단위 테스트
// ─────────────────────────────────────────────────────────

// ── #3 오탈자·띄어쓰기 ──────────────────────────────────

describe("spec #3 오탈자·띄어쓰기 assert", () => {
  const spec = EVAL_SPECS.find((s) => s.id === "#3");
  if (!spec) throw new Error("spec #3 not found");

  it("BEFORE: 오탈자 '재고', 띄어쓰기 오류 → fail", () => {
    const before = "국민 문화 접근성을 재고하고, AI 도입 효과를 확대 합니다.";
    const r = spec.assert(before);
    expect(r.pass).toBe(false);
  });

  it("AFTER: '제고' 있고 '재고'·'확대 합니다' 없음 → pass", () => {
    const after = "국민 문화 접근성을 제고하고, AI 도입 효과를 확대합니다.";
    const r = spec.assert(after);
    expect(r.pass).toBe(true);
  });

  it("'제고' 없으면 → fail (오탈자만 남아 있는 경우)", () => {
    const noFix = "국민 문화 접근성을 확대합니다."; // 재고도 없고 제고도 없음
    const r = spec.assert(noFix);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("제고");
  });
});

// ── #4 날짜 통일 ─────────────────────────────────────────

describe("spec #4 날짜 통일 assert", () => {
  const spec = EVAL_SPECS.find((s) => s.id === "#4");
  if (!spec) throw new Error("spec #4 not found");

  it("BEFORE: 구 날짜 패턴 혼재 → fail", () => {
    const before = "2026년 1월 1일 기준. 26.1.1 이후 시작. 시작일: 2026-01-01.";
    const r = spec.assert(before);
    expect(r.pass).toBe(false);
  });

  it("AFTER: YYYY. MM. DD. 형식만 존재 → pass", () => {
    const after = "2026. 01. 01. 기준. 2026. 01. 01. 이후 시작. 시작일: 2026. 01. 01.";
    const r = spec.assert(after);
    expect(r.pass).toBe(true);
  });

  it("구 패턴 제거됐지만 새 패턴 없으면 → fail", () => {
    const noNew = "날짜 없는 문서입니다.";
    const r = spec.assert(noNew);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("YYYY. MM. DD.");
  });
});

// ── #6 금액 콤마 ─────────────────────────────────────────

describe("spec #6 금액 콤마 assert", () => {
  const spec = EVAL_SPECS.find((s) => s.id === "#6");
  if (!spec) throw new Error("spec #6 not found");

  it("BEFORE: 콤마 없는 1500000 → fail", () => {
    const before = "| 콘텐츠 제작비 | 1500000 |";
    const r = spec.assert(before);
    expect(r.pass).toBe(false);
  });

  it("AFTER: 1,500,000 있고 1500000 없음 → pass", () => {
    const after = "| 콘텐츠 제작비 | 1,500,000 |";
    const r = spec.assert(after);
    expect(r.pass).toBe(true);
  });

  it("콤마 형식이 없으면 → fail", () => {
    const noComma = "| 콘텐츠 제작비 | 150만원 |";
    const r = spec.assert(noComma);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("1,500,000");
  });
});

// ── #12 부서명 치환 ──────────────────────────────────────

describe("spec #12 부서명 치환 assert", () => {
  const spec = EVAL_SPECS.find((s) => s.id === "#12");
  if (!spec) throw new Error("spec #12 not found");

  it("BEFORE: 구 부서명 '문화기획팀' 존재 → fail", () => {
    const before = "문화기획팀이 주관합니다.";
    const r = spec.assert(before);
    expect(r.pass).toBe(false);
  });

  it("AFTER: '문화사업팀' 있고 '문화기획팀' 없음 → pass", () => {
    const after = "문화사업팀이 주관합니다.";
    const r = spec.assert(after);
    expect(r.pass).toBe(true);
  });

  it("구 이름 제거됐지만 새 이름 없으면 → fail", () => {
    const noNew = "담당팀이 주관합니다.";
    const r = spec.assert(noNew);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("문화사업팀");
  });
});

// ── #15 법령명 변경 ──────────────────────────────────────

describe("spec #15 법령명 변경 assert", () => {
  const spec = EVAL_SPECS.find((s) => s.id === "#15");
  if (!spec) throw new Error("spec #15 not found");

  it("BEFORE: 구 법령명 '구 정보통신망법' 존재 → fail", () => {
    const before = "구 정보통신망법 제22조에 따라";
    const r = spec.assert(before);
    expect(r.pass).toBe(false);
  });

  it("AFTER: 현행 법령명 있고 구 명칭 없음 → pass", () => {
    const after = "정보통신망 이용촉진 및 정보보호 등에 관한 법률 제22조에 따라";
    const r = spec.assert(after);
    expect(r.pass).toBe(true);
  });

  it("구 명칭 제거됐지만 현행명 없으면 → fail", () => {
    const noNew = "정보통신망 관련 법률 제22조에 따라";
    const r = spec.assert(noNew);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("정보통신망 이용촉진");
  });
});

// ── #28 PII 마스킹 ───────────────────────────────────────

describe("spec #28 PII 마스킹 assert", () => {
  const spec = EVAL_SPECS.find((s) => s.id === "#28");
  if (!spec) throw new Error("spec #28 not found");

  it("BEFORE: 원문 주민번호·전화·카드 패턴 존재 → fail", () => {
    const before = [
      "주민등록번호: 900101-1234567",
      "전화번호: 010-1234-5678",
      "카드번호: 1234-5678-9012-3456",
    ].join("\n");
    const r = spec.assert(before);
    expect(r.pass).toBe(false);
  });

  it("AFTER: 마스킹 처리 후 원문 패턴 없음 → pass", () => {
    const after = [
      "주민등록번호: 900101-1*******",
      "전화번호: 010-****-5678",
      "카드번호: 1234-****-****-3456",
      "이메일: h***@example.com",
    ].join("\n");
    const r = spec.assert(after);
    expect(r.pass).toBe(true);
  });

  it("원문 제거됐지만 마스킹 흔적 없으면 → fail", () => {
    const noMask = "개인정보가 삭제되었습니다.";
    const r = spec.assert(noMask);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("마스킹");
  });
});
