/**
 * list_files 툴 — cwd 이하 파일 목록 (깊이 ≤ 4, 문서 확장자 우선)
 * docs/SPEC.md §6
 */
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import type { ToolContext, ToolDefinition } from "../types.js";

/** 문서 확장자 (우선 표시) */
const DOC_EXTENSIONS = new Set([
  ".hwp",
  ".hwpx",
  ".hwpml",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pdf",
  ".pptx",
  ".ppt",
  ".md",
  ".txt",
]);

/** 스킵할 디렉터리 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "__pycache__",
  "dist",
  "build",
  ".next",
]);

const MAX_DEPTH = 4;
const MAX_FILES = 500;

export const listFilesSchema = z.object({
  dir: z.string().optional().describe("목록을 조회할 디렉터리 (미지정 시 cwd 전체)"),
});

export type ListFilesInput = z.infer<typeof listFilesSchema>;

interface FileEntry {
  path: string;
  isDir: boolean;
  isDoc: boolean;
}

async function collectFiles(
  dir: string,
  cwd: string,
  depth: number,
  entries: FileEntry[],
): Promise<void> {
  if (depth > MAX_DEPTH || entries.length >= MAX_FILES) return;

  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return;
  }

  for (const item of items) {
    if (entries.length >= MAX_FILES) break;
    // 숨김 파일/디렉터리 스킵
    if (item.startsWith(".")) continue;
    if (SKIP_DIRS.has(item)) continue;

    const fullPath = join(dir, item);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }

    const relPath = relative(cwd, fullPath);
    const ext = extname(item).toLowerCase();
    const isDoc = DOC_EXTENSIONS.has(ext);

    if (info.isDirectory()) {
      entries.push({ path: relPath + "/", isDir: true, isDoc: false });
      await collectFiles(fullPath, cwd, depth + 1, entries);
    } else if (info.isFile()) {
      entries.push({ path: relPath, isDir: false, isDoc });
    }
  }
}

export const listFilesTool: ToolDefinition<ListFilesInput> = {
  name: "list_files",
  description:
    "현재 작업 디렉터리(cwd) 이하의 파일 목록을 반환합니다. " +
    "문서 파일(.hwp/.hwpx/.docx/.xlsx/.pdf 등)이 최상단에 표시됩니다. " +
    "깊이는 최대 4단계까지입니다.",
  inputSchema: listFilesSchema,
  requiresApproval: false,
  execute: async ({
    input,
    ctx,
  }: {
    input: ListFilesInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => {
    const targetDir = input.dir ? await resolveSafePath(ctx.cwd, input.dir) : ctx.cwd;

    const entries: FileEntry[] = [];
    await collectFiles(targetDir, ctx.cwd, 0, entries);

    if (entries.length === 0) {
      return "파일이 없습니다.";
    }

    // 문서 파일 먼저, 그 다음 디렉터리, 나머지 파일
    const docs = entries.filter((e) => e.isDoc);
    const dirs = entries.filter((e) => e.isDir);
    const others = entries.filter((e) => !e.isDoc && !e.isDir);

    const allSorted = [...docs, ...dirs, ...others];

    const lines = allSorted.map((e) => {
      const icon = e.isDir ? "📁" : e.isDoc ? "📄" : "  ";
      return `${icon} ${e.path}`;
    });

    const truncateNotice =
      entries.length >= MAX_FILES
        ? `\n(최대 ${MAX_FILES}개까지 표시됩니다. 더 좁은 범위를 지정하세요.)`
        : "";

    return lines.join("\n") + truncateNotice;
  },
};
