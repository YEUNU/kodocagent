/**
 * ToolRegistry 두 단계 승인 게이트 단위 테스트
 * docs/SPEC.md §6, §7
 *
 * 주요 검증:
 * - requiresApproval=false 툴: ApprovalHandler 없이 execute 직접 호출
 * - propose 툴 + 핸들러 승인: commit() 한 번 호출, 성공 메시지 반환
 * - propose 툴 + 핸들러 거절: commit() 미호출, 타겟 파일 무변경, "사용자 거절:" 접두사
 * - approval-required 이벤트: eventEmitter 콜백 호출됨
 * - propose가 string 반환: 툴-레벨 오류, handler/commit 미호출
 */

import type { ApprovalHandler, Proposal } from "@kodocagent/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ProposeOutcome } from "./registry.js";
import { ToolRegistry } from "./registry.js";

const ctx = { cwd: "/tmp", sessionId: "test-session" };

describe("ToolRegistry 승인 게이트 (두 단계)", () => {
  it("requiresApproval=false인 툴은 ApprovalHandler 없이 execute가 호출된다", async () => {
    const registry = new ToolRegistry();
    const executeFn = vi.fn().mockResolvedValue("실행됨");
    registry.setContext(ctx);

    registry.register({
      name: "test_tool",
      description: "테스트 툴",
      inputSchema: z.object({ value: z.string() }),
      requiresApproval: false,
      execute: executeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["test_tool"]!.execute!(
      { value: "hello" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );
    expect(executeFn).toHaveBeenCalledOnce();
    expect(result).toBe("실행됨");
  });

  it("propose 툴 + 핸들러 승인: commit() 한 번 호출, 성공 메시지 반환", async () => {
    const registry = new ToolRegistry();

    const commitFn = vi
      .fn()
      .mockResolvedValue("저장 완료: /target/file.hwpx (백업: /backups/file.hwpx)");
    const proposeFn = vi.fn().mockImplementation(
      async (): Promise<ProposeOutcome> => ({
        proposal: {
          id: "prop-001",
          kind: "edit",
          targetPath: "/target/file.hwpx",
          stagedPath: "/staging/file.hwpx",
          summary: "제목 변경",
          diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
          warnings: [],
        } satisfies Proposal,
        commit: commitFn,
      }),
    );

    const handler: ApprovalHandler = async () => ({ approved: true });
    registry.setApprovalHandler(handler);
    registry.setContext(ctx);

    registry.register({
      name: "propose_edit",
      description: "문서 편집 제안",
      inputSchema: z.object({ path: z.string(), newMarkdown: z.string(), summary: z.string() }),
      requiresApproval: true,
      propose: proposeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["propose_edit"]!.execute!(
      { path: "/target/file.hwpx", newMarkdown: "# 새 제목", summary: "제목 변경" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    expect(proposeFn).toHaveBeenCalledOnce();
    expect(commitFn).toHaveBeenCalledOnce();
    expect(typeof result).toBe("string");
    expect(result).toContain("저장 완료");
  });

  it("propose 툴 + 핸들러 거절: commit() 미호출, '사용자 거절:' 접두사 반환", async () => {
    const registry = new ToolRegistry();

    const commitFn = vi.fn().mockResolvedValue("저장 완료");
    const proposeFn = vi.fn().mockImplementation(
      async (): Promise<ProposeOutcome> => ({
        proposal: {
          id: "prop-002",
          kind: "edit",
          targetPath: "/target/file.hwpx",
          stagedPath: "/staging/file.hwpx",
          summary: "테스트",
          diff: "",
          warnings: [],
        } satisfies Proposal,
        commit: commitFn,
      }),
    );

    const handler: ApprovalHandler = async () => ({
      approved: false,
      reason: "내용이 잘못됨",
    });
    registry.setApprovalHandler(handler);
    registry.setContext(ctx);

    registry.register({
      name: "propose_edit_reject",
      description: "거절 테스트",
      inputSchema: z.object({ path: z.string() }),
      requiresApproval: true,
      propose: proposeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["propose_edit_reject"]!.execute!(
      { path: "/target/file.hwpx" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    // commit이 호출되지 않아야 함
    expect(commitFn).not.toHaveBeenCalled();
    // "사용자 거절:" 접두사 포함
    expect(String(result)).toContain("사용자 거절");
    expect(String(result)).toContain("내용이 잘못됨");
  });

  it("거절 시 이유 없으면 기본 메시지 포함", async () => {
    const registry = new ToolRegistry();

    const commitFn = vi.fn();
    const proposeFn = vi.fn().mockImplementation(
      async (): Promise<ProposeOutcome> => ({
        proposal: {
          id: "prop-003",
          kind: "edit",
          targetPath: "/target/file.hwpx",
          stagedPath: "",
          summary: "",
          diff: "",
          warnings: [],
        } satisfies Proposal,
        commit: commitFn,
      }),
    );

    const handler: ApprovalHandler = async () => ({ approved: false });
    registry.setApprovalHandler(handler);
    registry.setContext(ctx);

    registry.register({
      name: "no_reason_reject",
      description: "이유 없는 거절",
      inputSchema: z.object({}),
      requiresApproval: true,
      propose: proposeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["no_reason_reject"]!.execute!(
      {},
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    expect(String(result)).toContain("사용자 거절");
    expect(commitFn).not.toHaveBeenCalled();
  });

  it("propose가 string을 반환하면 툴-레벨 오류로 처리 (handler/commit 미호출)", async () => {
    const registry = new ToolRegistry();

    const commitFn = vi.fn();
    const proposeFn = vi.fn().mockResolvedValue("오류: 파일을 찾을 수 없습니다.");

    const handler: ApprovalHandler = vi.fn().mockResolvedValue({ approved: true });
    registry.setApprovalHandler(handler);
    registry.setContext(ctx);

    registry.register({
      name: "error_propose",
      description: "오류 반환 propose",
      inputSchema: z.object({ path: z.string() }),
      requiresApproval: true,
      propose: proposeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["error_propose"]!.execute!(
      { path: "/target/file.hwpx" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    expect(String(result)).toBe("오류: 파일을 찾을 수 없습니다.");
    expect(handler).not.toHaveBeenCalled();
    expect(commitFn).not.toHaveBeenCalled();
  });

  it("approval-required 이벤트: eventEmitter가 proposal과 함께 호출됨", async () => {
    const registry = new ToolRegistry();

    const proposal: Proposal = {
      id: "prop-ev-001",
      kind: "edit",
      targetPath: "/target/file.hwpx",
      stagedPath: "/staging/file.hwpx",
      summary: "이벤트 테스트",
      diff: "",
      warnings: [],
    };

    const proposeFn = vi.fn().mockImplementation(
      async (): Promise<ProposeOutcome> => ({
        proposal,
        commit: vi.fn().mockResolvedValue("저장 완료"),
      }),
    );

    const emitterFn = vi.fn();
    const handler: ApprovalHandler = async () => ({ approved: true });

    registry.setApprovalHandler(handler);
    registry.setApprovalEventEmitter(emitterFn);
    registry.setContext(ctx);

    registry.register({
      name: "event_propose",
      description: "이벤트 테스트",
      inputSchema: z.object({ path: z.string() }),
      requiresApproval: true,
      propose: proposeFn,
    });

    const tools = registry.toAiSdkTools();
    await tools["event_propose"]!.execute!(
      { path: "/target/file.hwpx" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    expect(emitterFn).toHaveBeenCalledOnce();
    expect(emitterFn).toHaveBeenCalledWith(proposal);
  });
});

describe("register 정합성 검증", () => {
  it("requiresApproval=true인데 propose가 없으면 등록을 거부한다", async () => {
    const { ToolRegistry } = await import("./registry.js");
    const { z } = await import("zod");
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "bad_tool",
        description: "잘못된 정의",
        inputSchema: z.object({}),
        requiresApproval: true,
        execute: async () => "should never run",
      }),
    ).toThrow(/propose가 없습니다/);
  });
});
