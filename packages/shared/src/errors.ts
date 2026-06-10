/** 사용자에게 노출되는 에러 — message는 한국어, hint는 해결 방법 */
export class KodocError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "KodocError";
    this.hint = hint;
  }
}

/** kordoc ParseResult 실패 코드 → 한국어 메시지 (docs/SPEC.md §10) */
export const KORDOC_ERROR_MESSAGES: Record<string, string> = {
  ENCRYPTED: "암호로 보호된 문서입니다. 암호를 해제한 사본으로 다시 시도하세요.",
  DRM_PROTECTED: "DRM으로 보호된 문서는 열 수 없습니다.",
  CORRUPTED: "파일이 손상되어 읽을 수 없습니다.",
  UNSUPPORTED_FORMAT: "지원하지 않는 파일 형식입니다.",
  IMAGE_BASED_PDF: "스캔(이미지) PDF입니다. 텍스트 추출이 불가합니다.",
  FILE_TOO_LARGE: "파일이 너무 큽니다.",
  EMPTY_INPUT: "빈 파일입니다.",
};

export function kordocErrorMessage(code: string | undefined, fallback: string): string {
  return (code && KORDOC_ERROR_MESSAGES[code]) || fallback;
}
