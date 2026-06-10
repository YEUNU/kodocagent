import type { ApprovalHandler } from "@kodocagent/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";

const ctx = { cwd: "/tmp", sessionId: "test-session" };

describe("ToolRegistry 승인 게이트", () => {
  it("requiresApproval=false인 툴은 ApprovalHandler 없이 실행된다", async () => {
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

  it("requiresApproval=true이고 핸들러가 거절하면 execute가 호출되지 않는다", async () => {
    const registry = new ToolRegistry();
    const executeFn = vi.fn().mockResolvedValue("실행됨");

    const handler: ApprovalHandler = async () => ({
      approved: false,
      reason: "테스트 거절 이유",
    });

    registry.setApprovalHandler(handler);
    registry.setContext(ctx);

    registry.register({
      name: "approval_tool",
      description: "승인 필요 툴",
      inputSchema: z.object({ path: z.string() }),
      requiresApproval: true,
      execute: executeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["approval_tool"]!.execute!(
      { path: "/some/file" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    // execute가 호출되지 않아야 한다
    expect(executeFn).not.toHaveBeenCalled();
    // 결과에 "사용자 거절"이 포함되어야 한다
    expect(result).toContain("사용자 거절");
    expect(result).toContain("테스트 거절 이유");
  });

  it("requiresApproval=true이고 핸들러가 승인하면 execute가 호출된다", async () => {
    const registry = new ToolRegistry();
    const executeFn = vi.fn().mockResolvedValue("파일 수정 완료");

    const handler: ApprovalHandler = async () => ({
      approved: true,
    });

    registry.setApprovalHandler(handler);
    registry.setContext(ctx);

    registry.register({
      name: "approval_tool2",
      description: "승인 후 실행 툴",
      inputSchema: z.object({ path: z.string() }),
      requiresApproval: true,
      execute: executeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["approval_tool2"]!.execute!(
      { path: "/some/file" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    // execute가 호출되어야 한다
    expect(executeFn).toHaveBeenCalledOnce();
    expect(result).toBe("파일 수정 완료");
  });

  it("거절 결과는 '사용자 거절:' 접두사를 포함한다 (이유 없을 때)", async () => {
    const registry = new ToolRegistry();
    const executeFn = vi.fn();

    const handler: ApprovalHandler = async () => ({ approved: false });

    registry.setApprovalHandler(handler);
    registry.setContext(ctx);

    registry.register({
      name: "reject_no_reason",
      description: "이유 없이 거절",
      inputSchema: z.object({}),
      requiresApproval: true,
      execute: executeFn,
    });

    const tools = registry.toAiSdkTools();
    const result = await tools["reject_no_reason"]!.execute!(
      {},
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    expect(String(result)).toContain("사용자 거절");
    expect(executeFn).not.toHaveBeenCalled();
  });
});
