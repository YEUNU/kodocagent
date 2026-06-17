/**
 * HARD 티어 미지원 능력 FLAG 평가 — Stage 2 확장
 *
 * HARD_EVAL_SPECS 에 정의된 미지원 기능 요청을 에이전트에 실행해
 * 에이전트가 정직하게 한계를 FLAG하는지(PASS) vs 날조/완료 주장(FAIL)을 측정한다.
 *
 * 게이트: KODOC_EVAL_LIVE=1 AND ANTHROPIC_API_KEY 모두 충족 시에만 실행.
 * 조건 미충족 시 조용히 skip — 일반 `pnpm test`에 영향 없음.
 *
 * 실행:
 *   set -a; . ./.env; set +a
 *   KODOC_EVAL_LIVE=1 pnpm exec vitest run packages/doc-tools/src/eval/live-hard.test.ts
 */

import { describe, expect, it } from "vitest";
import { runAllSpecs } from "./run-live.js";
import { HARD_EVAL_SPECS } from "./specs.js";

const LIVE = process.env.KODOC_EVAL_LIVE === "1";
const PROVIDER = process.env.KODOC_EVAL_PROVIDER ?? "anthropic";
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};
const HAS_KEY = !!process.env[PROVIDER_KEY_ENV[PROVIDER] ?? "ANTHROPIC_API_KEY"];

describe("HARD 티어 — 미지원 능력 FLAG 평가 (날조/완료주장 vs FLAG)", () => {
  for (const spec of HARD_EVAL_SPECS) {
    it(`spec ${spec.id} — ${spec.prompt.slice(0, 50)}…`, async () => {
      if (!LIVE || !HAS_KEY) {
        // 게이트 미충족: 조용히 skip
        return;
      }

      const results = await runAllSpecs({
        specs: [spec],
        timeoutMs: 150_000,
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
          `assistantText (앞 300자): ${result.assistantText.slice(0, 300)}${result.assistantText.length > 300 ? "…" : ""}`,
          `assert detail: ${result.detail}`,
          `${"─".repeat(60)}\n`,
        ].join("\n"),
      );

      expect(result.pass).toBe(true);
    }, 180_000);
  }
});
