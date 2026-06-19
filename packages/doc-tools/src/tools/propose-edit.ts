/**
 * propose_edit 툴 — 기존 문서 내용 수정 제안
 * docs/SPEC.md §6, §7
 *
 * 지원 포맷:
 * - .hwpx       : patchHwpx(원본, newMd) — 무손실 서식 보존 패치
 * - .hwp        : patchHwp(원본, newMd) — 원본 .hwp 형식 그대로 제자리 편집
 * - .docx       : md→docx 재생성 (서식 손실 경고 포함)
 * - .md/.txt    : 그대로 저장
 *
 * 불변 원칙: commit() 내부에서만 타겟에 쓴다.
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { compare, patchHwp, patchHwpx } from "kordoc";
import { z } from "zod";
import { parse } from "../kordoc-parse.js";
import { markdownToDocx } from "../md-to-docx.js";
import {
  assertFileSizeWithinLimit,
  assertZipNotBomb,
  isZipBinary,
  resolveSafePath,
} from "../security.js";
import {
  backupFile,
  commitStaged,
  markdownDiff,
  resolveOutputPath,
  stageFile,
} from "../staging.js";
import { decodeTextFile } from "../text-encoding.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

/**
 * 원본 마크다운 대비 신규 내용이 이 비율 미만이면 잘린 내용으로 전체 교체 위험 경고를 추가한다.
 * 원본이 이 길이 이상일 때만 검사(짧은 문서는 정상적인 대폭 삭제일 수 있음).
 */
const TRUNCATION_REPLACE_MIN_ORIGINAL_LENGTH = 2000;
const TRUNCATION_REPLACE_RATIO_THRESHOLD = 0.5;

/**
 * 잘린 내용으로 전체 교체 시 뒷부분 영구 소실 위험 경고를 생성한다.
 * 원본이 충분히 길고(>=MIN) 신규가 그 절반 미만일 때만 경고(아니면 null).
 * 정상적인 대량 삭제일 수도 있으므로 단정하지 않고 가능성으로 안내한다.
 */
function truncationReplaceWarning(originalLen: number, newLen: number): string | null {
  if (
    originalLen < TRUNCATION_REPLACE_MIN_ORIGINAL_LENGTH ||
    newLen >= originalLen * TRUNCATION_REPLACE_RATIO_THRESHOLD
  ) {
    return null;
  }
  return (
    `새 내용이 원본의 절반 미만입니다(원본 약 ${originalLen}자 → 신규 ${newLen}자). ` +
    "의도한 대량 삭제가 아니라면, read_document가 80,000자에서 잘렸을 때 그 잘린 내용으로 " +
    "전체를 교체한 것일 수 있습니다(뒷부분 영구 삭제). read_document의 pages 옵션으로 나눠 읽고 편집하세요."
  );
}

export const proposeEditSchema = z.object({
  path: z.string().describe("수정할 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  newMarkdown: z
    .string()
    .refine((s) => !s.includes("\u0000"), "내용에 NULL 문자를 포함할 수 없습니다")
    .describe("새 문서 내용 (마크다운 형식). read_document로 원본을 먼저 읽어야 함"),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type ProposeEditInput = z.infer<typeof proposeEditSchema>;

export const proposeEditTool: ToolDefinition<ProposeEditInput> = {
  name: "propose_edit",
  description:
    "기존 문서(.hwp/.hwpx/.docx/.md/.txt)의 내용을 수정합니다. " +
    "반드시 read_document로 원본을 먼저 읽은 후 수정할 내용을 newMarkdown에 전달하세요. " +
    "변경 사항은 diff 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: proposeEditSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeEditInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // 파일 크기 가드 — 원본 readFile 직전
    try {
      await assertFileSizeWithinLimit(safePath);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
    }

    // 원본 파일 읽기 — 읽기 직후 mtime을 캡처해 lost-update 베이스라인으로 사용
    let originalBuffer: Buffer;
    let sourceMtimeMs: number | undefined;
    try {
      originalBuffer = await readFile(safePath);
      sourceMtimeMs = (await stat(safePath)).mtimeMs;
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하거나 read_document로 먼저 확인하세요.`;
    }

    const warnings: string[] = [];
    let stagedData: Uint8Array;
    let originalMarkdown = "";

    // 압축 폭탄 가드 — ZIP 포맷(.hwpx/.docx)은 parse/patchHwpx 직전에 검사
    if (
      isZipBinary(
        new Uint8Array(originalBuffer.buffer, originalBuffer.byteOffset, originalBuffer.byteLength),
      )
    ) {
      try {
        assertZipNotBomb(
          new Uint8Array(
            originalBuffer.buffer,
            originalBuffer.byteOffset,
            originalBuffer.byteLength,
          ),
        );
      } catch (err) {
        if (err instanceof Error) return `오류: ${err.message}`;
        throw err;
      }
    }

    // 원본 마크다운 추출 (diff용)
    const originalResult = await parse(originalBuffer.buffer as ArrayBuffer);
    if (originalResult.success) {
      originalMarkdown = originalResult.markdown;
    }

    // 포맷별 처리
    if (ext === ".hwpx" || ext === ".hwp") {
      // kordoc patchHwpx/patchHwp — 무손실 서식 보존 패치
      const origU8 = new Uint8Array(
        originalBuffer.buffer,
        originalBuffer.byteOffset,
        originalBuffer.byteLength,
      );
      const patchResult =
        ext === ".hwp"
          ? await patchHwp(origU8, input.newMarkdown)
          : await patchHwpx(origU8, input.newMarkdown);
      if (!patchResult.success || !patchResult.data) {
        return `오류: 편집을 적용하지 못했습니다: ${patchResult.error ?? "알 수 없는 오류"}. read_document로 원본을 다시 확인하세요.`;
      }
      stagedData = patchResult.data;

      // 요청한 변경이 하나도 적용되지 않았으면(applied 0 + skip 있음) — 정직하게 오류 반환.
      // (그렇지 않으면 무변경 제안이 '성공'처럼 보여 에이전트가 같은 시도를 반복한다.)
      if (patchResult.applied === 0 && patchResult.skipped.length > 0) {
        const reasons = [...new Set(patchResult.skipped.map((s) => s.reason ?? "사유 미상"))].join(
          "; ",
        );
        if (ext === ".hwp") {
          return (
            `오류: 요청한 변경이 적용되지 않았습니다(${reasons}). ` +
            "`.hwp`(한/글 바이너리)는 표·병합/줄바꿈 셀 등 일부 편집을 지원하지 않습니다. " +
            "한글에서 '다른 이름으로 저장 → HWPX(.hwpx)'로 변환하면 `propose_cell_edit`(셀 값)·`propose_table_structure`(표 구조)로 편집할 수 있습니다. " +
            "추측해 반복하지 말고, 변환이 필요하다는 점을 사용자에게 안내하세요."
          );
        }
        return (
          `오류: 요청한 변경이 적용되지 않았습니다(${reasons}). ` +
          "표 셀 값은 `propose_cell_edit`, 표 구조 변경은 `propose_table_structure`를 사용하세요."
        );
      }

      const skipGuide =
        ext === ".hwp"
          ? "표·셀 편집이 필요하면 한글에서 .hwpx로 저장한 뒤 propose_cell_edit/propose_table_structure를 사용하세요."
          : "표 구조 변경은 propose_table_structure, 셀 값은 propose_cell_edit을 사용하세요.";
      for (const s of patchResult.skipped) {
        warnings.push(`일부 변경이 적용되지 않았습니다(${s.reason ?? "사유 미상"}). ${skipGuide}`);
      }

      // 잘린 내용으로 전체 교체 시 뒷부분 영구 소실 경고
      {
        const truncWarn = truncationReplaceWarning(
          originalMarkdown.length,
          input.newMarkdown.length,
        );
        if (truncWarn) warnings.push(truncWarn);
      }
    } else if (ext === ".docx") {
      // DOCX: md→docx 재생성 (서식 손실 경고)
      warnings.push("DOCX 재생성: 복잡한 서식(머리글/각주/스타일)은 손실될 수 있습니다.");
      // 잘린 내용으로 전체 교체 시 뒷부분 영구 소실 경고
      {
        const truncWarn = truncationReplaceWarning(
          originalMarkdown.length,
          input.newMarkdown.length,
        );
        if (truncWarn) warnings.push(truncWarn);
      }
      const docxBuffer = await markdownToDocx(input.newMarkdown);
      stagedData = new Uint8Array(docxBuffer);
    } else if (ext === ".md" || ext === ".txt") {
      // 텍스트 파일: 원본 인코딩 감지 후 UTF-8로 저장
      const { text: decodedOriginal, encoding: srcEncoding } = decodeTextFile(originalBuffer);
      // 평문은 parse()가 UNSUPPORTED라 originalMarkdown이 비어 diff가 전체 추가로 보인다.
      // 디코딩한 원문을 diff 기준선으로 사용해 실제 변경만 드러나게 한다.
      if (!originalMarkdown) originalMarkdown = decodedOriginal;
      if (srcEncoding !== "utf-8") {
        warnings.push(
          `원본 파일이 ${srcEncoding} 인코딩이지만 UTF-8로 저장됩니다(한글이 깨지지 않으나 인코딩이 바뀝니다).`,
        );
      }
      stagedData = new TextEncoder().encode(input.newMarkdown);
    } else {
      return `오류: 지원하지 않는 파일 형식입니다: ${ext}. .hwp, .hwpx, .docx, .md, .txt만 수정 가능합니다.`;
    }

    // 스테이징
    // .hwpx/.hwp는 무손실 패치로 같은 확장자 그대로 저장 (포맷 변환 없음)
    // 다른 포맷(.docx/.md/.txt 등)은 resolveOutputPath 사용
    const outputPath =
      ext === ".hwpx" || ext === ".hwp" ? safePath : resolveOutputPath(safePath).outputPath;
    const willConvertFormat =
      ext === ".hwpx" || ext === ".hwp" ? undefined : resolveOutputPath(safePath).willConvertFormat;
    const stagedPath = await stageFile(ctx.sessionId, safePath, stagedData);

    // diff 생성
    let diff = markdownDiff(originalMarkdown, input.newMarkdown, safePath);

    // .hwpx/.hwp의 경우 kordoc compare로 구조 변경 통계 추가
    if (ext === ".hwpx" || ext === ".hwp") {
      try {
        const stagedResult = await parse(new Uint8Array(stagedData).buffer as ArrayBuffer);
        if (stagedResult.success) {
          const compareResult = await compare(
            originalBuffer.buffer as ArrayBuffer,
            new Uint8Array(stagedData).buffer as ArrayBuffer,
          );
          const { added, removed, modified } = compareResult.stats;
          const statsLine = `구조 변경: +${added} -${removed} ~${modified}`;
          diff = `${statsLine}\n\n${diff}`;
        }
      } catch {
        // kordoc compare 실패는 무시 (optional)
      }
    }

    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "edit",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings,
        willConvertFormat,
        sourcePath: safePath,
        sourceMtimeMs,
      },
      commit: async (): Promise<string> => {
        // 백업 (원본이 있을 때만)
        const backupPath = await backupFile(safePath, undefined, { summary: input.summary });
        // ① 포맷 변환 시 출력 경로 기존 파일도 별도 백업 (data-loss 방지)
        if (outputPath !== safePath) {
          await backupFile(outputPath, undefined, { summary: input.summary });
        }
        // 원자적 쓰기
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
