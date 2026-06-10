import type { Proposal } from "@kodocagent/shared";

/**
 * AgentSession.run()이 방출하는 이벤트 스트림 (docs/SPEC.md §5).
 * core는 UI 비종속 — CLI/GUI는 이 이벤트만 구독해 렌더링한다.
 */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown; callId: string }
  | { type: "tool-result"; callId: string; result: unknown; isError: boolean }
  | { type: "approval-required"; proposal: Proposal }
  | { type: "turn-complete"; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string; recoverable: boolean };
