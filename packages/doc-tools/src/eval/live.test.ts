/**
 * 문서 편집 검증 하네스 — Stage 2: 실모델 에이전트 통합 테스트
 *
 * KODOC_EVAL_LIVE=1 AND ANTHROPIC_API_KEY 두 조건이 모두 충족될 때만 실행된다.
 * 조건 미충족 시 skip — 일반 `pnpm test`에 영향 없음.
 *
 * 실행:
 *   KODOC_EVAL_LIVE=1 ANTHROPIC_API_KEY=sk-... pnpm test
 *   (또는 repo-root .env에 키 있고 set -a; . ./.env; set +a 후 실행)
 */

import { describe, expect, it } from "vitest";
import { runAllSpecs } from "./run-live.js";
import { EVAL_SPECS } from "./specs.js";

const LIVE = process.env.KODOC_EVAL_LIVE === "1";
const PROVIDER = process.env.KODOC_EVAL_PROVIDER ?? "anthropic";
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};
const HAS_KEY = !!process.env[PROVIDER_KEY_ENV[PROVIDER] ?? "ANTHROPIC_API_KEY"];

describe("Stage 2 — 실모델 에이전트 평가", () => {
  for (const spec of EVAL_SPECS) {
    it(`spec ${spec.id} — ${spec.prompt.slice(0, 40)}…`, async () => {
      if (!LIVE || !HAS_KEY) {
        // 조건 미충족: 테스트를 조용히 스킵
        return;
      }

      const results = await runAllSpecs({
        specIds: [spec.id],
        timeoutMs: 150_000,
      });

      const result = results.find((r) => r.id === spec.id);
      expect(result).toBeDefined();
      expect(result?.pass).toBe(true);
    }, 180_000); // vitest per-test timeout (30s 여유)
  }
});
