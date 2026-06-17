/**
 * 아티팩트 산출 하네스 — 실모델로 편집 스펙을 실행하고
 * 편집 전/후 실제 문서 파일을 `eval-out/`에 보존한다.
 *
 * 목적: 산출된 .hwp/.hwpx 파일을 **실제 한컴오피스 뷰어에서 열어** 손상 없이
 *       열리는지(맥 제어) 외부 검증하기 위함. 자동 단언과 별개의 end-to-end 확인.
 *
 * 게이트: KODOC_EVAL_LIVE=1 (+ 프로바이더 키) 없으면 즉시 스킵.
 *
 * 실행:
 *   set -a; . ./.env; set +a
 *   KODOC_EVAL_LIVE=1 KODOC_EVAL_F6=1 \
 *     pnpm exec vitest run packages/doc-tools/src/eval/live-artifacts.test.ts
 *
 * 산출물: eval-out/<id>__<name>.hwpx (편집 후), eval-out/orig__<name>.hwpx (원본),
 *         eval-out/MANIFEST.json (스펙별 pass/docChanged/경로 요약)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { makeF6D1, makeF6D3 } from "./fixtures.js";
import { runSpec } from "./run-live.js";
import { EVAL_SPECS, type EvalSpec, OPEN_EVAL_SPECS } from "./specs.js";

const LIVE = process.env.KODOC_EVAL_LIVE === "1";
const F6_ENABLED = process.env.KODOC_EVAL_F6 === "1";
const PROVIDER = process.env.KODOC_EVAL_PROVIDER ?? "anthropic";
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};
const HAS_KEY = !!process.env[PROVIDER_KEY_ENV[PROVIDER] ?? "ANTHROPIC_API_KEY"];

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "../../../..");
const OUT_DIR = join(REPO_ROOT, "eval-out");

/** 실제로 문서를 편집하는(=열림 검증 대상 파일을 산출하는) 스펙만 추린다. */
const OPEN_EDIT_IDS = new Set(["#3o", "#4o", "#6o", "#28o"]);

interface ManifestRow {
  id: string;
  fixture: string;
  fileName?: string;
  docChanged: boolean;
  pass: boolean;
  detail: string;
  toolsCalled: string[];
  durationMs: number;
  editedPath?: string;
  originalPath?: string;
  error?: string;
}

/** F6 실문서 편집 스펙을 동적으로 구성한다(파싱해서 교체 가능한 단어를 찾음). */
async function buildF6Specs(): Promise<EvalSpec[]> {
  const specs: EvalSpec[] = [];
  const { parse } = await import("kordoc");

  const pickWord = (md: string): string | null => {
    const m = md.match(/[가-힣]{2,4}/);
    return m ? m[0] : null;
  };

  // F6D1 — 실 .hwp (patchHwp 제자리 편집 경로)
  const d1 = await makeF6D1();
  if (d1) {
    const r = await parse(d1.bytes.buffer as ArrayBuffer);
    const word = r.success ? pickWord(r.markdown) : null;
    if (word) {
      const marker = `${word}XYZ`;
      specs.push({
        id: "#F6D1",
        fixture: "F6D1",
        prompt: `문서에서 "${word}"를 "${marker}"로 바꿔 주세요. propose_edit 도구를 사용하세요.`,
        assert(md: string, extra) {
          const ok = md.includes(marker);
          return {
            pass: ok,
            detail: ok
              ? `APPLIED: "${word}"→"${marker}" 반영(docChanged=${extra?.docChanged})`
              : `NOT-APPLIED(보수적 skip 가능): docChanged=${extra?.docChanged}`,
          };
        },
        tier: "feasible",
      });
    }
  }

  // F6D3 — 실 .hwpx (patchHwpx 무손실 find_replace 경로, 복합 정부문서 422KB)
  const d3 = await makeF6D3();
  if (d3) {
    const r = await parse(d3.bytes.buffer as ArrayBuffer);
    const word = r.success ? pickWord(r.markdown) : null;
    if (word) {
      const marker = `${word}XYZ`;
      specs.push({
        id: "#F6D3",
        fixture: "F6D3",
        prompt: `문서 전체에서 "${word}"를 "${marker}"로 모두 바꿔 주세요. propose_find_replace 도구를 사용하세요.`,
        assert(md: string, extra) {
          const ok = md.includes(marker);
          return {
            pass: ok,
            detail: ok
              ? `APPLIED: "${word}"→"${marker}" 반영(docChanged=${extra?.docChanged})`
              : `NOT-APPLIED: docChanged=${extra?.docChanged}`,
          };
        },
        tier: "structural",
      });
    }
  }

  return specs;
}

describe("아티팩트 산출 — 실모델 편집 후 eval-out/ 보존", () => {
  it("편집 스펙 전체를 실행하고 편집 전/후 파일을 보존한다", async () => {
    if (!LIVE || !HAS_KEY) {
      process.stdout.write("live-artifacts SKIP — KODOC_EVAL_LIVE=1 + 프로바이더 키 필요\n");
      return;
    }

    await mkdir(OUT_DIR, { recursive: true });

    // 편집을 산출하는 스펙들: EVAL_SPECS 전체 + 오픈 편집 4종 (+ F6 실문서 2종)
    const openEdit = OPEN_EVAL_SPECS.filter((s) => OPEN_EDIT_IDS.has(s.id));
    const f6Specs = F6_ENABLED ? await buildF6Specs() : [];
    const specs: EvalSpec[] = [...EVAL_SPECS, ...openEdit, ...f6Specs];

    process.stdout.write(
      `\n=== 아티팩트 산출 (${PROVIDER}) — 스펙 ${specs.length}종 → ${OUT_DIR} ===\n`,
    );

    const manifest: ManifestRow[] = [];
    for (const spec of specs) {
      process.stdout.write(`  → [${spec.id}] (${spec.fixture}) 실행 중…\n`);
      const r = await runSpec(spec, 150_000, OUT_DIR);
      manifest.push({
        id: r.id,
        fixture: spec.fixture,
        fileName: r.fileName,
        docChanged: r.docChanged,
        pass: r.pass,
        detail: r.detail,
        toolsCalled: r.toolsCalled,
        durationMs: r.durationMs,
        editedPath: r.editedPath,
        originalPath: r.originalPath,
        error: r.error,
      });
      const mark = r.pass ? "✅" : r.error ? "💥" : "⚠️";
      process.stdout.write(
        `    ${mark} docChanged=${r.docChanged} tools=[${r.toolsCalled.join(",")}] ${r.detail}\n`,
      );
    }

    await writeFile(join(OUT_DIR, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

    // 요약 테이블
    process.stdout.write(`\n${"─".repeat(70)}\n`);
    process.stdout.write(`${"id".padEnd(8)} ${"changed".padEnd(8)} ${"pass".padEnd(6)} file\n`);
    process.stdout.write(`${"─".repeat(70)}\n`);
    for (const m of manifest) {
      process.stdout.write(
        `${m.id.padEnd(8)} ${(m.docChanged ? "yes" : "no").padEnd(8)} ${(m.pass ? "✅" : "❌").padEnd(6)} ${m.editedPath ? m.editedPath.replace(`${REPO_ROOT}/`, "") : "(없음)"}\n`,
      );
    }
    process.stdout.write(`${"─".repeat(70)}\n`);
    const changed = manifest.filter((m) => m.docChanged).length;
    process.stdout.write(
      `편집 반영: ${changed}/${manifest.length} · 매니페스트: eval-out/MANIFEST.json\n\n`,
    );
  }, 2_400_000);
});
