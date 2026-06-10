/**
 * @kodocagent/doc-tools — 문서 읽기/쓰기 툴 (M2에서 구현)
 *
 * 설계: docs/SPEC.md §6(툴 명세), §7(스테이징→승인 파이프라인)
 * - 읽기: read_document / compare_documents / list_files / read_file
 * - 쓰기(승인 필요): propose_edit / propose_form_fill / propose_sheet_edit /
 *   write_new_document / write_new_spreadsheet
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
