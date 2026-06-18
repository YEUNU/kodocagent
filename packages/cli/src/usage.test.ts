import { describe, expect, it } from "vitest";
import { effectiveModelId, estimateCostUsd, formatCumulativeUsage } from "./usage.js";

describe("estimateCostUsd", () => {
  it("Opus 모델: 입력 $15/1M, 출력 $75/1M로 계산", () => {
    // 1M 입력 + 1M 출력 = 15 + 75 = 90
    expect(estimateCostUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(90, 6);
  });

  it("Sonnet: 입력 $3/1M, 출력 $15/1M", () => {
    expect(estimateCostUsd("claude-sonnet-4-6", 1_000_000, 0)).toBeCloseTo(3, 6);
    expect(estimateCostUsd("claude-sonnet-4-6", 0, 1_000_000)).toBeCloseTo(15, 6);
  });

  it("Haiku: 입력 $1/1M, 출력 $5/1M", () => {
    expect(estimateCostUsd("claude-haiku-4-5", 2_000_000, 200_000)).toBeCloseTo(2 + 1, 6);
  });

  it("접두 매칭으로 버전 변형을 커버한다", () => {
    expect(estimateCostUsd("claude-opus-4-7", 1_000_000, 0)).toBeCloseTo(15, 6);
  });

  it("단가 미등록 모델(gpt-5.4 등)은 null", () => {
    expect(estimateCostUsd("gpt-5.4", 1_000_000, 1_000_000)).toBeNull();
    expect(estimateCostUsd("", 100, 100)).toBeNull();
  });
});

describe("effectiveModelId", () => {
  it("model이 있으면 그대로", () => {
    expect(effectiveModelId({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(
      "claude-sonnet-4-6",
    );
  });
  it("anthropic + model 미설정 → 기본 opus", () => {
    expect(effectiveModelId({ provider: "anthropic", model: null })).toBe("claude-opus-4-8");
  });
  it("기본 미등록 provider + model 미설정 → 빈 문자열", () => {
    expect(effectiveModelId({ provider: "openai", model: null })).toBe("");
  });
});

describe("formatCumulativeUsage", () => {
  it("등록 모델은 토큰 + 추정 비용 표기", () => {
    const line = formatCumulativeUsage(
      { provider: "anthropic", model: "claude-opus-4-8" },
      1_000_000,
      1_000_000,
    );
    expect(line).toContain("입력 1000.0k");
    expect(line).toContain("출력 1000.0k");
    expect(line).toContain("$90");
  });

  it("미등록 모델은 토큰만 + 미등록 표기", () => {
    const line = formatCumulativeUsage({ provider: "openai", model: "gpt-5.4" }, 1000, 500);
    expect(line).toContain("입력 1.0k");
    expect(line).toContain("단가 미등록");
    expect(line).not.toContain("$");
  });
});
