/**
 * approve.createCliApprovalHandler() 단위 테스트
 *
 * 회귀 방지 대상:
 * - 비 TTY 환경에서는 자동 거절(approved=false) + 한국어 안내 사유
 *   (TTY 인터랙티브 select 경로는 clack 의존이라 단위테스트에서 제외)
 */
import type { Proposal } from "@kodocagent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliApprovalHandler } from "./approve.js";

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    kind: "edit",
    targetPath: "/docs/a.hwpx",
    stagedPath: "/tmp/a.hwpx",
    summary: "수정",
    diff: "@@ -1 +1 @@\n-a\n+b",
    warnings: [],
    ...overrides,
  };
}

const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  // 비 TTY로 강제
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
});

describe("createCliApprovalHandler — 비 TTY", () => {
  it("비대화형 환경에서는 자동 거절하고 한국어 사유를 준다", async () => {
    const handler = createCliApprovalHandler();
    const result = await handler(makeProposal());
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("대화형 터미널");
  });

  it("프로포절 종류와 무관하게 비 TTY는 거절한다", async () => {
    const handler = createCliApprovalHandler();
    const result = await handler(makeProposal({ kind: "redact-pii", warnings: ["주의"] }));
    expect(result.approved).toBe(false);
  });
});
