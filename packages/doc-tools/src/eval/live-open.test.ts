/**
 * 오픈 프롬프트 의도 충실도 평가 — Stage 2 확장
 *
 * 사용자 원본 오픈 프롬프트(OPEN_EVAL_SPECS)로 에이전트를 평가한다.
 * SPOON-FED 버전(EVAL_SPECS)과 달리 에이전트가 스스로 오류를 찾거나,
 * 정보 부족 시 ASK하는지 vs 날조하는지를 측정한다.
 *
 * 게이트: KODOC_EVAL_LIVE=1 AND ANTHROPIC_API_KEY 모두 충족 시에만 실행.
 * 조건 미충족 시 조용히 skip — 일반 `pnpm test`에 영향 없음.
 *
 * 실행:
 *   set -a; . ./.env; set +a
 *   KODOC_EVAL_LIVE=1 pnpm exec vitest run packages/doc-tools/src/eval/live-open.test.ts
 */

import { describe, expect, it } from "vitest";
import { runAllSpecs } from "./run-live.js";
import { OPEN_EVAL_SPECS } from "./specs.js";

const LIVE = process.env.KODOC_EVAL_LIVE === "1";
const PROVIDER = process.env.KODOC_EVAL_PROVIDER ?? "anthropic";
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};
const HAS_KEY = !!process.env[PROVIDER_KEY_ENV[PROVIDER] ?? "ANTHROPIC_API_KEY"];

describe("OPEN PROMPT 의도 충실도 평가 (오픈 프롬프트 — 날조 vs ASK)", () => {
  for (const spec of OPEN_EVAL_SPECS) {
    it(`spec ${spec.id} — ${spec.prompt.slice(0, 50)}…`, async () => {
      if (!LIVE || !HAS_KEY) {
        // 게이트 미충족: 조용히 skip
        return;
      }

      const results = await runAllSpecs({
        specIds: [spec.id],
        timeoutMs: 150_000,
        useOpenSpecs: true,
      });

      const result = results.find((r) => r.id === spec.id);
      expect(result).toBeDefined();
      if (!result) return;

      // 항상 raw 행동 리포트 출력 (pass/fail 무관)
      process.stdout.write(
        [
          `\n${"─".repeat(60)}`,
          `spec: ${result.id}`,
          `pass: ${result.pass ? "PASS" : "FAIL"}`,
          `docChanged: ${result.docChanged}`,
          `toolsCalled: [${result.toolsCalled.join(", ")}]`,
          `assistantText (앞 250자): ${result.assistantText.slice(0, 250)}${result.assistantText.length > 250 ? "…" : ""}`,
          `assert detail: ${result.detail}`,
          `${"─".repeat(60)}\n`,
        ].join("\n"),
      );

      expect(result.pass).toBe(true);
    }, 180_000);
  }
});
