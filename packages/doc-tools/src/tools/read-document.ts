/**
 * read_document 툴 — kordoc parse()로 문서를 읽어 마크다운 + 메타 반환
 * docs/SPEC.md §6
 */
import { parse } from "@clazic/kordoc";
import { kordocErrorMessage } from "@kodocagent/shared";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import type { ToolContext, ToolDefinition } from "../types.js";

/** 반환 마크다운 최대 길이 (약 80k 문자) */
const MAX_MARKDOWN_LENGTH = 80_000;

export const readDocumentSchema = z.object({
  path: z.string().describe("읽을 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  pages: z.string().optional().describe('읽을 페이지 범위 (예: "1-3", "1,3,5") — 미지정 시 전체'),
});

export type ReadDocumentInput = z.infer<typeof readDocumentSchema>;

export const readDocumentTool: ToolDefinition<ReadDocumentInput> = {
  name: "read_document",
  description:
    "HWP/HWPX/DOCX/XLSX/PDF 등 문서를 읽어 마크다운 텍스트와 메타데이터를 반환합니다. " +
    "문서를 수정하기 전에 반드시 이 툴로 내용을 먼저 확인하세요.",
  inputSchema: readDocumentSchema,
  requiresApproval: false,
  execute: async ({
    input,
    ctx,
  }: {
    input: ReadDocumentInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const result = await parse(safePath, input.pages ? { pages: input.pages } : undefined);

    if (!result.success) {
      const msg = kordocErrorMessage(result.code, `문서를 읽을 수 없습니다: ${result.error}`);
      return `오류: ${msg}`;
    }

    const { markdown, metadata, fileType, pageCount, warnings } = result;

    // 메타 정보 구성
    const metaLines: string[] = [];
    metaLines.push(`**파일 형식**: ${fileType.toUpperCase()}`);
    if (pageCount !== undefined) metaLines.push(`**페이지/섹션 수**: ${pageCount}`);
    if (metadata?.title) metaLines.push(`**제목**: ${metadata.title}`);
    if (metadata?.author) metaLines.push(`**작성자**: ${metadata.author}`);
    if (metadata?.createdAt) metaLines.push(`**생성일**: ${metadata.createdAt}`);
    if (warnings && warnings.length > 0) {
      metaLines.push(`**경고**: ${warnings.map((w) => w.message).join(", ")}`);
    }

    // 마크다운 캡 처리
    let body = markdown;
    let truncated = false;
    if (body.length > MAX_MARKDOWN_LENGTH) {
      body = body.slice(0, MAX_MARKDOWN_LENGTH);
      truncated = true;
    }

    const meta = metaLines.length > 0 ? `${metaLines.join("\n")}\n\n---\n\n` : "";
    const truncationNotice = truncated
      ? `\n\n---\n\n⚠️ 내용이 너무 길어 약 80,000자에서 잘렸습니다. 페이지 범위(pages 옵션)를 지정하여 부분적으로 읽을 수 있습니다.`
      : "";

    return `${meta}${body}${truncationNotice}`;
  },
};
