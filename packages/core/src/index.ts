/**
 * @kodocagent/core — 에이전트 코어 (M1에서 구현)
 *
 * 설계: docs/SPEC.md §3(프로바이더), §5(루프/세션)
 * - AgentSession.run(userMessage, signal): AsyncIterable<AgentEvent>
 * - 승인 게이트: requiresApproval 툴은 주입된 ApprovalHandler 승인 없이 쓰기 불가
 * - 샘플링 파라미터(temperature 등) 미설정 — Claude Opus 4.7+/Fable 5는 400 반환
 */

export type { AgentEvent } from "./agent/events.js";
