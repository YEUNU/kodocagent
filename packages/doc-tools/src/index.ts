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

export { renderHtml } from "kordoc";
// 미리보기/내보내기 HTML 의 <img src="파일명"> 을 parse 가 추출한 그림 바이트의 data URI 로 인라인
export { inlineImagesAsDataUri, type ParsedImage } from "./inline-images.js";
// 미리보기/렌더용 — GUI 등 소비자가 동일한 robust parse + renderHtml 을 쓰도록 재노출
export { parse } from "./kordoc-parse.js";
export { resolveSafePath } from "./security.js";
export {
  cleanAllStaging,
  cleanOldBackups,
  cleanSessionStaging,
} from "./staging.js";
export { listBackupsTool, restoreBackupTool } from "./tools/backups.js";
export { compareDocumentsTool } from "./tools/compare-documents.js";
export { exportDocumentTool } from "./tools/export-document.js";
export { extractFormatTemplateTool } from "./tools/extract-format-template.js";
export { findInDocumentTool } from "./tools/find-in-document.js";
export { listFormObjectsTool, proposeFormObjectTool } from "./tools/form-objects.js";
export { listFilesTool } from "./tools/list-files.js";
export { proposeCellEditTool } from "./tools/propose-cell-edit.js";
export { proposeEditTool } from "./tools/propose-edit.js";
export { proposeFindReplaceTool } from "./tools/propose-find-replace.js";
export { proposeFormFillTool } from "./tools/propose-form-fill.js";
export { proposeRedactPiiTool } from "./tools/propose-redact-pii.js";
export { proposeSheetEditTool } from "./tools/propose-sheet-edit.js";
export { proposeTableStructureTool } from "./tools/propose-table-structure.js";
export { readDocumentTool } from "./tools/read-document.js";
export { readFileTool } from "./tools/read-file.js";
export { scanPiiTool } from "./tools/scan-pii.js";
export { writeNewDocumentTool } from "./tools/write-new-document.js";
export { writeNewSpreadsheetTool } from "./tools/write-new-spreadsheet.js";
export type { ProposeOutcome, ToolContext, ToolDefinition } from "./types.js";

import { listBackupsTool, restoreBackupTool } from "./tools/backups.js";
import { compareDocumentsTool } from "./tools/compare-documents.js";
import { exportDocumentTool } from "./tools/export-document.js";
import { extractFormatTemplateTool } from "./tools/extract-format-template.js";
import { findInDocumentTool } from "./tools/find-in-document.js";
import { listFormObjectsTool, proposeFormObjectTool } from "./tools/form-objects.js";
import { listFilesTool } from "./tools/list-files.js";
import { proposeCellEditTool } from "./tools/propose-cell-edit.js";
import { proposeEditTool } from "./tools/propose-edit.js";
import { proposeFindReplaceTool } from "./tools/propose-find-replace.js";
import { proposeFormFillTool } from "./tools/propose-form-fill.js";
import { proposeRedactPiiTool } from "./tools/propose-redact-pii.js";
import { proposeSheetEditTool } from "./tools/propose-sheet-edit.js";
import { proposeTableStructureTool } from "./tools/propose-table-structure.js";
import { readDocumentTool } from "./tools/read-document.js";
import { readFileTool } from "./tools/read-file.js";
import { scanPiiTool } from "./tools/scan-pii.js";
import { writeNewDocumentTool } from "./tools/write-new-document.js";
import { writeNewSpreadsheetTool } from "./tools/write-new-spreadsheet.js";

/**
 * 모든 doc 툴 배열을 반환한다 (읽기 + 쓰기).
 * core의 ToolRegistry.register()에 등록해 사용한다.
 */
export function createDocTools(_ctx: { cwd: string }) {
  // ctx는 런타임 시 ToolRegistry.setContext()로 주입되므로 여기서는 타입 힌트용
  return [
    readDocumentTool,
    compareDocumentsTool,
    listFilesTool,
    listBackupsTool,
    readFileTool,
    scanPiiTool,
    findInDocumentTool,
    extractFormatTemplateTool,
    exportDocumentTool,
    proposeEditTool,
    proposeFormFillTool,
    proposeCellEditTool,
    proposeFindReplaceTool,
    proposeRedactPiiTool,
    proposeSheetEditTool,
    proposeTableStructureTool,
    listFormObjectsTool,
    proposeFormObjectTool,
    writeNewDocumentTool,
    writeNewSpreadsheetTool,
    restoreBackupTool,
  ] as const;
}
