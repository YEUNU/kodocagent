import { describe, expect, it } from "vitest";
import { detectPii, redactText, summarizePii } from "./pii.js";

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
