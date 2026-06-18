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

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { compare, patchHwp, patchHwpx } from "kordoc";
import { z } from "zod";
import { parse } from "../kordoc-parse.js";
import { markdownToDocx } from "../md-to-docx.js";
import { resolveSafePath } from "../security.js";
import {
  backupFile,
  commitStaged,
  markdownDiff,
  resolveOutputPath,
  stageFile,
} from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

export const proposeEditSchema = z.object({
  path: z.string().describe("수정할 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  newMarkdown: z
    .string()
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

    // 원본 파일 읽기
    let originalBuffer: Buffer;
    try {
      originalBuffer = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하거나 read_document로 먼저 확인하세요.`;
    }

    const warnings: string[] = [];
    let stagedData: Uint8Array;
    let originalMarkdown = "";

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
    } else if (ext === ".docx") {
      // DOCX: md→docx 재생성 (서식 손실 경고)
      warnings.push("DOCX 재생성: 복잡한 서식(머리글/각주/스타일)은 손실될 수 있습니다.");
      const docxBuffer = await markdownToDocx(input.newMarkdown);
      stagedData = new Uint8Array(docxBuffer);
    } else if (ext === ".md" || ext === ".txt") {
      // 텍스트 파일: 그대로
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
      },
      commit: async (): Promise<string> => {
        // 백업 (원본이 있을 때만)
        const backupPath = await backupFile(safePath, undefined, { summary: input.summary });
        // 원자적 쓰기
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
