/**
 * @kodocagent/doc-tools — 문서 읽기/쓰기 툴
 *
 * M1: 읽기 전용 툴 (read_document, list_files, read_file)
 * M2: 쓰기 툴 (propose_*, write_new_*)
 *
 * docs/SPEC.md §6
 */

/** kordoc parse()가 읽을 수 있는 확장자 */
export const SUPPORTED_READ_EXTENSIONS = [
  ".hwp",
  ".hwpx",
  ".hwpml",
  ".docx",
  ".xlsx",
  ".xls",
  ".pdf",
  ".md",
  ".txt",
] as const;

/** v1에서 쓰기(생성/수정)가 가능한 확장자 */
export const SUPPORTED_WRITE_EXTENSIONS = [".hwpx", ".docx", ".xlsx", ".md", ".txt"] as const;

/** .hwp 편집 결과는 .hwpx로 저장된다 (HWP 5.0 바이너리 쓰기 미지원 — SPEC §0 결정 5) */
export const HWP_WRITE_CONVERSION = { from: ".hwp", to: ".hwpx" } as const;

export { resolveSafePath } from "./security.js";
export { listFilesTool } from "./tools/list-files.js";
export { readDocumentTool } from "./tools/read-document.js";
export { readFileTool } from "./tools/read-file.js";
export type { ToolContext, ToolDefinition } from "./types.js";

import { listFilesTool } from "./tools/list-files.js";
import { readDocumentTool } from "./tools/read-document.js";
import { readFileTool } from "./tools/read-file.js";

/**
 * 읽기 전용 doc 툴 배열을 반환한다.
 * core의 ToolRegistry.register()에 등록해 사용한다.
 */
export function createDocTools(_ctx: { cwd: string }) {
  // ctx는 런타임 시 ToolRegistry.setContext()로 주입되므로 여기서는 타입 힌트용
  return [readDocumentTool, listFilesTool, readFileTool] as const;
}
