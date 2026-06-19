import { describe, expect, it } from "vitest";
import { detectPii, redactRanges, redactText, summarizePii } from "./pii.js";

describe("redactRanges", () => {
  it("PII 매치의 [start,end)와 마스킹값을 반환한다", () => {
    const text = "전화 010-1234-5678 끝";
    const ranges = redactRanges(text);
    expect(ranges).toHaveLength(1);
    const r = ranges[0]!;
    expect(text.slice(r.start, r.end)).toBe("010-1234-5678");
    expect(r.replacement).toBe("010-****-5678");
    expect(r.type).toBe("전화번호");
  });

  it("여러 PII를 시작 순서로 정렬해 반환한다", () => {
    const text = "a@b.com 그리고 901215-1234567";
    const ranges = redactRanges(text);
    expect(ranges.map((r) => r.type)).toEqual(["이메일", "주민등록번호"]);
    expect(ranges[0]!.start).toBeLessThan(ranges[1]!.start);
  });

  it("PII가 없으면 빈 배열", () => {
    expect(redactRanges("회의는 3시")).toEqual([]);
    expect(redactRanges("")).toEqual([]);
  });

  it("범위를 적용하면 redactText와 동일한 결과가 된다", () => {
    const text = "주민 901215-1234567, 카드 1234-5678-9012-3456";
    const ranges = redactRanges(text);
    let out = text;
    for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
    }
    expect(out).toBe(redactText(text).text);
  });
});

describe("detectPii", () => {
  it("주민등록번호를 탐지한다", () => {
    const findings = detectPii("이름: 홍길동 주민번호: 901215-1234567");
    const rrn = findings.find((f) => f.type === "주민등록번호");
    expect(rrn).toBeDefined();
    expect(rrn?.count).toBe(1);
  });

  it("주민등록번호를 올바르게 마스킹한다 (원문 미포함)", () => {
    const findings = detectPii("901215-1234567");
    const rrn = findings.find((f) => f.type === "주민등록번호");
    expect(rrn).toBeDefined();
    // 마스킹된 값: 앞 8자(6자리-성별자리) + ******: 901215-1******
    expect(rrn?.masked[0]).toMatch(/^\d{6}-\d{1}\*{6}$/);
    expect(rrn?.masked[0]).not.toContain("234567");
  });

  it("신용카드번호를 탐지한다", () => {
    const findings = detectPii("카드번호: 1234-5678-9012-3456");
    const card = findings.find((f) => f.type === "신용카드번호");
    expect(card).toBeDefined();
    expect(card?.count).toBe(1);
  });

  it("신용카드번호를 올바르게 마스킹한다 (원문 미포함)", () => {
    const findings = detectPii("1234-5678-9012-3456");
    const card = findings.find((f) => f.type === "신용카드번호");
    expect(card).toBeDefined();
    // 형식: 1234-****-****-3456
    expect(card?.masked[0]).toBe("1234-****-****-3456");
    expect(card?.masked[0]).not.toContain("5678");
    expect(card?.masked[0]).not.toContain("9012");
  });

  it("전화번호를 탐지한다", () => {
    const findings = detectPii("연락처: 010-1234-5678");
    const phone = findings.find((f) => f.type === "전화번호");
    expect(phone).toBeDefined();
    expect(phone?.count).toBe(1);
  });

  it("전화번호를 올바르게 마스킹한다 (원문 미포함)", () => {
    const findings = detectPii("010-1234-5678");
    const phone = findings.find((f) => f.type === "전화번호");
    expect(phone).toBeDefined();
    // 형식: 010-****-5678
    expect(phone?.masked[0]).toBe("010-****-5678");
    expect(phone?.masked[0]).not.toContain("1234");
  });

  it("02 지역번호 전화번호도 탐지한다", () => {
    const findings = detectPii("02-123-4567");
    const phone = findings.find((f) => f.type === "전화번호");
    expect(phone).toBeDefined();
  });

  it("이메일을 탐지한다", () => {
    const findings = detectPii("이메일: user@example.com");
    const email = findings.find((f) => f.type === "이메일");
    expect(email).toBeDefined();
    expect(email?.count).toBe(1);
  });

  it("이메일을 올바르게 마스킹한다 (원문 미포함)", () => {
    const findings = detectPii("user@example.com");
    const email = findings.find((f) => f.type === "이메일");
    expect(email).toBeDefined();
    // 형식: u***@example.com
    expect(email?.masked[0]).toBe("u***@example.com");
    expect(email?.masked[0]).not.toContain("ser");
  });

  it("순수 텍스트에서는 탐지 결과 없음 (false positive 방지)", () => {
    const findings = detectPii("회의는 3시, 예산 1,000,000원");
    expect(findings).toHaveLength(0);
  });

  it("빈 문자열은 빈 배열을 반환한다", () => {
    expect(detectPii("")).toHaveLength(0);
  });

  it("여러 PII 타입이 동시에 탐지된다", () => {
    const text = "010-1234-5678 user@example.com";
    const findings = detectPii(text);
    const types = findings.map((f) => f.type);
    expect(types).toContain("전화번호");
    expect(types).toContain("이메일");
  });

  it("같은 값이 여러 번 나오면 count에 반영되고 masked는 최대 5개 유니크값", () => {
    const text = "010-1234-5678 010-1234-5678 010-9999-8888";
    const findings = detectPii(text);
    const phone = findings.find((f) => f.type === "전화번호");
    expect(phone).toBeDefined();
    expect(phone?.count).toBe(3);
    // 유니크 2개
    expect(phone?.masked).toHaveLength(2);
  });
});

describe("redactText", () => {
  it("주민등록번호를 마스킹하고 원문이 사라진다", () => {
    const { text, findings } = redactText("주민번호: 901215-1234567");
    expect(text).not.toContain("901215-1234567");
    expect(text).toContain("901215-1");
    expect(findings.some((f) => f.type === "주민등록번호")).toBe(true);
  });

  it("전화번호를 마스킹하고 원문이 사라진다", () => {
    const { text, findings } = redactText("연락처: 010-1234-5678");
    expect(text).not.toContain("1234");
    expect(text).toContain("****");
    expect(findings.some((f) => f.type === "전화번호")).toBe(true);
  });

  it("이메일을 마스킹하고 원문이 사라진다", () => {
    const { text, findings } = redactText("이메일: user@example.com");
    expect(text).not.toContain("user@");
    expect(text).toContain("***@example.com");
    expect(findings.some((f) => f.type === "이메일")).toBe(true);
  });

  it("신용카드번호를 마스킹하고 원문이 사라진다", () => {
    const { text, findings } = redactText("카드: 1234-5678-9012-3456");
    expect(text).not.toContain("5678");
    expect(text).toContain("1234-****-****-3456");
    expect(findings.some((f) => f.type === "신용카드번호")).toBe(true);
  });

  it("PII가 없는 순수 텍스트는 변경 없이 반환되고 findings는 빈 배열", () => {
    const { text, findings } = redactText("회의 3시, 예산 1,000,000원");
    expect(text).toBe("회의 3시, 예산 1,000,000원");
    expect(findings).toHaveLength(0);
  });

  it("빈 문자열은 빈 문자열과 빈 findings 반환", () => {
    const { text, findings } = redactText("");
    expect(text).toBe("");
    expect(findings).toHaveLength(0);
  });

  it("두 번 실행해도 오류가 없다 (idempotent-ish)", () => {
    const first = redactText("010-1234-5678 user@example.com");
    expect(() => redactText(first.text)).not.toThrow();
  });

  it("여러 타입이 한 텍스트에 있으면 모두 마스킹된다", () => {
    const raw = "010-1234-5678 user@example.com 901215-1234567";
    const { text, findings } = redactText(raw);
    expect(text).not.toContain("1234-5678");
    expect(text).not.toContain("user@");
    expect(text).not.toContain("901215-1234567");
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────
// L5: 이메일 ReDoS 안전성 + 정상 매칭 유지
// ─────────────────────────────────────────────────────────

describe("L5 — 이메일 패턴 ReDoS 안전성 + 정확성", () => {
  it("서브도메인 포함 정상 이메일을 탐지한다", () => {
    const findings = detectPii("user@mail.example.co.kr");
    const email = findings.find((f) => f.type === "이메일");
    expect(email).toBeDefined();
  });

  it("악성 입력('a@' + 'a.'반복 + TLD없음)이 이메일로 탐지되지 않는다", () => {
    // ReDoS 유발 패턴: 'a@' + 'a.' 반복 (TLD 없음)
    const malicious = `a@${"a.".repeat(30)}`;
    const findings = detectPii(malicious);
    const email = findings.find((f) => f.type === "이메일");
    // 유효한 TLD가 없으므로 매칭되지 않아야 한다
    expect(email).toBeUndefined();
  });

  it("대용량 악성 입력도 선형 시간에 처리된다 (ReDoS 회귀 가드)", () => {
    // 2차 백트래킹이 남아 있으면 n이 커질수록 시간이 제곱으로 폭증한다.
    // 수량자 상한 덕에 약 100KB 입력도 수 ms 내 완료되어야 한다(유효 TLD 없음 → 미매칭).
    const malicious = `a@${"a.".repeat(50000)}`;
    const start = performance.now();
    const findings = detectPii(malicious);
    const elapsed = performance.now() - start;
    expect(findings.find((f) => f.type === "이메일")).toBeUndefined();
    // 선형이면 수 ms, 2차면 수 초. 넉넉히 1초 상한으로 회귀를 잡는다.
    expect(elapsed).toBeLessThan(1000);
  });

  it("기존 이메일 탐지가 여전히 정상 동작한다 (회귀)", () => {
    const text = "연락처: admin@example.com, support@sub.domain.org";
    const findings = detectPii(text);
    const email = findings.find((f) => f.type === "이메일");
    expect(email).toBeDefined();
    expect(email?.count).toBe(2);
  });
});

describe("summarizePii", () => {
  it("탐지 결과를 한 줄 요약으로 반환한다", () => {
    const findings = detectPii("010-1234-5678 user@example.com");
    const summary = summarizePii(findings);
    expect(summary).toContain("전화번호 1건");
    expect(summary).toContain("이메일 1건");
  });

  it("빈 배열은 빈 문자열을 반환한다", () => {
    expect(summarizePii([])).toBe("");
  });

  it("여러 건을 쉼표로 구분한다", () => {
    const findings = [
      { type: "전화번호", count: 3, masked: [] },
      { type: "이메일", count: 1, masked: [] },
    ];
    expect(summarizePii(findings)).toBe("전화번호 3건, 이메일 1건");
  });
});
