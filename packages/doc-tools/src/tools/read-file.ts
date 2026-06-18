/**
 * read_file 툴 — 텍스트 파일 읽기 (256KB 캡)
 * docs/SPEC.md §6
 */
import { readFile as fsReadFile, stat } from "node:fs/promises";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import { decodeTextFile } from "../text-encoding.js";
import type { ToolContext, ToolDefinition } from "../types.js";

/** 최대 읽기 크기 (256KB) */
const MAX_SIZE = 256 * 1024;

/** 텍스트 파일로 간주할 확장자 */
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".html",
  ".htm",
  ".xml",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".sql",
  ".csv",
  ".log",
]);

export const readFileSchema = z.object({
  path: z.string().describe("읽을 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
});

export type ReadFileInput = z.infer<typeof readFileSchema>;

export const readFileTool: ToolDefinition<ReadFileInput> = {
  name: "read_file",
  description:
    "텍스트 파일을 읽어 내용을 반환합니다. 최대 256KB까지 읽을 수 있습니다. " +
    "HWP/DOCX/XLSX/PDF 등 문서 파일은 read_document 툴을 사용하세요.",
  inputSchema: readFileSchema,
  requiresApproval: false,
  execute: async ({
    input,
    ctx,
  }: {
    input: ReadFileInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(safePath);
    } catch {
      return `오류: 파일을 찾을 수 없습니다: ${input.path}`;
    }

    if (!info.isFile()) {
      return `오류: '${input.path}'는 파일이 아닙니다.`;
    }

    // 크기 검증
    if (info.size > MAX_SIZE) {
      return `오류: 파일이 너무 큽니다 (${Math.round(info.size / 1024)}KB). 최대 256KB까지 읽을 수 있습니다.`;
    }

    // 확장자로 텍스트 파일 여부 확인
    const { extname } = await import("node:path");
    const ext = extname(safePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && ext !== "") {
      return `오류: '${ext}' 형식은 텍스트 파일로 읽을 수 없습니다. 문서 파일이라면 read_document 툴을 사용하세요.`;
    }

    let buf: Buffer;
    try {
      buf = await fsReadFile(safePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `오류: 파일을 읽을 수 없습니다: ${msg}`;
    }

    const { text, encoding } = decodeTextFile(buf);

    // .md/.txt 파일만 비-UTF-8 인코딩 메타를 노출한다 (에이전트 round-trip 인식용)
    if (
      encoding !== "utf-8" &&
      (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".text")
    ) {
      return `**인코딩**: ${encoding} (UTF-8로 변환해 표시)\n\n${text}`;
    }

    return text;
  },
};
