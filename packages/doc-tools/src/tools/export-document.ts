/**
 * export_document 툴 — 문서를 HTML/PDF로 내보내기
 *
 * kordoc-api-first 원칙: 출력 변환을 자체 구현하지 않고 kordoc 변환기를 사용한다.
 *   - HTML: kordoc `renderHtml(markdown)` — 추가 의존성 없음(항상 동작).
 *   - PDF : kordoc `markdownToPdf(markdown)` — puppeteer-core 필요(런타임 선택).
 *           미설치 시 친절한 안내를 반환하고 .html 대안을 제시한다.
 *
 * 원본 문서(.hwp/.hwpx/.docx 등 kordoc이 읽는 형식)를 parse 하여 마크다운을 얻고,
 * 출력 경로 확장자(.html/.htm 또는 .pdf)로 형식을 결정한다. 새 파일을 만들며
 * 원본은 변경하지 않는다. 결과는 사용자 승인 후에만 저장된다.
 */

import { extname } from "node:path";
import { kordocErrorMessage } from "@kodocagent/shared";
import { markdownToPdf, renderHtml } from "kordoc";
import { z } from "zod";
import { parse } from "../kordoc-parse.js";
import { resolveSafePath } from "../security.js";
import { backupFile, commitStaged, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

const MAX_PREVIEW_CHARS = 4_000;

export const exportDocumentSchema = z.object({
  path: z
    .string()
    .describe("변환할 원본 문서 경로 (.hwp/.hwpx/.docx 등 — cwd 기준 상대/절대 경로)"),
  outputPath: z.string().describe("출력 파일 경로 — 확장자로 형식 결정(.html/.htm 또는 .pdf)"),
  summary: z.string().optional().describe("변경 요약 (한국어 1-2문장)"),
});

export type ExportDocumentInput = z.infer<typeof exportDocumentSchema>;

export const exportDocumentTool: ToolDefinition<ExportDocumentInput> = {
  name: "export_document",
  description:
    "문서(.hwp/.hwpx/.docx 등)를 HTML 또는 PDF로 내보냅니다. " +
    "출력 경로 확장자로 형식을 결정합니다(.html/.htm 또는 .pdf). " +
    "원본은 변경하지 않고 새 파일을 만듭니다. " +
    "HTML은 항상 가능하며, PDF는 puppeteer-core가 설치된 환경에서만 가능합니다(미설치 시 안내). " +
    "변경 사항은 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: exportDocumentSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ExportDocumentInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const outPath = await resolveSafePath(ctx.cwd, input.outputPath);
    const outExt = extname(outPath).toLowerCase();

    const format: "html" | "pdf" | null =
      outExt === ".html" || outExt === ".htm" ? "html" : outExt === ".pdf" ? "pdf" : null;
    if (format === null) {
      return (
        `오류: 지원하지 않는 출력 형식입니다: ${outExt || "(확장자 없음)"}. ` +
        "출력 경로를 .html 또는 .pdf 로 지정하세요."
      );
    }

    // 원본 파싱 — kordoc이 읽는 형식이면 모두 가능
    const parseResult = await parse(safePath);
    if (!parseResult.success) {
      const msg = kordocErrorMessage(
        parseResult.code,
        `원본 문서를 읽을 수 없습니다: ${parseResult.error}`,
      );
      return `오류: ${msg}`;
    }
    const markdown = parseResult.markdown;

    // 형식별 변환 (kordoc 변환기)
    let stagedData: Uint8Array;
    const warnings: string[] = [];
    if (format === "html") {
      stagedData = new TextEncoder().encode(renderHtml(markdown));
    } else {
      try {
        const pdf = await markdownToPdf(markdown);
        stagedData = new Uint8Array(pdf);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (/puppeteer/i.test(m)) {
          return (
            "오류: PDF 내보내기에는 puppeteer-core가 필요합니다(이 환경에 미설치). " +
            "해결: (1) 출력 경로를 .html 로 지정해 HTML로 내보내거나, " +
            "(2) `npm install -g puppeteer-core` 후 Chrome/Chromium 실행 파일 경로를 설정하세요."
          );
        }
        return `오류: PDF 생성에 실패했습니다: ${m}`;
      }
    }

    const stagedPath = await stageFile(ctx.sessionId, outPath, stagedData);

    // 미리보기 — HTML은 마크다운 발췌, PDF는 바이트 크기 안내
    const preview =
      format === "html"
        ? `[HTML 내보내기 미리보기 — 본문 텍스트]\n\n${
            markdown.length > MAX_PREVIEW_CHARS
              ? `${markdown.slice(0, MAX_PREVIEW_CHARS)}\n\n...이하 생략`
              : markdown
          }`
        : `[PDF 내보내기] ${input.path} → ${input.outputPath} (${stagedData.byteLength.toLocaleString()} bytes)`;

    const proposalId = crypto.randomUUID();
    const opSummary = input.summary ?? `${input.path} → ${format.toUpperCase()} 내보내기`;

    return {
      proposal: {
        id: proposalId,
        kind: "export",
        targetPath: outPath,
        stagedPath,
        summary: opSummary,
        diff: preview,
        warnings,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(outPath, undefined, { summary: opSummary }); // 기존 출력 파일이 있으면 백업
        await commitStaged(stagedPath, outPath);
        const backupInfo = backupPath ? ` (기존 파일 백업: ${backupPath})` : "";
        return `내보내기 완료: ${outPath}${backupInfo}`;
      },
    };
  },
};
