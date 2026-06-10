/**
 * write_new_document 툴 — 신규 문서 작성 제안
 * docs/SPEC.md §6, §7
 *
 * 확장자별 처리:
 * - .hwpx : markdownToHwpx (템플릿 없음)
 * - .docx : md→docx 재생성
 * - .md/.txt : raw 저장
 *
 * 타겟 파일이 이미 존재하면 오류 (propose_edit을 사용하도록 안내)
 * diff 없이 전체 내용 미리보기 (최대 10k 문자)
 */

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { markdownToHwpx } from "@clazic/kordoc";
import { z } from "zod";
import { markdownToDocx } from "../md-to-docx.js";
import { resolveSafePath } from "../security.js";
import { commitStaged, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

const MAX_PREVIEW_CHARS = 10_000;

export const writeNewDocumentSchema = z.object({
  path: z.string().describe("생성할 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  markdown: z.string().describe("새 문서 내용 (마크다운 형식)"),
});

export type WriteNewDocumentInput = z.infer<typeof writeNewDocumentSchema>;

export const writeNewDocumentTool: ToolDefinition<WriteNewDocumentInput> = {
  name: "write_new_document",
  description:
    "새 문서 파일(.hwpx/.docx/.md/.txt)을 생성합니다. " +
    "이미 존재하는 파일은 생성할 수 없습니다(존재하는 파일 수정은 propose_edit 사용). " +
    "내용 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: writeNewDocumentSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: WriteNewDocumentInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // 타겟 파일이 이미 존재하는지 확인
    try {
      await stat(safePath);
      return (
        `오류: 파일이 이미 존재합니다: ${input.path}. ` +
        `기존 파일을 수정하려면 propose_edit을 사용하세요.`
      );
    } catch {
      // ENOENT = 파일 없음 → 정상 진행
    }

    const warnings: string[] = [];
    let stagedData: Uint8Array;

    if (ext === ".hwpx") {
      // kordoc markdownToHwpx (템플릿 없음)
      const kordocWarnings: string[] = [];
      const hwpxBuffer = await markdownToHwpx(input.markdown, {
        warnings: kordocWarnings,
      });
      if (kordocWarnings.length > 0) {
        warnings.push(...kordocWarnings.map((w) => `kordoc 경고: ${w}`));
      }
      stagedData = new Uint8Array(hwpxBuffer);
    } else if (ext === ".docx") {
      warnings.push("DOCX 생성: 복잡한 서식(머리글/각주/스타일)은 지원되지 않습니다.");
      const docxBuffer = await markdownToDocx(input.markdown);
      stagedData = new Uint8Array(docxBuffer);
    } else if (ext === ".md" || ext === ".txt") {
      stagedData = new TextEncoder().encode(input.markdown);
    } else {
      return (
        `오류: 지원하지 않는 파일 형식입니다: ${ext}. ` +
        `.hwpx, .docx, .md, .txt 중 하나를 사용하세요.`
      );
    }

    // 스테이징
    const stagedPath = await stageFile(ctx.sessionId, safePath, stagedData);

    // 전체 내용 미리보기 (diff 대신)
    const preview =
      input.markdown.length > MAX_PREVIEW_CHARS
        ? `${input.markdown.slice(0, MAX_PREVIEW_CHARS)}\n\n...이하 생략 (${input.markdown.length - MAX_PREVIEW_CHARS}자 더 있음)`
        : input.markdown;

    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "new-document",
        targetPath: safePath,
        stagedPath,
        summary: `새 문서 생성: ${input.path}`,
        diff: `[새 파일 미리보기]\n\n${preview}`,
        warnings,
      },
      commit: async (): Promise<string> => {
        // 신규 파일이므로 백업 불필요
        await commitStaged(stagedPath, safePath);
        return `저장 완료: ${safePath}`;
      },
    };
  },
};
