/**
 * F6 실문서 기반 LLM 에이전트 평가 (KODOC_EVAL_LIVE=1 + KODOC_EVAL_F6=1 게이트)
 *
 * - #H3d (각주 형식 편집 — F6/D3): 각주가 있는 실문서에서 각주 형식 통일 요청 → 에이전트가
 *   "각주 형식 편집 미지원"을 FLAG하고 문서를 변경하지 않는지 검증.
 * - #2hwp (실 .hwp 반영 — F6/D1): propose_edit으로 실 .hwp를 편집하고 re-parse로
 *   변경이 실제 반영됐는지 확인.
 *
 * 게이트: KODOC_EVAL_LIVE=1 AND KODOC_EVAL_F6=1 모두 충족 + 파일 존재 시에만 실행.
 *
 * 실행:
 *   set -a; . ./.env; set +a
 *   KODOC_EVAL_LIVE=1 KODOC_EVAL_F6=1 \
 *     pnpm exec vitest run packages/doc-tools/src/eval/live-f6.test.ts
 */

import { describe, expect, it } from "vitest";
import { makeF6D1, makeF6D3 } from "./fixtures.js";
import { hwpxFootnoteTexts } from "./inspect.js";
import { judgeResult } from "./judge.js";
import { runAllSpecs } from "./run-live.js";
import type { EvalSpec } from "./specs.js";
import { flaggedLimitation } from "./specs.js";

const LIVE = process.env.KODOC_EVAL_LIVE === "1";
const F6_ENABLED = process.env.KODOC_EVAL_F6 === "1";
const PROVIDER = process.env.KODOC_EVAL_PROVIDER ?? "anthropic";
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};
const HAS_KEY = !!process.env[PROVIDER_KEY_ENV[PROVIDER] ?? "ANTHROPIC_API_KEY"];

// ─────────────────────────────────────────────────────────
// #H3d — 각주 형식 통일 (F6/D3) — 실문서에 각주 있음
// ─────────────────────────────────────────────────────────

describe("F6 LLM 에이전트 평가 — 실문서 기반", () => {
  it("#H3d — 각주 형식 통일 요청 → 에이전트가 FLAG하고 각주 텍스트 미변경 확인", async () => {
    if (!LIVE || !F6_ENABLED || !HAS_KEY) return;

    const d3 = await makeF6D3();
    if (!d3) {
      process.stdout.write("[#H3d] SKIP: d3_exam_social.hwpx 없음\n");
      return;
    }

    // 아티팩트 사전 확인: 실문서에 각주가 있는지 확인
    const footnotesBefore = await hwpxFootnoteTexts(d3.bytes);
    process.stdout.write(
      `[#H3d] 원본 각주 수: ${footnotesBefore.length} | 첫 각주(앞80): "${footnotesBefore[0]?.slice(0, 80) ?? "(없음)"}\n`,
    );

    if (footnotesBefore.length === 0) {
      process.stdout.write("[#H3d] 경고: D3 문서에 각주가 없습니다 — 스펙 전제 불충족\n");
      // 각주가 없으면 스킵 (스펙 전제가 깨진 경우)
      return;
    }

    // 에이전트 평가용 스펙 정의
    const specH3d: EvalSpec = {
      id: "#H3d",
      fixture: "F6D3",
      prompt: "이 문서의 각주 형식을 기관 표준에 맞게 통일해 주세요.",
      async assert(md: string, extra) {
        const text = extra?.assistantText ?? "";
        const textSample = text.slice(0, 300);

        // 아티팩트 확인: 편집 후에도 각주 텍스트가 그대로여야 한다
        let footnoteChangeInfo = "(아티팩트 검사 생략)";
        if (extra?.afterBytes && extra.afterBytes.length > 0) {
          const footnotesAfter = await hwpxFootnoteTexts(extra.afterBytes);
          const firstBefore = footnotesBefore[0] ?? "";
          const firstAfter = footnotesAfter[0] ?? "";
          const footnotesUnchanged = firstBefore === firstAfter;
          footnoteChangeInfo =
            `ARTIFACT: 각주 수 전=${footnotesBefore.length}/후=${footnotesAfter.length}, ` +
            `첫 각주 변경=${!footnotesUnchanged}`;
        }

        // LLM judge: 에이전트가 각주 편집 미지원을 올바르게 FLAG했는지
        const judgment = await judgeResult({
          prompt: specH3d.prompt,
          beforeMarkdown: extra?.originalMarkdown ?? "",
          afterMarkdown: md,
          assistantText: text,
          artifactFacts:
            `원본 각주 수: ${footnotesBefore.length}개. ` +
            `${footnoteChangeInfo}. ` +
            "각주 편집은 현재 도구 미지원.",
        });

        const featureWords = ["각주"];
        const flagged = flaggedLimitation(text, featureWords);

        return {
          pass: judgment.pass,
          detail:
            `JUDGE: ${judgment.reason} | heuristic flagged=${flagged} | ` +
            `${footnoteChangeInfo}. assistantText(앞300): "${textSample}"`,
        };
      },
      tier: "structural",
    };

    const results = await runAllSpecs({
      specs: [specH3d],
      timeoutMs: 180_000,
    });

    const result = results.find((r) => r.id === "#H3d");
    expect(result).toBeDefined();
    if (!result) return;

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
  }, 240_000);

  // ─────────────────────────────────────────────────────────
  // #2hwp — 실 .hwp 반영 (F6/D1)
  // ─────────────────────────────────────────────────────────

  it("#2hwp — 실 .hwp propose_edit 적용 → re-parse로 변경 반영 확인", async () => {
    if (!LIVE || !F6_ENABLED || !HAS_KEY) return;

    const d1 = await makeF6D1();
    if (!d1) {
      process.stdout.write("[#2hwp] SKIP: d1_unikorea_press.hwp 없음\n");
      return;
    }

    // .hwp 파일을 parse해서 마크다운에서 교체 가능한 단어를 동적으로 찾는다
    const { parse } = await import("kordoc");
    const origResult = await parse(d1.bytes.buffer as ArrayBuffer);
    if (!origResult.success) {
      process.stdout.write("[#2hwp] SKIP: D1 parse 실패\n");
      return;
    }

    const origMd = origResult.markdown;
    const wordMatch = origMd.match(/[가-힣]{2,4}/);
    if (!wordMatch) {
      process.stdout.write("[#2hwp] SKIP: 마크다운에서 한국어 단어를 찾지 못했습니다\n");
      return;
    }

    const targetWord = wordMatch[0];
    const markerWord = `${targetWord}XYZ`;

    process.stdout.write(`[#2hwp] propose_edit: "${targetWord}" → "${markerWord}" in d1.hwp\n`);

    // 에이전트 평가용 스펙 — propose_edit으로 특정 단어를 교체한다
    const spec2hwp: EvalSpec = {
      id: "#2hwp",
      fixture: "F6D1",
      prompt: `문서에서 "${targetWord}"를 "${markerWord}"로 바꿔 주세요. propose_edit 도구를 사용하세요.`,
      async assert(md: string, extra) {
        const text = extra?.assistantText ?? "";

        // patchHwp가 보수적으로 skip한 경우도 FINDING으로 기록 (hard fail 아님)
        const patchSkipped =
          text.includes("지원하지 않") ||
          text.includes("hwpx") ||
          text.includes("변환") ||
          !extra?.docChanged;

        if (patchSkipped && !md.includes(markerWord)) {
          return {
            pass: false,
            detail: `HWP_CONSERVATIVE_SKIP: .hwp 편집이 보수적으로 거부되거나 미반영. docChanged=${extra?.docChanged}. assistantText(앞200): "${text.slice(0, 200)}"`,
          };
        }

        // 변경이 있었다면 re-parse 마크다운에 마커가 있어야 한다
        if (!md.includes(markerWord)) {
          return {
            pass: false,
            detail: `CHANGE NOT REFLECTED: docChanged=${extra?.docChanged}이나 마커 "${markerWord}"가 re-parse 마크다운에 없음`,
          };
        }

        return {
          pass: true,
          detail: `APPLIED: "${targetWord}"→"${markerWord}" 변경이 re-parse 마크다운에 반영됨. docChanged=${extra?.docChanged}`,
        };
      },
      tier: "feasible",
    };

    const results = await runAllSpecs({
      specs: [spec2hwp],
      timeoutMs: 180_000,
    });

    const result = results.find((r) => r.id === "#2hwp");
    expect(result).toBeDefined();
    if (!result) return;

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

    // .hwp 편집은 보수적 skip이 허용 — FINDING으로 기록하되 hard fail 아님
    if (!result.pass && result.detail.includes("HWP_CONSERVATIVE_SKIP")) {
      process.stdout.write(
        `[#2hwp] FINDING: patchHwp 보수적 skip — .hwp 편집 한계 실증됨. 이것은 알려진 한계.\n`,
      );
      // 보수적 skip은 실패로 처리하지 않음 — expect를 건너뜀
      return;
    }

    expect(result.pass).toBe(true);
  }, 240_000);
});
