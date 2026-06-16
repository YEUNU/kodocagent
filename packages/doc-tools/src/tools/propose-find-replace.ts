/**
 * propose_find_replace 툴 — rhwp 엔진을 사용한 HWP/HWPX 전체 문서 찾기·바꾸기
 *
 * @rhwp/core의 replaceAll()(전체 치환) / replaceOne()(단일 치환) API를 사용한다.
 *
 * 참고: @rhwp/core replaceAll은 표 셀(editable=0 포함) + 본문 모두 치환한다.
 *       replaceOne은 커서 기반으로 표 셀을 건너뛸 수 있으므로
 *       all:true 시에는 replaceAll을 단일 호출로 사용한다.
 *       all:false 시에는 replaceOne을 한 번 호출(첫 번째 매치만 교체).
 *
 * 내보내기 정책:
 *   - exportHwp()는 편집 내용을 저장하지 않는다 (rhwp #197).
 *   - 입력이 .hwp든 .hwpx든 항상 exportHwpx()로 내보낸다.
 *   - .hwp 입력 시 출력 경로는 staging.resolveOutputPath()가 .hwpx로 변환한다.
 *
 * 자기검증 게이트:
 *   - exportHwpx() 후 kordoc parse()로 원본/결과 마크다운을 비교한다.
 *   - 치환 대상 텍스트가 출력 마크다운에 남아 있으면 중단(오류 반환).
 *   - replace에 find가 포함되어 있으면 검증을 건너뛰고 경고만 추가한다.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "@clazic/kordoc";
import { z } from "zod";
import { loadRhwpDocument, parseReplaceAllResult } from "../rhwp-engine.js";
import { resolveSafePath } from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

export const proposeFindReplaceSchema = z.object({
  path: z.string().describe("수정할 .hwp 또는 .hwpx 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  find: z.string().min(1).describe("찾을 텍스트"),
  replace: z.string().describe("바꿀 텍스트"),
  caseSensitive: z.boolean().optional().default(false).describe("대소문자 구분 (기본값: false)"),
  all: z
    .boolean()
    .optional()
    .default(true)
    .describe("모든 항목을 교체할지 여부 (기본값: true). false이면 첫 번째 매치만 교체"),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type ProposeFindReplaceInput = z.infer<typeof proposeFindReplaceSchema>;

// ─────────────────────────────────────────────────────────
// replaceOne 결과 파싱
// ─────────────────────────────────────────────────────────

interface ReplaceOneOk {
  ok: true;
  sec: number;
  para: number;
  charOffset: number;
  newLength: number;
}
interface ReplaceOneFail {
  ok: false;
}
type ReplaceOneResult = ReplaceOneOk | ReplaceOneFail;

function parseReplaceOneResult(json: string): ReplaceOneResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`replaceOne 결과를 파싱할 수 없습니다: ${json}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    throw new Error(`replaceOne 예상하지 못한 결과: ${json}`);
  }
  const p = parsed as Record<string, unknown>;
  if (p.ok === false) return { ok: false };
  if (
    p.ok === true &&
    typeof p.sec === "number" &&
    typeof p.para === "number" &&
    typeof p.charOffset === "number" &&
    typeof p.newLength === "number"
  ) {
    return {
      ok: true,
      sec: p.sec,
      para: p.para,
      charOffset: p.charOffset,
      newLength: p.newLength,
    };
  }
  throw new Error(`replaceOne 예상하지 못한 결과 형태: ${json}`);
}

// ─────────────────────────────────────────────────────────
// 자기검증 게이트 (순수 함수, 단위 테스트 가능)
// ─────────────────────────────────────────────────────────

export interface VerifyReplacementResult {
  /** 검증 성공 여부 (skipped=true이면 항상 true) */
  ok: boolean;
  /** afterMarkdown에 남아 있는 find 발생 횟수 */
  remaining: number;
  /**
   * true이면 검증을 건너뜀 (replace가 find를 포함하므로 남은 횟수 기반 검증 불가).
   * 이 경우 ok는 항상 true.
   */
  skipped: boolean;
}

/**
 * 치환 결과가 완전히 반영되었는지 검증한다.
 *
 * 로직:
 *   1. afterMarkdown에서 find의 발생 횟수를 센다 (리터럴, 비정규식).
 *   2. caseSensitive=false이면 두 문자열 모두 소문자로 변환 후 비교.
 *   3. replace가 find를 포함하면 치환 자체가 find를 재도입하므로
 *      "남은 횟수 = 0" 조건이 의미 없다 → skipped:true, ok:true.
 *   4. 그 외: remaining === 0이면 ok:true, 아니면 ok:false.
 *
 * @param _beforeMarkdown 원본 문서 마크다운 (미사용, 확장용으로 시그니처에 포함)
 * @param afterMarkdown   exportHwpx 후 재파싱한 마크다운
 * @param find            찾을 텍스트
 * @param replace         바꿀 텍스트
 * @param caseSensitive   대소문자 구분 여부
 */
export function verifyReplacementComplete(
  _beforeMarkdown: string,
  afterMarkdown: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
): VerifyReplacementResult {
  // 비교용 문자열 준비 (caseSensitive=false이면 소문자로)
  const normAfter = caseSensitive ? afterMarkdown : afterMarkdown.toLowerCase();
  const normFind = caseSensitive ? find : find.toLowerCase();
  const normReplace = caseSensitive ? replace : replace.toLowerCase();

  // replace가 find를 포함하면 검증 불가
  if (normReplace.includes(normFind)) {
    // remaining은 참고용으로 계산 (실제 판단에는 사용 안 함)
    const remaining = countOccurrences(normAfter, normFind);
    return { ok: true, remaining, skipped: true };
  }

  // 발생 횟수 계산
  const remaining = countOccurrences(normAfter, normFind);
  return { ok: remaining === 0, remaining, skipped: false };
}

/**
 * str 안에서 sub의 발생 횟수를 리터럴 카운트한다 (겹치지 않는 발생만).
 * 정규식을 사용하지 않는다.
 */
function countOccurrences(str: string, sub: string): number {
  if (sub.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = str.indexOf(sub, pos);
    if (idx === -1) break;
    count++;
    pos = idx + sub.length;
  }
  return count;
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const proposeFindReplaceTool: ToolDefinition<ProposeFindReplaceInput> = {
  name: "propose_find_replace",
  description:
    "HWP/HWPX 문서 전체에서 텍스트를 찾아 바꿉니다. " +
    "rhwp 엔진을 사용하여 표 셀·본문·머리말·꼬리말 등 문서 전체를 대상으로 치환합니다. " +
    ".hwpx와 .hwp를 모두 지원하며, .hwp 파일은 rhwp 엔진 제약으로 .hwpx로 저장됩니다 " +
    "(exportHwp()는 편집 내용을 저장하지 않으므로 항상 .hwpx로 내보냅니다). " +
    "all:true(기본값)이면 모든 항목을 한 번에 교체하고, all:false이면 첫 번째 매치만 교체합니다. " +
    "찾을 텍스트가 없으면 파일을 수정하지 않고 오류를 반환합니다. " +
    "치환 후 자기검증 게이트로 교체가 실제 반영되었는지 확인합니다. " +
    "변경 사항은 diff 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: proposeFindReplaceSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeFindReplaceInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // 지원 확장자 검사 (.hwp, .hwpx만 허용)
    if (ext !== ".hwp" && ext !== ".hwpx") {
      return (
        `오류: propose_find_replace는 .hwp 및 .hwpx 파일만 지원합니다. ` +
        `현재 파일 확장자: ${ext}. .hwp 또는 .hwpx 파일을 지정하세요.`
      );
    }

    // 파일 읽기
    let originalBuf: Buffer;
    try {
      originalBuf = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }
    const originalBytes = new Uint8Array(
      originalBuf.buffer,
      originalBuf.byteOffset,
      originalBuf.byteLength,
    );

    // rhwp 문서 로드
    let doc: Awaited<ReturnType<typeof loadRhwpDocument>>;
    try {
      doc = await loadRhwpDocument(originalBytes);
    } catch (e) {
      return `오류: 문서를 불러오지 못했습니다. ${String(e)}`;
    }

    // 치환 실행
    let replacedCount = 0;

    if (input.all) {
      // replaceAll: 단일 호출로 모든 매치를 교체 (표 셀 포함)
      let result: ReturnType<typeof parseReplaceAllResult>;
      try {
        const raw = doc.replaceAll(input.find, input.replace, input.caseSensitive ?? false);
        result = parseReplaceAllResult(raw);
      } catch (e) {
        return `오류: 치환 중 오류가 발생했습니다. ${String(e)}`;
      }
      replacedCount = result.count;
    } else {
      // replaceOne: 첫 번째 매치만 교체
      let result: ReplaceOneResult;
      try {
        const raw = doc.replaceOne(input.find, input.replace, input.caseSensitive ?? false);
        result = parseReplaceOneResult(raw);
      } catch (e) {
        return `오류: 치환 중 오류가 발생했습니다. ${String(e)}`;
      }
      replacedCount = result.ok ? 1 : 0;
    }

    // 찾을 텍스트가 없으면 오류 반환 (파일 무수정)
    if (replacedCount === 0) {
      const caseNote = input.caseSensitive ? " (대소문자 구분)" : "";
      return (
        `오류: 찾을 텍스트를 문서에서 발견하지 못했습니다: "${input.find}"${caseNote}. ` +
        `read_document로 문서 내용을 확인하고 정확한 텍스트를 지정하세요.`
      );
    }

    // 항상 .hwpx로 내보내기 (exportHwp는 편집 내용 미저장 — rhwp #197)
    let newBytes: Uint8Array;
    try {
      newBytes = doc.exportHwpx();
    } catch (e) {
      return `오류: 문서 내보내기 실패. ${String(e)}`;
    }

    // ── 자기검증 게이트 ───────────────────────────────────
    // 원본 및 결과를 kordoc parse()로 마크다운 추출 후 비교
    let originalMd = "";
    let exportedMd = "";
    try {
      const origResult = await parse(originalBuf.buffer as ArrayBuffer);
      if (origResult.success) originalMd = origResult.markdown;

      const exportedResult = await parse(newBytes.buffer as ArrayBuffer);
      if (exportedResult.success) exportedMd = exportedResult.markdown;
    } catch {
      // parse 실패 시 검증 생략 (경고만 추가)
    }

    const warnings: string[] = [];

    // .hwp 입력 시 경고 추가
    if (ext === ".hwp") {
      warnings.push("rhwp는 .hwp 직접 저장을 지원하지 않아 .hwpx로 저장됩니다.");
    }

    if (exportedMd) {
      const verifyResult = verifyReplacementComplete(
        originalMd,
        exportedMd,
        input.find,
        input.replace,
        input.caseSensitive ?? false,
      );

      if (verifyResult.skipped) {
        // replace가 find를 포함 → 자동 검증 불가
        warnings.push(
          `자동 검증 생략: 바꿀 텍스트("${input.replace}")가 찾을 텍스트("${input.find}")를 포함하므로 ` +
            `교체 후 남은 횟수를 확인할 수 없습니다.`,
        );
      } else if (!verifyResult.ok) {
        // 치환이 실제로 반영되지 않음 → 중단
        return (
          `오류: rhwp 엔진이 문서의 일부를 교체하지 못해 중단했습니다` +
          `(남은 "${input.find}": ${verifyResult.remaining}곳). ` +
          `제목 등 특수 객체는 엔진 제약으로 교체되지 않을 수 있습니다. ` +
          `파일을 변경하지 않았습니다.`
        );
      }
      // verifyResult.ok && !skipped → 정상 진행
    } else {
      // 결과 문서를 재파싱하지 못해 자동 검증을 수행하지 못함
      warnings.push(
        "자동 검증을 수행하지 못했습니다(결과 문서 재파싱 실패). 저장 전 diff와 결과를 직접 확인하세요.",
      );
    }
    // ── 게이트 종료 ───────────────────────────────────────

    // 출력 경로 결정 (.hwp → .hwpx 변환)
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);

    // diff 텍스트 생성
    const allLabel = input.all ? `전체 ${replacedCount}곳` : "첫 번째 1곳";
    const diff =
      `찾기: "${input.find}" → 바꾸기: "${input.replace}" (${allLabel} 교체됨)\n` +
      `파일: ${input.path} [${ext} → .hwpx]`;

    // 스테이징
    const stagedPath = await stageFile(ctx.sessionId, outputPath, newBytes);
    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "find-replace",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings,
        willConvertFormat,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(safePath);
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
