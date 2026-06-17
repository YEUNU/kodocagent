import { describe, expect, it } from "vitest";
import { detectPii, summarizePii } from "./pii.js";

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
