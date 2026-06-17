/**
 * 문서 편집 검증 하네스 — eval 패키지 진입점
 *
 * Stage 1: 합성 픽스처 + 순수 assert 함수 (결정론적, 모델 미사용)
 * Stage 2: 실모델 에이전트 루프 실행 (KODOC_EVAL_LIVE=1 필요) — 미구현
 *
 * TODO(Stage 2): runLiveEval 구현
 *  - KODOC_EVAL_LIVE=1 환경변수 확인
 *  - 각 spec의 fixture 생성 → 임시 디렉토리에 저장
 *  - 실제 에이전트에 prompt 전달 → 편집 실행
 *  - 결과 문서를 kordoc parse().markdown으로 추출
 *  - spec.assert(markdown) 판정
 *  - 결과 리포트 반환
 */

export type { Fixture } from "./fixtures.js";
export { FIXTURE_MARKDOWN, makeF1, makeF2, makeF5Hwpx, makeF5Md } from "./fixtures.js";
export type { EvalSpec } from "./specs.js";
export { EVAL_SPECS } from "./specs.js";

// ─────────────────────────────────────────────────────────
// Stage 2 스텁 — 실모델 에이전트 평가 (미구현)
// ─────────────────────────────────────────────────────────

export interface LiveEvalResult {
  specId: string;
  pass: boolean;
  detail: string;
  durationMs: number;
}

/**
 * 실모델 에이전트로 각 spec을 평가한다.
 *
 * 활성화 조건: KODOC_EVAL_LIVE=1 환경변수
 * KODOC_EVAL_LIVE !== "1"이면 결과 배열을 비워 반환한다.
 */
export async function runLiveEval(opts?: {
  specIds?: string[];
  timeoutMs?: number;
}): Promise<LiveEvalResult[]> {
  if (process.env.KODOC_EVAL_LIVE !== "1") {
    return [];
  }
  const { runAllSpecs } = await import("./run-live.js");
  const raw = await runAllSpecs(opts);
  return raw.map((r) => ({
    specId: r.id,
    pass: r.pass,
    detail: r.detail,
    durationMs: r.durationMs,
  }));
}
