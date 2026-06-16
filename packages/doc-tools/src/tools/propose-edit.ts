/**
 * propose_edit 툴 — 기존 문서 내용 수정 제안
 * docs/SPEC.md §6, §7
 *
 * 지원 포맷:
 * - .hwp/.hwpx  : markdownToHwpx(newMd, { templateArrayBuffer: 원본 }) — 원본 서식 보존
 * - .docx       : md→docx 재생성 (서식 손실 경고 포함)
 * - .md/.txt    : 그대로 저장
 *
 * 불변 원칙: commit() 내부에서만 타겟에 쓴다.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { compare, markdownToHwpx, parse } from "@clazic/kordoc";
import { z } from "zod";
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
      // kordoc markdownToHwpx — 원본 서식 보존
      const kordocWarnings: string[] = [];
      const hwpxBuffer = await markdownToHwpx(input.newMarkdown, {
        templateArrayBuffer: originalBuffer.buffer as ArrayBuffer,
        warnings: kordocWarnings,
      });
      if (kordocWarnings.length > 0) {
        warnings.push(...kordocWarnings.map((w) => `kordoc 경고: ${w}`));
      }
      stagedData = new Uint8Array(hwpxBuffer);
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
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);
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
        const backupPath = await backupFile(safePath);
        // 원자적 쓰기
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
