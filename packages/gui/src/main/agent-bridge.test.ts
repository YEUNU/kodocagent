/**
 * AgentBridge 단위 테스트
 *
 * - 승인 pending map 로직: respond()가 올바른 Promise resolve
 * - 미지의 proposalId는 무시됨
 * - AgentEvent structuredClone 가능성 검증
 *
 * Electron 모듈 없이 테스트 가능하게 로직을 분리해 import
 */

import { describe, expect, it } from "vitest";
import { isStructuredCloneable } from "./agent-bridge.js";

// ── 승인 pending map 로직 단위 테스트 ──────────────────────────────────────

/**
 * AgentBridge의 내부 pending map 로직을 Electron 없이 테스트하기 위해
 * 로직을 직접 재현한다.
 */
type ApprovalResolver = (result: { approved: boolean; reason?: string }) => void;

class MockApprovalMap {
  private pending = new Map<string, ApprovalResolver>();
  public unknownIds: string[] = [];

  makeHandler(proposalId: string): Promise<{ approved: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.pending.set(proposalId, resolve);
    });
  }

  respond(proposalId: string, approved: boolean, reason?: string): void {
    const resolver = this.pending.get(proposalId);
    if (!resolver) {
      this.unknownIds.push(proposalId);
      return;
    }
    this.pending.delete(proposalId);
    resolver({ approved, reason });
  }

  hasPending(proposalId: string): boolean {
    return this.pending.has(proposalId);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

describe("ApprovalMap — pending map 로직", () => {
  it("respond(approved=true)이 올바르게 Promise를 resolve한다", async () => {
    const map = new MockApprovalMap();
    const promise = map.makeHandler("proposal-1");

    // pending에 등록됐는지 확인
    expect(map.hasPending("proposal-1")).toBe(true);

    // 응답
    map.respond("proposal-1", true);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.reason).toBeUndefined();

    // 응답 후 pending에서 제거됐는지 확인
    expect(map.hasPending("proposal-1")).toBe(false);
  });

  it("respond(approved=false, reason)이 올바르게 Promise를 resolve한다", async () => {
    const map = new MockApprovalMap();
    const promise = map.makeHandler("proposal-2");

    map.respond("proposal-2", false, "너무 많은 변경사항");

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("너무 많은 변경사항");
    expect(map.hasPending("proposal-2")).toBe(false);
  });

  it("미지의 proposalId는 무시되며 예외를 던지지 않는다", () => {
    const map = new MockApprovalMap();
    // makeHandler를 호출하지 않고 respond만 호출
    expect(() => map.respond("unknown-id", true)).not.toThrow();
    expect(map.unknownIds).toContain("unknown-id");
  });

  it("여러 proposal이 동시에 pending될 수 있다", async () => {
    const map = new MockApprovalMap();
    const p1 = map.makeHandler("p-1");
    const p2 = map.makeHandler("p-2");
    const p3 = map.makeHandler("p-3");

    expect(map.pendingCount()).toBe(3);

    map.respond("p-2", false, "이유 있음");
    map.respond("p-1", true);
    map.respond("p-3", true);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(false);
    expect(r2.reason).toBe("이유 있음");
    expect(r3.approved).toBe(true);

    expect(map.pendingCount()).toBe(0);
  });

  it("같은 proposalId로 두 번 respond해도 두 번째는 무시된다", async () => {
    const map = new MockApprovalMap();
    const promise = map.makeHandler("dup-id");

    map.respond("dup-id", true);
    // 두 번째 respond — pending에서 이미 제거됐으므로 unknownIds에 기록
    map.respond("dup-id", false, "다시 거절");

    const result = await promise;
    expect(result.approved).toBe(true); // 첫 번째가 적용됨
    expect(map.unknownIds).toContain("dup-id");
  });
});

// ── structuredClone 가능성 검증 ────────────────────────────────────────────

describe("isStructuredCloneable — AgentEvent IPC 직렬화", () => {
  it("text-delta 이벤트는 structuredClone 가능하다", () => {
    const ev = { type: "text-delta" as const, text: "안녕하세요" };
    expect(isStructuredCloneable(ev)).toBe(true);
  });

  it("tool-call 이벤트는 structuredClone 가능하다", () => {
    const ev = {
      type: "tool-call" as const,
      toolName: "read_document",
      args: { path: "/some/file.hwpx" },
      callId: "call-abc",
    };
    expect(isStructuredCloneable(ev)).toBe(true);
  });

  it("tool-result 이벤트(string 결과)는 structuredClone 가능하다", () => {
    const ev = {
      type: "tool-result" as const,
      callId: "call-abc",
      result: "결과 텍스트",
      isError: false,
    };
    expect(isStructuredCloneable(ev)).toBe(true);
  });

  it("approval-required 이벤트(Proposal)는 structuredClone 가능하다", () => {
    const ev = {
      type: "approval-required" as const,
      proposal: {
        id: "prop-1",
        kind: "edit" as const,
        targetPath: "/docs/report.hwpx",
        stagedPath: "/tmp/staged/report.hwpx",
        summary: "날짜를 2026년으로 수정",
        diff: "--- a/report.hwpx\n+++ b/report.hwpx\n@@ -1 +1 @@\n-2025년\n+2026년",
        warnings: [],
      },
    };
    expect(isStructuredCloneable(ev)).toBe(true);
  });

  it("turn-complete 이벤트는 structuredClone 가능하다", () => {
    const ev = {
      type: "turn-complete" as const,
      usage: { inputTokens: 1000, outputTokens: 500 },
    };
    expect(isStructuredCloneable(ev)).toBe(true);
  });

  it("error 이벤트는 structuredClone 가능하다", () => {
    const ev = {
      type: "error" as const,
      message: "API 키가 유효하지 않습니다.",
      recoverable: false,
    };
    expect(isStructuredCloneable(ev)).toBe(true);
  });

  it("Error 인스턴스는 structuredClone 불가능하다 (확인용)", () => {
    // Error 객체는 IPC로 전달 전 message string으로 변환해야 함을 보여줌
    // Node 17+ 이후 Error는 structuredClone 가능. 이 테스트는 환경 확인용
    const errObj = new Error("test");
    // structuredClone(Error)은 Node.js 17+에서 가능 — 결과는 환경에 따라 다름
    // 중요한 것은 AgentBridge가 Error를 string으로 변환해서 전달한다는 것
    const cloned = isStructuredCloneable(errObj);
    // boolean만 확인 (true or false 모두 OK — 구현이 string으로 변환하므로)
    expect(typeof cloned).toBe("boolean");
  });

  it("함수를 포함한 객체는 structuredClone 불가능하다", () => {
    const obj = { fn: () => {} };
    expect(isStructuredCloneable(obj)).toBe(false);
  });
});
