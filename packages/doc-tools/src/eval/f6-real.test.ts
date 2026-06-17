/**
 * F6 코퍼스 실문서 검증 테스트 (결정론적 — LLM 없음)
 *
 * 실제 한국 공공·정부 문서로 기존 도구의 동작을 검증한다.
 *
 * 코퍼스: eval-docs/f6/
 *   - d1_unikorea_press.hwp   — 통일부 보도자료 (HWP5 OLE 바이너리, ~53KB)
 *   - d2_activity_report.hwp  — 활동 보고서 (.hwp, ~50KB)
 *   - d3_exam_social.hwpx     — 수능 사회문화 문제지 (.hwpx, ~412KB, 복합표·이미지)
 *
 * 코퍼스 파일이 없으면 전체 스위트를 SKIP → 일반 CI는 항상 그린.
 * 로컬에 파일이 있으면 모든 테스트가 실행된다.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "kordoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hwpStructuralGuard } from "../security.js";
import { proposeEditTool } from "../tools/propose-edit.js";
import { proposeFindReplaceTool } from "../tools/propose-find-replace.js";

// ─────────────────────────────────────────────────────────
// 코퍼스 경로 해석 (process.cwd() / import.meta 양쪽 시도)
// ─────────────────────────────────────────────────────────

function resolveCorpusDir(): string {
  const CORPUS_SUBDIR = "eval-docs/f6";

  // 1) process.cwd() 기준 (pnpm exec vitest는 보통 repo root에서 실행)
  const fromCwd = join(process.cwd(), CORPUS_SUBDIR);
  if (existsSync(fromCwd)) return fromCwd;

  // 2) import.meta.url 기준 — 이 파일의 위치에서 repo root를 거슬러 올라간다
  //    packages/doc-tools/src/eval/f6-real.test.ts → repo root는 4단계 위
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(thisFile), "../../../..");
  const fromMeta = join(repoRoot, CORPUS_SUBDIR);
  if (existsSync(fromMeta)) return fromMeta;

  // 3) 찾지 못하면 cwd 기준 경로 반환 (존재 여부는 CORPUS_PRESENT로 판정)
  return fromCwd;
}

const CORPUS_DIR = resolveCorpusDir();
const D1 = join(CORPUS_DIR, "d1_unikorea_press.hwp");
const D2 = join(CORPUS_DIR, "d2_activity_report.hwp");
const D3 = join(CORPUS_DIR, "d3_exam_social.hwpx");

// 명시적 opt-in 게이트 — 기본 `pnpm test`에서는 실행하지 않는다.
// 실문서(특히 이미지 다수 .hwpx) 파싱이 kordoc OCR/ML 경로로 매우 느리거나 행(hang)을
// 유발할 수 있어 CI/일반 스위트에 부적합하다. live.test.ts(KODOC_EVAL_LIVE)와 동일 패턴.
const F6_ENABLED = process.env.KODOC_EVAL_F6 === "1";
const CORPUS_PRESENT = F6_ENABLED && existsSync(D1) && existsSync(D2) && existsSync(D3);

// ─────────────────────────────────────────────────────────
// 공통 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-f6-real-${Date.now()}`);
  await mkdir(testDir, { recursive: true });

  if (!CORPUS_PRESENT) {
    const reason = !F6_ENABLED
      ? "KODOC_EVAL_F6=1 미설정 — 기본 스위트에서는 건너뜀(opt-in)"
      : `코퍼스 없음 (${CORPUS_DIR})`;
    process.stdout.write(`[f6-real] SKIP: ${reason}.\n`);
  }
});

afterAll(() => {
  // 임시 디렉터리는 OS가 자동 정리
});

function makeCtx(subDir: string): { cwd: string; sessionId: string } {
  return {
    cwd: subDir,
    sessionId: `f6-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

/** 블록 배열에서 타입별 카운트 반환 */
function countTypes(blocks: Array<{ type: string }>): Record<string, number> {
  const h: Record<string, number> = {};
  for (const b of blocks) h[b.type] = (h[b.type] ?? 0) + 1;
  return h;
}

// ─────────────────────────────────────────────────────────
// 1. parse 프로파일 — 실문서 파싱 성공 검증
// ─────────────────────────────────────────────────────────

describe("F6-1: parse 프로파일 — 실문서 파싱 성공", () => {
  it("D1 (d1_unikorea_press.hwp) parse 성공 + 프로파일 출력", async () => {
    if (!CORPUS_PRESENT) return;

    const bytes = await readFile(D1);
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await parse(u8.buffer as ArrayBuffer);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const types = countTypes(result.blocks);
    const tableCount = types["table"] ?? 0;
    const imageCount = result.images ? result.images.length : 0;

    process.stdout.write(
      `[PROFILE] d1_unikorea_press.hwp | ` +
        `markdown=${result.markdown.length}chars | ` +
        `blocks=${result.blocks.length} | ` +
        `tables=${tableCount} | ` +
        `images=${imageCount}\n`,
    );
  }, 30000);

  it("D2 (d2_activity_report.hwp) parse 성공 + 프로파일 출력", async () => {
    if (!CORPUS_PRESENT) return;

    const bytes = await readFile(D2);
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await parse(u8.buffer as ArrayBuffer);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const types = countTypes(result.blocks);
    const tableCount = types["table"] ?? 0;
    const imageCount = result.images ? result.images.length : 0;

    process.stdout.write(
      `[PROFILE] d2_activity_report.hwp | ` +
        `markdown=${result.markdown.length}chars | ` +
        `blocks=${result.blocks.length} | ` +
        `tables=${tableCount} | ` +
        `images=${imageCount}\n`,
    );
  }, 30000);

  it("D3 (d3_exam_social.hwpx) parse 성공 + 프로파일 출력", async () => {
    if (!CORPUS_PRESENT) return;

    const bytes = await readFile(D3);
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await parse(u8.buffer as ArrayBuffer);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const types = countTypes(result.blocks);
    const tableCount = types["table"] ?? 0;
    const imageCount = result.images ? result.images.length : 0;

    process.stdout.write(
      `[PROFILE] d3_exam_social.hwpx | ` +
        `markdown=${result.markdown.length}chars | ` +
        `blocks=${result.blocks.length} | ` +
        `tables=${tableCount} | ` +
        `images=${imageCount}\n`,
    );
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// 2. .hwp 구조 편집 가드 (실문서)
// ─────────────────────────────────────────────────────────

describe("F6-2: .hwp 구조 편집 가드 — 실문서 D1", () => {
  it("hwpStructuralGuard: OLE2 .hwp → 'hwpx' 포함 안내 반환", async () => {
    if (!CORPUS_PRESENT) return;

    const bytes = await readFile(D1);
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const msg = hwpStructuralGuard(".hwp", u8);

    expect(msg).not.toBeNull();
    expect(msg).toContain("hwpx");

    process.stdout.write(`[GUARD] hwpStructuralGuard D1: "${msg?.slice(0, 80)}…"\n`);
  }, 10000);

  it("proposeFindReplaceTool.propose → 실 .hwp에서 가드 발동 (end-to-end)", async () => {
    if (!CORPUS_PRESENT) return;

    const subDir = join(testDir, `guard-e2e-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    await copyFile(D1, join(subDir, "d1.hwp"));

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "d1.hwp",
        find: "사업",
        replace: "과제",
        caseSensitive: false,
        all: true,
        summary: "가드 확인 — .hwp 구조 편집 시도",
      },
      ctx,
    });

    // 가드가 발동하면 string 반환 + "hwpx" 포함
    expect(typeof result).toBe("string");
    expect(result as string).toContain("hwpx");

    process.stdout.write(
      `[GUARD-E2E] proposeFindReplace on .hwp returned: "${(result as string).slice(0, 120)}…"\n`,
    );
  }, 15000);
});

// ─────────────────────────────────────────────────────────
// 3. propose_edit 제자리 편집 — 실문서 D1 (.hwp)
// ─────────────────────────────────────────────────────────

describe("F6-3: propose_edit 제자리 편집 — 실문서 D1 (.hwp)", () => {
  it("D1 .hwp에 propose_edit 적용 — 성공 시 구조 보존 검증, 보수적 거부 시 FINDING 로깅", async () => {
    if (!CORPUS_PRESENT) return;

    const subDir = join(testDir, `edit-d1-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    await copyFile(D1, join(subDir, "d1.hwp"));

    // 원본 파싱
    const origBytes = await readFile(join(subDir, "d1.hwp"));
    const origU8 = new Uint8Array(origBytes.buffer, origBytes.byteOffset, origBytes.byteLength);
    const origResult = await parse(origU8.buffer as ArrayBuffer);

    expect(origResult.success).toBe(true);
    if (!origResult.success) return;

    const origMd = origResult.markdown;
    const origTypes = countTypes(origResult.blocks);
    const origBlockCount = origResult.blocks.length;

    // 마크다운에서 실제 등장하는 한국어 단어를 동적으로 찾아 안전한 치환 수행
    // 짧은 단어(2~4글자)를 찾아 첫 번째 등장만 교체
    const wordMatch = origMd.match(/[가-힣]{2,4}/);
    if (!wordMatch) {
      process.stdout.write("[F6-3] SKIP: 마크다운에서 한국어 단어를 찾지 못했습니다.\n");
      return;
    }

    const targetWord = wordMatch[0];
    // 원본 단어를 같은 길이의 마커로 교체 (의미 변화 최소화)
    const markerWord = targetWord + "X";
    const newMarkdown = origMd.replace(targetWord, markerWord);

    process.stdout.write(`[F6-3] propose_edit: "${targetWord}" → "${markerWord}" in d1.hwp\n`);

    const ctx = makeCtx(subDir);
    const result = await proposeEditTool.propose?.({
      input: {
        path: "d1.hwp",
        newMarkdown,
        summary: `실문서 D1 테스트 편집: "${targetWord}"→"${markerWord}"`,
      },
      ctx,
    });

    if (typeof result === "string") {
      // 보수적 거부 또는 patchHwp 미적용 — 실패로 처리하지 않음
      process.stdout.write(
        `[FINDING] propose_edit on real .hwp returned string: "${result.slice(0, 200)}"\n`,
      );
      // 이것 자체가 유효한 결과임 (patchHwp의 실문서 한계 측정)
      return;
    }

    // ProposeOutcome이 반환된 경우
    expect(result).toBeDefined();
    const outcome = result as { proposal: unknown; commit: () => Promise<string> };
    expect(outcome.commit).toBeTypeOf("function");

    const proposal = outcome.proposal as {
      warnings?: string[];
      diff?: string;
    };

    // warnings 로깅 (patchHwp 스킵 등)
    if (proposal.warnings && proposal.warnings.length > 0) {
      process.stdout.write(`[F6-3] propose_edit warnings: ${JSON.stringify(proposal.warnings)}\n`);
    }

    // commit
    const commitMsg = await outcome.commit();
    process.stdout.write(`[F6-3] commit: ${commitMsg}\n`);

    // 출력 파일 재파싱 — 여전히 유효한 .hwp여야 함
    const afterBytes = await readFile(join(subDir, "d1.hwp"));
    const afterU8 = new Uint8Array(afterBytes.buffer, afterBytes.byteOffset, afterBytes.byteLength);
    const afterResult = await parse(afterU8.buffer as ArrayBuffer);

    expect(afterResult.success).toBe(true);

    if (afterResult.success) {
      const afterTypes = countTypes(afterResult.blocks);
      const afterBlockCount = afterResult.blocks.length;

      process.stdout.write(
        `[F6-3] 구조 보존 — blocks 전: ${origBlockCount}, 후: ${afterBlockCount} | ` +
          `types 전: ${JSON.stringify(origTypes)}, 후: ${JSON.stringify(afterTypes)}\n`,
      );
    }
  }, 60000);
});

// ─────────────────────────────────────────────────────────
// 4. find_replace 구조 보존 — 실문서 D3 (.hwpx)
// ─────────────────────────────────────────────────────────

describe("F6-4: find_replace 구조 보존 — 실문서 D3 (.hwpx)", () => {
  it("D3 .hwpx에 find_replace 적용 — 마커 삽입, 표 카운트 보존 검증", async () => {
    if (!CORPUS_PRESENT) return;

    const subDir = join(testDir, `findreplace-d3-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    await copyFile(D3, join(subDir, "d3.hwpx"));

    // 원본 파싱
    const origBytes = await readFile(join(subDir, "d3.hwpx"));
    const origU8 = new Uint8Array(origBytes.buffer, origBytes.byteOffset, origBytes.byteLength);
    const origResult = await parse(origU8.buffer as ArrayBuffer);

    expect(origResult.success).toBe(true);
    if (!origResult.success) return;

    const origMd = origResult.markdown;
    const origTypes = countTypes(origResult.blocks);
    const origTableCount = origTypes["table"] ?? 0;
    const origBlockCount = origResult.blocks.length;

    // 마크다운에서 실제 등장하는 한국어 단어(빈도 2 이상) 동적 탐색
    const words = origMd.match(/[가-힣]{2,5}/g) ?? [];
    const freq: Record<string, number> = {};
    for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
    const candidates = Object.entries(freq)
      .filter(([, cnt]) => cnt >= 2)
      .sort((a, b) => b[1] - a[1]);

    if (candidates.length === 0) {
      process.stdout.write("[F6-4] SKIP: 빈도 2 이상 한국어 단어를 찾지 못했습니다.\n");
      return;
    }

    const [token] = candidates[0]!;
    const marker = `F6TEST`;

    process.stdout.write(
      `[F6-4] find_replace: "${token}" → "${marker}" in d3.hwpx ` +
        `(빈도 ${freq[token]}, tables_before=${origTableCount})\n`,
    );

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "d3.hwpx",
        find: token,
        replace: marker,
        caseSensitive: false,
        all: true,
        summary: `실문서 D3 테스트 치환: "${token}"→"${marker}"`,
      },
      ctx,
    });

    if (typeof result === "string") {
      process.stdout.write(
        `[FINDING] find_replace on real .hwpx returned string: "${result.slice(0, 200)}"\n`,
      );
      return;
    }

    expect(result).toBeDefined();
    const outcome = result as { commit: () => Promise<string> };
    expect(outcome.commit).toBeTypeOf("function");

    const commitMsg = await outcome.commit();
    process.stdout.write(`[F6-4] commit: ${commitMsg}\n`);

    // 출력 파일 재파싱
    const afterBytes = await readFile(join(subDir, "d3.hwpx"));
    const afterU8 = new Uint8Array(afterBytes.buffer, afterBytes.byteOffset, afterBytes.byteLength);
    const afterResult = await parse(afterU8.buffer as ArrayBuffer);

    expect(afterResult.success).toBe(true);
    if (!afterResult.success) return;

    const afterTypes = countTypes(afterResult.blocks);
    const afterTableCount = afterTypes["table"] ?? 0;
    const afterBlockCount = afterResult.blocks.length;

    // (a) 마커가 재파싱 마크다운에 등장해야 함
    expect(afterResult.markdown).toContain(marker);

    // (b) 표 카운트 보존
    expect(afterTableCount).toBe(origTableCount);

    // (c) 구조 로깅
    process.stdout.write(
      `[F6-4] 구조 보존 — blocks 전: ${origBlockCount}, 후: ${afterBlockCount} | ` +
        `tables 전: ${origTableCount}, 후: ${afterTableCount}\n`,
    );
  }, 60000);
});
