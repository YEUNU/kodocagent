/**
 * 문서 편집 검증 하네스 — Stage 2: 실모델 에이전트 평가 실행기
 *
 * KODOC_EVAL_LIVE=1 환경변수 없이 실행하면 즉시 스킵 메시지를 출력하고 종료한다.
 * ANTHROPIC_API_KEY는 repo-root .env에서 환경변수로 주입해 사용한다.
 *
 * 사용:
 *   set -a; . ./.env; set +a
 *   KODOC_EVAL_LIVE=1 pnpm --filter @kodocagent/doc-tools exec tsx src/eval/run-live.ts
 *   (또는 빌드 후 node packages/doc-tools/dist/eval/run-live.js)
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, createModel, SessionStore, ToolRegistry } from "@kodocagent/core";
import type { ApprovalResult } from "@kodocagent/shared";
import { KodocConfigSchema } from "@kodocagent/shared";
import { parse } from "kordoc";
import { createDocTools } from "../index.js";
import { makeF1, makeF2, makeF3, makeF4, makeF5Hwpx } from "./fixtures.js";
import { EVAL_SPECS, type EvalSpec, HARD_EVAL_SPECS, OPEN_EVAL_SPECS } from "./specs.js";

// ─────────────────────────────────────────────────────────
// 픽스처 이름 매핑
// ─────────────────────────────────────────────────────────

type FixtureMaker = () => Promise<{ ext: ".hwpx" | ".md"; bytes: Uint8Array }>;

const FIXTURE_MAKERS: Record<string, FixtureMaker> = {
  F1: makeF1,
  F2: makeF2,
  F3: makeF3,
  F4: makeF4,
  F5: makeF5Hwpx,
};

/** 파일명 (파일 시스템에 쓰는 구체적 이름) */
const FILE_NAMES: Record<string, string> = {
  F1: "report.hwpx",
  F2: "budget.hwpx",
  F3: "form.hwpx",
  F4: "formobj.hwpx",
  F5: "notice.hwpx",
};

// ─────────────────────────────────────────────────────────
// 자동 승인 핸들러
// ─────────────────────────────────────────────────────────

async function autoApprove(): Promise<ApprovalResult> {
  return { approved: true };
}

// ─────────────────────────────────────────────────────────
// 모델 선택 (env로 파라미터화 — 멀티 프로바이더 교차 검증)
// ─────────────────────────────────────────────────────────

type EvalProvider = "anthropic" | "openai" | "google";

const DEFAULT_MODELS: Record<EvalProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  google: "gemini-3.5-flash",
};

/**
 * KODOC_EVAL_PROVIDER / KODOC_EVAL_MODEL 환경변수로 평가 모델을 결정한다.
 * 기본값은 anthropic / claude-sonnet-4-6.
 * 키는 각 프로바이더의 표준 환경변수에서 읽는다(openai는 OPENAI_API_KEY).
 */
function resolveEvalModel(): {
  provider: EvalProvider;
  model: string;
  apiKeys: { anthropic: string | null; openai: string | null; google: string | null };
} {
  const provider = (process.env.KODOC_EVAL_PROVIDER as EvalProvider) || "anthropic";
  const model = process.env.KODOC_EVAL_MODEL || DEFAULT_MODELS[provider];
  return {
    provider,
    model,
    apiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY ?? null,
      openai: process.env.OPENAI_API_KEY ?? null,
      google: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────
// 단일 spec 실행
// ─────────────────────────────────────────────────────────

interface RunResult {
  id: string;
  pass: boolean;
  detail: string;
  toolsCalled: string[];
  durationMs: number;
  /** 에이전트가 생성한 자연어 응답 전체 */
  assistantText: string;
  /** 원본 fixture markdown vs 최종 편집 후 markdown 비교 결과 */
  docChanged: boolean;
  error?: string;
}

async function runSpec(spec: EvalSpec, timeoutMs: number): Promise<RunResult> {
  const startMs = Date.now();
  const toolsCalled: string[] = [];
  let assistantText = "";

  // 임시 디렉토리 — KODOCAGENT_HOME 도 격리
  const cwd = await mkdtemp(join(tmpdir(), "kodoc-eval-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "kodoc-eval-home-"));
  process.env.KODOCAGENT_HOME = fakeHome;

  try {
    // 1. 픽스처 생성 및 파일 쓰기
    const fixtureMaker = FIXTURE_MAKERS[spec.fixture];
    if (!fixtureMaker) {
      throw new Error(`픽스처 메이커가 없습니다: ${spec.fixture}`);
    }
    const fileName = FILE_NAMES[spec.fixture];
    if (!fileName) {
      throw new Error(`파일 이름 매핑이 없습니다: ${spec.fixture}`);
    }
    const fixture = await fixtureMaker();
    const filePath = join(cwd, fileName);
    await writeFile(filePath, fixture.bytes);

    // 2. AgentSession 구성 (CLI chat.ts 패턴 미러) — provider/model은 env로 파라미터화
    const { provider, model: modelId, apiKeys } = resolveEvalModel();
    const config = KodocConfigSchema.parse({
      provider,
      model: modelId,
      apiKeys,
      maxSteps: 16,
      maxContextTokens: 120000,
    });

    const model = createModel(config);

    const tools = new ToolRegistry();
    for (const tool of createDocTools({ cwd })) {
      tools.register(tool as import("@kodocagent/core").ToolDefinition<unknown>);
    }

    const store = await SessionStore.create({
      cwd,
      provider,
      model: modelId,
      createdAt: new Date().toISOString(),
    });

    const session = new AgentSession({
      config,
      model,
      tools,
      approvalHandler: autoApprove,
      store,
      cwd,
      mcpServers: [],
    });

    // 3. 프롬프트 구성: 파일 이름 앞에 명시
    const prompt = `현재 작업 폴더의 \`${fileName}\` 파일에 대해 다음을 수행하세요. ${spec.prompt}`;

    // 4. session.run() 이벤트 루프 + 타임아웃
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      for await (const event of session.run(prompt, controller.signal)) {
        if (event.type === "tool-call") {
          toolsCalled.push(event.toolName);
        } else if (event.type === "text-delta") {
          assistantText += event.text;
        } else if (event.type === "error") {
          throw new Error(`에이전트 오류: ${event.message}`);
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (controller.signal.aborted) {
      throw new Error(`타임아웃 (${timeoutMs / 1000}s 초과)`);
    }

    // 5. 원본 fixture parse → originalMarkdown
    const originalParseResult = await parse(fixture.bytes.buffer as ArrayBuffer);
    const originalMarkdown = originalParseResult.success ? originalParseResult.markdown : "";

    // 6. 편집된 파일 읽기 + parse → markdown
    const editedBytes = await readFile(filePath);
    const parseResult = await parse(editedBytes.buffer as ArrayBuffer);
    if (!parseResult.success) {
      throw new Error(`kordoc parse 실패: ${parseResult.error}`);
    }
    const markdown = parseResult.markdown;

    // 7. docChanged 비교
    const docChanged = originalMarkdown !== markdown;

    // 8. spec.assert 판정 — 새 시그니처(extra 옵션)도 지원
    const extra = { assistantText, docChanged, originalMarkdown };
    const { pass, detail } = spec.assert(markdown, extra);

    // 9. assistantText 출력 (250자 truncate)
    const textPreview = assistantText.slice(0, 250) + (assistantText.length > 250 ? "…" : "");
    if (textPreview) {
      process.stdout.write(`    assistantText: ${textPreview}\n`);
    }

    return {
      id: spec.id,
      pass,
      detail,
      toolsCalled,
      durationMs: Date.now() - startMs,
      assistantText,
      docChanged,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      id: spec.id,
      pass: false,
      detail: `실행 오류: ${error}`,
      toolsCalled,
      durationMs: Date.now() - startMs,
      assistantText,
      docChanged: false,
      error,
    };
  }
}

// ─────────────────────────────────────────────────────────
// 공개 API — index.ts의 runLiveEval이 위임한다
// ─────────────────────────────────────────────────────────

export interface SpecRunResult extends RunResult {}

export async function runAllSpecs(opts?: {
  specIds?: string[];
  timeoutMs?: number;
  /** true なら OPEN_EVAL_SPECS を使う */
  useOpenSpecs?: boolean;
  /**
   * 커스텀 스펙 배열을 직접 전달한다.
   * 이 값이 있으면 useOpenSpecs 와 무관하게 해당 배열을 사용한다.
   * HARD_EVAL_SPECS 등 별도 스펙 셋 실행에 사용한다.
   */
  specs?: EvalSpec[];
}): Promise<SpecRunResult[]> {
  const timeoutMs = opts?.timeoutMs ?? 150_000;
  const pool = opts?.specs ?? (opts?.useOpenSpecs ? OPEN_EVAL_SPECS : EVAL_SPECS);
  const selected = opts?.specIds ? pool.filter((s) => opts.specIds?.includes(s.id)) : pool;
  // 자동 검증 불가 스펙(예: 양식 개체 값은 markdown 미노출)은 pass/fail 집계에서 제외
  const specs = selected.filter((s) => {
    if (s.autoVerifiable === false) {
      process.stdout.write(
        `  → [${s.id}] 건너뜀 — markdown 자동 검증 불가(수동/list_form_objects 필요)\n`,
      );
      return false;
    }
    return true;
  });

  const results: SpecRunResult[] = [];
  for (const spec of specs) {
    process.stdout.write(`  → [${spec.id}] 실행 중…\n`);
    const result = await runSpec(spec, timeoutMs);
    results.push(result);
    const mark = result.pass ? "✅ PASS" : "❌ FAIL";
    process.stdout.write(
      `    ${mark}  tools=[${result.toolsCalled.join(",")}]  ${result.detail}\n`,
    );
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// CLI 진입점 (tsx로 직접 실행 시)
// ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env.KODOC_EVAL_LIVE !== "1") {
    process.stdout.write("live eval skipped — set KODOC_EVAL_LIVE=1\n");
    process.exit(0);
  }

  const { provider, model: modelId, apiKeys } = resolveEvalModel();
  if (!apiKeys[provider]) {
    process.stderr.write(`오류: ${provider} API 키 환경변수가 없습니다.\n`);
    process.exit(1);
  }

  process.stdout.write("=== KODOC LIVE EVAL (Stage 2) ===\n");
  process.stdout.write(`모델: ${provider}/${modelId}\n`);
  process.stdout.write(`스펙 수: ${EVAL_SPECS.length}\n\n`);

  const results = await runAllSpecs();

  // 결과 테이블
  process.stdout.write("\n─────────────────────────────────────────────────────\n");
  process.stdout.write(
    `${"id".padEnd(6)} ${"pass".padEnd(6)} ${"docChanged".padEnd(12)} ${"tools".padEnd(40)} ${"detail"}\n`,
  );
  process.stdout.write("─────────────────────────────────────────────────────\n");

  for (const r of results) {
    const mark = r.pass ? "✅" : "❌";
    const tools = r.toolsCalled.join(",") || "(없음)";
    const toolsTrunc = tools.length > 38 ? `${tools.slice(0, 35)}…` : tools;
    const changed = r.docChanged ? "변경됨" : "변경없음";
    process.stdout.write(
      `${r.id.padEnd(6)} ${mark}      ${changed.padEnd(12)} ${toolsTrunc.padEnd(40)} ${r.detail}\n`,
    );
  }

  process.stdout.write("─────────────────────────────────────────────────────\n");
  const passed = results.filter((r) => r.pass).length;
  process.stdout.write(`합계: ${passed}/${results.length} PASS\n\n`);

  // 실패 분석
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    process.stdout.write("[ 실패 분석 ]\n");
    for (const r of failed) {
      process.stdout.write(`  ${r.id}: ${r.error ?? r.detail}\n`);
    }
    process.stdout.write("\n");
  }
}

// ES 모듈 진입점 감지
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith("run-live.ts") ||
    process.argv[1].endsWith("run-live.js"));

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`치명적 오류: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
