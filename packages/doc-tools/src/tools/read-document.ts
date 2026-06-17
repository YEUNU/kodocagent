/**
 * read_document 툴 — kordoc parse()로 문서를 읽어 마크다운 + 메타 반환
 * docs/SPEC.md §6
 *
 * .md/.markdown/.txt/.text 평문 텍스트 파일은 kordoc를 거치지 않고
 * UTF-8로 직접 읽어 반환한다 (kordoc 2.7.6은 해당 포맷을 UNSUPPORTED_FORMAT으로 처리함).
 *
 * outline 모드: 헤딩(#~######) 구조만 반환해 대형 문서 구조 파악용.
 * search 모드: 키워드 주변 맥락만 반환해 필요한 부분만 효율적으로 읽음.
 * 두 모드 동시 지정 시 outline 우선.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "kordoc";
import { kordocErrorMessage } from "@kodocagent/shared";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import type { ToolContext, ToolDefinition } from "../types.js";

/** 반환 마크다운 최대 길이 (약 80k 문자) */
const MAX_MARKDOWN_LENGTH = 80_000;

/** 입력 파일 최대 크기 (100MB) — 초과 시 파싱 없이 오류 반환 */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/** 평문 텍스트 확장자 집합 (소문자) — kordoc 없이 직접 읽는다 */
const PLAIN_TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".text"]);

/** searchExcerpts 매치 블록 최대 수 */
const MAX_SEARCH_MATCHES = 50;

/**
 * 파일 크기 가드 메시지를 반환한다.
 * - 크기가 limitBytes를 초과하면 한국어 오류 문자열 반환
 * - 초과하지 않으면 null 반환
 */
export function fileSizeGuardMessage(sizeBytes: number, limitBytes: number): string | null {
  if (sizeBytes <= limitBytes) return null;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
  return `오류: 파일이 너무 큽니다 (${sizeMB}MB, 최대 100MB). 파일을 분할하거나 일부만 추출해 다시 시도하세요.`;
}

/**
 * 마크다운에서 헤딩(#~######) 라인만 추출해 문서 개요를 반환한다.
 * 레벨에 따라 들여쓰기로 계층을 표현한다.
 * 헤딩이 없으면 "(헤딩이 없습니다)" 안내를 반환한다.
 */
export function extractOutline(markdown: string): string {
  const lines = markdown.split("\n");
  const headingLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match && match[1] !== undefined) {
      const level = match[1].length;
      // 레벨 1은 들여쓰기 없음, 레벨 2는 2칸, ...
      const indent = "  ".repeat(level - 1);
      headingLines.push(`${indent}${line.trimEnd()}`);
    }
  }

  if (headingLines.length === 0) {
    return "(헤딩이 없습니다)";
  }

  return headingLines.join("\n");
}

/**
 * 마크다운에서 query(대소문자 무시)를 포함하는 라인과 앞뒤 2줄 맥락을 반환한다.
 * - 매치 블록 사이는 구분선(\n…\n)으로 분리
 * - 각 라인 앞에 줄 번호(1-based)를 붙여 탐색에 도움
 * - 매치가 없으면 안내 문자열 반환
 * - 매치 블록이 MAX_SEARCH_MATCHES를 초과하면 잘림 안내 추가
 */
export function searchExcerpts(markdown: string, query: string): string {
  if (!query.trim()) {
    return "(검색어가 비어 있습니다)";
  }

  const lines = markdown.split("\n");
  const lowerQuery = query.toLowerCase();

  // 매치 라인 인덱스 수집 (0-based)
  const matchIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.toLowerCase().includes(lowerQuery)) {
      matchIndices.push(i);
    }
  }

  if (matchIndices.length === 0) {
    return `'${query}' 를 찾지 못했습니다.`;
  }

  // 매치 블록 병합 (앞뒤 2줄 컨텍스트 포함, 겹치는 구간 합치기)
  const CONTEXT = 2;
  const blocks: Array<{ start: number; end: number }> = [];

  for (const idx of matchIndices) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(lines.length - 1, idx + CONTEXT);

    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock !== undefined && start <= lastBlock.end + 1) {
      // 이전 블록과 겹치거나 인접 — 병합
      lastBlock.end = Math.max(lastBlock.end, end);
    } else {
      blocks.push({ start, end });
    }
  }

  let truncated = false;
  let usedBlocks = blocks;
  if (blocks.length > MAX_SEARCH_MATCHES) {
    usedBlocks = blocks.slice(0, MAX_SEARCH_MATCHES);
    truncated = true;
  }

  const parts: string[] = [];
  for (const block of usedBlocks) {
    const blockLines: string[] = [];
    for (let i = block.start; i <= block.end; i++) {
      // 줄 번호는 1-based
      const lineText = lines[i] ?? "";
      blockLines.push(`${i + 1}: ${lineText}`);
    }
    parts.push(blockLines.join("\n"));
  }

  let result = parts.join("\n…\n");
  if (truncated) {
    result += `\n\n(매치 블록이 너무 많아 앞 ${MAX_SEARCH_MATCHES}개까지만 표시했습니다)`;
  }

  return result;
}

export const readDocumentSchema = z.object({
  path: z.string().describe("읽을 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  pages: z.string().optional().describe('읽을 페이지 범위 (예: "1-3", "1,3,5") — 미지정 시 전체'),
  outline: z
    .boolean()
    .optional()
    .describe("헤딩(제목) 구조만 반환해 문서 개요 파악 (대형 문서 탐색용)"),
  search: z
    .string()
    .optional()
    .describe("키워드가 포함된 부분과 주변 맥락만 반환 (대형 문서에서 필요한 부분만 읽기)"),
});

export type ReadDocumentInput = z.infer<typeof readDocumentSchema>;

/**
 * 마크다운 본문에 outline/search 모드를 적용해 최종 출력 본문을 반환한다.
 * - outline === true → extractOutline 결과
 * - search(비어있지 않음) → searchExcerpts 결과
 * - 둘 다 지정 시 outline 우선
 * - 나머지 → 원본 본문 그대로
 */
function applyReadMode(
  body: string,
  outline: boolean | undefined,
  search: string | undefined,
): string {
  if (outline === true) {
    return extractOutline(body);
  }
  if (search && search.trim().length > 0) {
    return searchExcerpts(body, search);
  }
  return body;
}

export const readDocumentTool: ToolDefinition<ReadDocumentInput> = {
  name: "read_document",
  description:
    "HWP/HWPX/DOCX/XLSX/PDF 등 문서를 읽어 마크다운 텍스트와 메타데이터를 반환합니다. " +
    "문서를 수정하기 전에 반드시 이 툴로 내용을 먼저 확인하세요. " +
    "큰 문서는 outline 모드로 구조를 먼저 파악하거나, search 모드로 필요한 부분만 읽어 컨텍스트를 아낄 수 있습니다.",
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

    // 파일 크기 가드 — 평문/kordoc 분기 이전에 확인
    try {
      const fileStat = await stat(safePath);
      const guardMsg = fileSizeGuardMessage(fileStat.size, MAX_FILE_SIZE_BYTES);
      if (guardMsg !== null) return guardMsg;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `오류: 파일을 읽을 수 없습니다: ${msg}`;
    }

    // 평문 텍스트 파일은 kordoc 없이 직접 UTF-8로 읽어 반환한다.
    const ext = extname(safePath).toLowerCase();
    if (PLAIN_TEXT_EXTS.has(ext)) {
      let raw: string;
      try {
        raw = await readFile(safePath, "utf-8");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `오류: 파일을 읽을 수 없습니다: ${msg}`;
      }

      // 파일 형식 레이블 (MD 또는 TXT)
      const formatLabel = ext === ".md" || ext === ".markdown" ? "MD" : "TXT";
      const meta = `**파일 형식**: ${formatLabel}\n\n---\n\n`;

      // outline/search 모드 적용 후 캡 처리
      let body = applyReadMode(raw, input.outline, input.search);
      let truncated = false;
      if (body.length > MAX_MARKDOWN_LENGTH) {
        body = body.slice(0, MAX_MARKDOWN_LENGTH);
        truncated = true;
      }

      const truncationNotice = truncated
        ? `\n\n---\n\n⚠️ 내용이 너무 길어 약 80,000자에서 잘렸습니다. (평문 텍스트 파일이라 페이지 단위 분할 읽기는 지원되지 않습니다)`
        : "";

      return `${meta}${body}${truncationNotice}`;
    }

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

    // outline/search 모드 적용 후 캡 처리
    let body = applyReadMode(markdown, input.outline, input.search);
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
