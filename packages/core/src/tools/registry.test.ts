/**
 * ToolRegistry 두 단계 승인 게이트 단위 테스트
 * docs/SPEC.md §6, §7
 *
 * 주요 검증:
 * - requiresApproval=false 툴: ApprovalHandler 없이 execute 직접 호출
 * - propose 툴 + 핸들러 승인: commit() 한 번 호출, 성공 메시지 반환
 * - propose 툴 + 핸들러 거절: commit() 미호출, 타겟 파일 무변경, 거절 메시지(+사유) 반환
 * - approval-required 이벤트: eventEmitter 콜백 호출됨
 * - propose가 string 반환: 툴-레벨 오류, handler/commit 미호출
 */

import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("propose 툴 + 핸들러 거절: commit() 미호출, 거절 메시지(+사유) 반환", async () => {
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
    // 거절 메시지 + 사유 포함
    expect(String(result)).toContain("거절");
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

    expect(String(result)).toContain("거절");
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

describe("열린 파일 경고 (OVERWRITE_KINDS)", () => {
  /** 공통 헬퍼: kind가 다른 간단한 propose 툴을 등록하고 실행한다 */
  async function runWithKind(kind: Proposal["kind"]): Promise<string> {
    const registry = new ToolRegistry();
    const proposal: Proposal = {
      id: "prop-warn-01",
      kind,
      targetPath: "/target/file.hwpx",
      stagedPath: "/staging/file.hwpx",
      summary: "테스트",
      diff: "",
      warnings: [],
    };

    registry.register({
      name: `tool_${kind}`,
      description: "경고 테스트",
      inputSchema: z.object({}),
      requiresApproval: true,
      propose: async (): Promise<ProposeOutcome> => ({
        proposal,
        commit: vi.fn().mockResolvedValue("저장 완료"),
      }),
    });

    registry.setApprovalHandler(async () => ({ approved: true }));
    registry.setContext(ctx);

    const tools = registry.toAiSdkTools();
    const result = await tools[`tool_${kind}`]!.execute!(
      {},
      { toolCallId: "tc-warn", messages: [], abortSignal: undefined },
    );
    return String(result);
  }

  it("edit kind → 열린 파일 경고가 결과에 포함된다", async () => {
    const result = await runWithKind("edit");
    expect(result).toContain("한컴오피스·한글뷰어");
  });

  it("find-replace kind → 열린 파일 경고가 결과에 포함된다", async () => {
    const result = await runWithKind("find-replace");
    expect(result).toContain("한컴오피스·한글뷰어");
  });

  it("new-document kind → 열린 파일 경고가 결과에 포함되지 않는다", async () => {
    const result = await runWithKind("new-document");
    expect(result).not.toContain("한컴오피스·한글뷰어");
  });

  it("export kind → 열린 파일 경고가 결과에 포함되지 않는다", async () => {
    const result = await runWithKind("export");
    expect(result).not.toContain("한컴오피스·한글뷰어");
  });

  it("경고가 이미 있으면 중복 추가되지 않는다", async () => {
    const OPEN_FILE_WARN =
      "이 문서가 한컴오피스·한글뷰어 등에서 열려 있다면 닫은 뒤 적용하세요. 열린 채로 적용하면 변경 내용이 화면에 바로 보이지 않거나, 프로그램에서 저장할 때 덮어써질 수 있습니다.";

    const registry = new ToolRegistry();
    const proposal: Proposal = {
      id: "prop-warn-dup",
      kind: "edit",
      targetPath: "/target/file.hwpx",
      stagedPath: "/staging/file.hwpx",
      summary: "중복 방지 테스트",
      diff: "",
      warnings: [OPEN_FILE_WARN], // 이미 경고 포함
    };

    registry.register({
      name: "tool_dup_warn",
      description: "중복 경고 테스트",
      inputSchema: z.object({}),
      requiresApproval: true,
      propose: async (): Promise<ProposeOutcome> => ({
        proposal,
        commit: vi.fn().mockResolvedValue("저장 완료"),
      }),
    });

    registry.setApprovalHandler(async () => ({ approved: true }));
    registry.setContext(ctx);

    const tools = registry.toAiSdkTools();
    await tools["tool_dup_warn"]!.execute!(
      {},
      { toolCallId: "tc-dup", messages: [], abortSignal: undefined },
    );

    // proposal.warnings에 동일 문자열이 1번만 있어야 함
    const count = proposal.warnings.filter((w) => w === OPEN_FILE_WARN).length;
    expect(count).toBe(1);
  });
});

describe("가드 A — mtime lost-update 방지", () => {
  /** 실제 임시 파일을 생성하고 sourcePath가 설정된 proposal을 반환하는 공통 셋업 */
  async function setupMtimeTest(dir: string) {
    const srcFile = join(dir, "source.hwpx");
    await writeFile(srcFile, "original content", "utf-8");

    const registry = new ToolRegistry();
    const commitFn = vi.fn().mockResolvedValue("저장 완료");

    registry.register({
      name: "mtime_test_tool",
      description: "mtime 테스트",
      inputSchema: z.object({}),
      requiresApproval: true,
      propose: async (): Promise<ProposeOutcome> => ({
        proposal: {
          id: "mtime-prop-001",
          kind: "edit",
          targetPath: srcFile,
          stagedPath: srcFile,
          summary: "테스트",
          diff: "",
          warnings: [],
          sourcePath: srcFile,
        } satisfies Proposal,
        commit: commitFn,
      }),
    });

    registry.setContext({ cwd: dir, sessionId: "test-mtime" });

    return { registry, commitFn, srcFile };
  }

  it("sourcePath의 mtime이 바뀌면 commit이 KodocError로 중단된다", async () => {
    const dir = join(tmpdir(), `mtime-test-changed-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      const { registry, commitFn, srcFile } = await setupMtimeTest(dir);

      // approval 핸들러 안에서 파일 mtime을 변경
      const handler: ApprovalHandler = async () => {
        // 1초 후 시간으로 utimes 설정 — mtime을 확실히 다르게
        const futureTime = new Date(Date.now() + 5000);
        await utimes(srcFile, futureTime, futureTime);
        return { approved: true };
      };
      registry.setApprovalHandler(handler);

      const tools = registry.toAiSdkTools();
      const result = await tools["mtime_test_tool"]!.execute!(
        {},
        { toolCallId: "tc-mtime-1", messages: [], abortSignal: undefined },
      );

      // commit이 호출되지 않아야 함
      expect(commitFn).not.toHaveBeenCalled();
      // 오류 메시지에 "변경되어" 포함
      expect(String(result)).toContain("변경되어");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sourcePath의 mtime이 바뀌지 않으면 정상 저장된다", async () => {
    const dir = join(tmpdir(), `mtime-test-ok-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      const { registry, commitFn } = await setupMtimeTest(dir);

      // 정상 승인 핸들러 (mtime 미변경)
      registry.setApprovalHandler(async () => ({ approved: true }));

      const tools = registry.toAiSdkTools();
      const result = await tools["mtime_test_tool"]!.execute!(
        {},
        { toolCallId: "tc-mtime-2", messages: [], abortSignal: undefined },
      );

      // commit이 호출되어야 함
      expect(commitFn).toHaveBeenCalledOnce();
      expect(String(result)).toContain("저장 완료");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proposal.sourceMtimeMs(read 시점 mtime)를 베이스라인으로 우선 사용해 read~stat 윈도우 외부편집을 감지한다", async () => {
    // propose 내부 read 시점과 registry stat 사이에 외부 편집이 끼어든 상황을
    // 시뮬레이션: 도구는 "read 시점"의 (옛) mtime을 sourceMtimeMs로 실어 보내지만
    // 파일의 실제 mtime은 이미 더 최신이다. stat 폴백이라면 못 잡지만,
    // sourceMtimeMs 우선 사용이면 commit 직전 재확인에서 불일치가 감지되어 중단된다.
    const dir = join(tmpdir(), `mtime-test-srcmtime-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      const srcFile = join(dir, "source.hwpx");
      await writeFile(srcFile, "original content", "utf-8");

      // 파일의 실제 mtime보다 5초 과거의 값을 read 시점 mtime으로 가정
      const staleMtimeMs = Date.now() - 5000;

      const registry = new ToolRegistry();
      const commitFn = vi.fn().mockResolvedValue("저장 완료");
      registry.register({
        name: "srcmtime_test_tool",
        description: "sourceMtimeMs 테스트",
        inputSchema: z.object({}),
        requiresApproval: true,
        propose: async (): Promise<ProposeOutcome> => ({
          proposal: {
            id: "srcmtime-prop-001",
            kind: "edit",
            targetPath: srcFile,
            stagedPath: srcFile,
            summary: "테스트",
            diff: "",
            warnings: [],
            sourcePath: srcFile,
            sourceMtimeMs: staleMtimeMs,
          } satisfies Proposal,
          commit: commitFn,
        }),
      });
      registry.setContext({ cwd: dir, sessionId: "test-srcmtime" });
      // 승인 핸들러는 파일을 건드리지 않는다 (외부 편집은 이미 read 전후에 발생한 셈)
      registry.setApprovalHandler(async () => ({ approved: true }));

      const tools = registry.toAiSdkTools();
      const result = await tools["srcmtime_test_tool"]!.execute!(
        {},
        { toolCallId: "tc-srcmtime-1", messages: [], abortSignal: undefined },
      );

      // 베이스라인(staleMtimeMs)과 파일 실제 mtime이 다르므로 commit이 중단되어야 함
      expect(commitFn).not.toHaveBeenCalled();
      expect(String(result)).toContain("변경되어");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
