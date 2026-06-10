/**
 * doc-tools 내부 공통 타입
 *
 * @kodocagent/core의 ToolDefinition/ToolContext/ProposeOutcome과 동일한 구조
 * (순환 의존 방지: doc-tools → core 금지)
 */
import type { Proposal } from "@kodocagent/shared";
import type { z } from "zod";

export interface ToolContext {
  cwd: string;
  sessionId: string;
}

/** propose 결과: Proposal + commit 함수 */
export interface ProposeOutcome {
  proposal: Proposal;
  /** 백업 + 원자적 쓰기; 한국어 성공 메시지 반환 */
  commit: () => Promise<string>;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  /** requiresApproval: true ⇔ propose 존재 */
  requiresApproval: boolean;
  /** 일반 툴 실행 함수 (requiresApproval=false인 경우) */
  execute?: (opts: { input: TInput; signal?: AbortSignal; ctx: ToolContext }) => Promise<string>;
  /**
   * 두 단계 승인 게이트용 제안 함수 (requiresApproval=true인 경우).
   * string을 반환하면 툴-레벨 오류.
   */
  propose?: (opts: {
    input: TInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => Promise<ProposeOutcome | string>;
}
