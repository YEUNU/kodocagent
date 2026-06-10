/**
 * 툴 레지스트리 — 내장 툴 등록 및 AI SDK v6 툴 포맷 변환
 * docs/SPEC.md §6, §7
 *
 * 두 단계 승인 게이트:
 * - propose 있는 툴: propose() 실행(스테이징+diff) → ApprovalHandler 승인 → commit() 실행
 * - 일반 execute 툴: 승인 없이 직접 실행
 *
 * 불변 원칙: 타겟 파일에 쓰는 코드 경로는 commit() 내부에만 존재하며,
 * approved=true 결과 후에만 호출된다.
 */

import type { ApprovalHandler, Proposal } from "@kodocagent/shared";
import type { Schema, ToolSet } from "ai";
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

/** propose 결과: Proposal + commit 함수 */
export interface ProposeOutcome {
  proposal: Proposal;
  /** 백업 + 원자적 쓰기; 한국어 성공 메시지 반환 */
  commit: () => Promise<string>;
}

/** 레지스트리에 등록하는 툴 정의 — execute 또는 propose 중 하나를 가짐 */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  /** zod 스키마 또는 AI SDK jsonSchema() 반환값 모두 허용 */
  inputSchema: z.ZodType<TInput> | Schema<TInput>;
  /** requiresApproval: true ⇔ propose 존재 */
  requiresApproval: boolean;
  /** 일반 툴 실행 함수 (requiresApproval=false인 경우) */
  execute?: (opts: { input: TInput; signal?: AbortSignal; ctx: ToolContext }) => Promise<string>;
  /**
   * 두 단계 승인 게이트용 제안 함수 (requiresApproval=true인 경우).
   * 스테이징과 diff 생성이 여기서 일어난다.
   * string을 반환하면 툴-레벨 오류(승인 불필요).
   */
  propose?: (opts: {
    input: TInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => Promise<ProposeOutcome | string>;
}

/**
 * approval-required 이벤트를 세션에 전달하는 콜백.
 * core는 UI 비종속이므로 콜백을 통해 세션이 이벤트를 발행한다.
 */
export type ApprovalEventEmitter = (proposal: Proposal) => void;

/**
 * 툴 레지스트리 — 툴을 등록하고 AI SDK v6 포맷으로 변환한다.
 *
 * propose 있는 툴:
 *   1. propose() 호출 → ProposeOutcome 획득
 *   2. eventEmitter?.() 호출로 "approval-required" 이벤트 발행
 *   3. approvalHandler() 호출 → 승인/거절
 *   4. 승인 시 commit() 호출 → 성공 메시지 반환
 *   5. 거절 시 "사용자 거절: <reason>" 반환 (staged 파일 유지)
 */
export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition<unknown>> = new Map();
  private approvalHandler?: ApprovalHandler;
  private eventEmitter?: ApprovalEventEmitter;
  private ctx?: ToolContext;

  /** ApprovalHandler 주입 */
  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  /** approval-required 이벤트 발행 콜백 주입 (AgentSession이 설정) */
  setApprovalEventEmitter(emitter: ApprovalEventEmitter): void {
    this.eventEmitter = emitter;
  }

  /** 실행 컨텍스트 주입 */
  setContext(ctx: ToolContext): void {
    this.ctx = ctx;
  }

  /** 툴 등록 — requiresApproval ⇔ propose 정합성을 기계적으로 강제 */
  register<TInput>(def: ToolDefinition<TInput>): void {
    if (def.requiresApproval && !def.propose) {
      throw new Error(
        `툴 정의 오류: '${def.name}'은 requiresApproval=true이지만 propose가 없습니다. ` +
          "승인 툴은 반드시 propose(스테이징)→commit(저장) 2단계로 구현해야 합니다.",
      );
    }
    this.tools.set(def.name, def as ToolDefinition<unknown>);
  }

  /** 등록된 툴 이름 목록 */
  get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * AI SDK v6 ToolSet 포맷으로 변환한다.
   *
   * propose 있는 툴:
   *   propose() → eventEmitter() → approvalHandler() → commit() 또는 거절
   *
   * 일반 execute 툴: 직접 실행
   */
  toAiSdkTools(): ToolSet {
    const result: ToolSet = {};
    for (const [name, def] of this.tools) {
      const getCtx = () => this.ctx;
      const getApprovalHandler = () => this.approvalHandler;
      const getEventEmitter = () => this.eventEmitter;

      result[name] = tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (
          input: unknown,
          options: { abortSignal?: AbortSignal; toolCallId?: string; messages?: unknown[] },
        ) => {
          const ctx = getCtx();
          if (!ctx) {
            return "내부 오류: 툴 컨텍스트가 초기화되지 않았습니다.";
          }

          // 두 단계 승인 게이트: propose 있는 툴
          if (def.requiresApproval && def.propose) {
            const approvalHandler = getApprovalHandler();
            if (!approvalHandler) {
              return "내부 오류: 승인 핸들러가 설정되지 않았습니다.";
            }

            // 1단계: propose() — 스테이징 + diff 생성
            let outcome: ProposeOutcome | string;
            try {
              outcome = await def.propose({
                input: input as Parameters<NonNullable<typeof def.propose>>[0]["input"],
                signal: options.abortSignal,
                ctx,
              });
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return `오류: ${msg}`;
            }

            // propose가 string을 반환 = 툴-레벨 오류
            if (typeof outcome === "string") {
              return outcome;
            }

            const { proposal, commit } = outcome;

            // 2단계: approval-required 이벤트 발행 (UI용)
            getEventEmitter()?.(proposal);

            // 3단계: ApprovalHandler 호출
            const approvalResult = await approvalHandler(proposal);
            if (!approvalResult.approved) {
              const reason = approvalResult.reason ?? "사용자가 거절했습니다";
              return `사용자 거절: ${reason}`;
            }

            // 4단계: commit() — 백업 + 원자적 쓰기
            try {
              return await commit();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return `저장 오류: ${msg}`;
            }
          }

          // 일반 execute 툴 — 승인 필요 툴은 절대 이 경로로 실행되지 않는다
          if (def.execute && !def.requiresApproval) {
            return def.execute({
              input: input as Parameters<NonNullable<typeof def.execute>>[0]["input"],
              signal: options.abortSignal,
              ctx,
            });
          }

          return "내부 오류: 툴에 execute 또는 propose가 없습니다.";
        },
      });
    }
    return result;
  }
}
