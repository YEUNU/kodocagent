/**
 * 툴 레지스트리 — 내장 툴 등록 및 AI SDK v6 툴 포맷 변환
 * docs/SPEC.md §6
 *
 * 승인 게이트: requiresApproval=true인 툴은 ApprovalHandler 승인 없이
 * 실제 실행 함수(execute)가 호출되지 않는다.
 */

import type { ApprovalHandler } from "@kodocagent/shared";
import type { ToolSet } from "ai";
import { tool } from "ai";
import type { z } from "zod";

/** 툴 실행 컨텍스트 */
export interface ToolContext {
  cwd: string;
  sessionId: string;
}

/** 툴 실행 옵션 */
export interface ToolExecuteOptions {
  input: unknown;
  signal?: AbortSignal;
  ctx: ToolContext;
}

/** 레지스트리에 등록하는 툴 정의 */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  requiresApproval: boolean;
  execute: (opts: { input: TInput; signal?: AbortSignal; ctx: ToolContext }) => Promise<string>;
}

/**
 * 툴 레지스트리 — 툴을 등록하고 AI SDK v6 포맷으로 변환한다.
 * requiresApproval=true인 툴은 ApprovalHandler 승인 없이 실행되지 않는다.
 */
export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition<unknown>> = new Map();
  private approvalHandler?: ApprovalHandler;
  private ctx?: ToolContext;

  /** ApprovalHandler 주입 */
  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  /** 실행 컨텍스트 주입 */
  setContext(ctx: ToolContext): void {
    this.ctx = ctx;
  }

  /** 툴 등록 */
  register<TInput>(def: ToolDefinition<TInput>): void {
    this.tools.set(def.name, def as ToolDefinition<unknown>);
  }

  /** 등록된 툴 이름 목록 */
  get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * AI SDK v6 ToolSet 포맷으로 변환한다.
   * requiresApproval=true인 툴은 실행 전 ApprovalHandler를 호출한다.
   * 거절 시 실제 execute를 호출하지 않고 "사용자 거절: <reason>" 문자열을 반환한다.
   */
  toAiSdkTools(): ToolSet {
    const result: ToolSet = {};
    for (const [name, def] of this.tools) {
      const ctx = this.ctx;
      const approvalHandler = this.approvalHandler;

      result[name] = tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (
          input: unknown,
          options: { abortSignal?: AbortSignal; toolCallId?: string; messages?: unknown[] },
        ) => {
          if (!ctx) {
            return "내부 오류: 툴 컨텍스트가 초기화되지 않았습니다.";
          }

          // 승인 게이트: requiresApproval=true인 툴은 ApprovalHandler 승인 필요
          if (def.requiresApproval) {
            if (!approvalHandler) {
              return "내부 오류: 승인 핸들러가 설정되지 않았습니다.";
            }
            // M1에는 실제 proposal이 없으므로 툴 이름 기반의 간단한 proposal 생성
            const proposal = {
              id: crypto.randomUUID(),
              kind: "edit" as const,
              targetPath: String(
                input && typeof input === "object" && "path" in input
                  ? (input as { path: string }).path
                  : "",
              ),
              stagedPath: "",
              summary: `툴 '${name}' 실행 요청`,
              diff: "",
              warnings: [],
            };
            const result = await approvalHandler(proposal);
            if (!result.approved) {
              const reason = result.reason ?? "사용자가 거절했습니다";
              return `사용자 거절: ${reason}`;
            }
          }

          return def.execute({
            input: input as Parameters<typeof def.execute>[0]["input"],
            signal: options.abortSignal,
            ctx,
          });
        },
      });
    }
    return result;
  }
}
