/**
 * export_document 실모델 e2e 평가 — 신규 도구 검증
 *
 * 에이전트가 "문서를 HTML로 내보내 줘" 요청을 받고 export_document 도구를
 * 올바르게 호출하는지(스키마가 agent-drivable 한지) 확인한다.
 *
 * 게이트: KODOC_EVAL_LIVE=1 AND 프로바이더 키. 미충족 시 조용히 skip.
 *
 * 실행(OpenAI):
 *   set -a; . ./.env; set +a
 *   OPENAI_API_KEY=$GPT_API_KEY KODOC_EVAL_LIVE=1 KODOC_EVAL_PROVIDER=openai \
 *     KODOC_EVAL_MODEL=gpt-5.4 pnpm exec vitest run \
 *     packages/doc-tools/src/eval/live-export.test.ts
 */

import { describe, expect, it } from "vitest";
import { runAllSpecs } from "./run-live.js";
import type { EvalSpec } from "./specs.js";

const LIVE = process.env.KODOC_EVAL_LIVE === "1";
const PROVIDER = process.env.KODOC_EVAL_PROVIDER ?? "anthropic";
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};
const HAS_KEY = !!process.env[PROVIDER_KEY_ENV[PROVIDER] ?? "ANTHROPIC_API_KEY"];

const EXPORT_SPEC: EvalSpec = {
  id: "#EXP",
  fixture: "F1",
  prompt:
    "작업 폴더의 report.hwpx 문서를 HTML로 내보내 주세요. " +
    "출력 파일 이름은 report.html 입니다. export_document 도구를 사용하세요.",
  assert(_md: string, extra?: { toolsCalled?: string[] }) {
    const called = extra?.toolsCalled ?? [];
    if (!called.includes("export_document")) {
      return {
        pass: false,
        detail: `export_document 미호출. 호출된 도구: [${called.join(", ")}]`,
      };
    }
    return { pass: true, detail: `export_document 호출 확인. 도구: [${called.join(", ")}]` };
  },
};

describe("export_document 실모델 e2e", () => {
  it("에이전트가 export_document 를 호출해 HTML 로 내보낸다", async () => {
    if (!LIVE || !HAS_KEY) return; // 게이트 미충족: 조용히 skip

    const results = await runAllSpecs({ specs: [EXPORT_SPEC], timeoutMs: 150_000 });
    const result = results.find((r) => r.id === "#EXP");
    expect(result).toBeDefined();
    if (!result) return;

    process.stdout.write(
      [
        `\n${"─".repeat(60)}`,
        `spec: ${result.id}`,
        `pass: ${result.pass ? "PASS" : "FAIL"}`,
        `toolsCalled: [${result.toolsCalled.join(", ")}]`,
        `assistantText (앞 250자): ${result.assistantText.slice(0, 250)}`,
        `assert detail: ${result.detail}`,
        `${"─".repeat(60)}\n`,
      ].join("\n"),
    );

    expect(result.pass).toBe(true);
  }, 180_000);
});
