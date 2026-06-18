import { describe, expect, it } from "vitest";
import { formatCumulativeUsage } from "./usage.js";

describe("formatCumulativeUsage", () => {
  it("입력·출력 토큰을 표시한다(k 단위 축약)", () => {
    const line = formatCumulativeUsage(125_000, 8_200);
    expect(line).toContain("입력 125.0k");
    expect(line).toContain("출력 8.2k");
    expect(line).toContain("토큰");
  });

  it("1000 미만은 그대로 표시한다", () => {
    const line = formatCumulativeUsage(900, 50);
    expect(line).toContain("입력 900");
    expect(line).toContain("출력 50");
  });

  it("비용($)을 표시하지 않는다", () => {
    expect(formatCumulativeUsage(1_000_000, 1_000_000)).not.toContain("$");
  });
});
