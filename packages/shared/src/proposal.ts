export type ProposalKind =
  | "edit"
  | "form-fill"
  | "sheet-edit"
  | "new-document"
  | "new-spreadsheet"
  | "cell-edit"
  | "form-object"
  | "find-replace"
  | "table-structure"
  | "restore"
  | "redact-pii"
  | "export";

/** propose_* 툴이 스테이징 후 승인 요청에 담는 페이로드 (docs/SPEC.md §7) */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** 저장 대상 경로 (승인 전까지 무변경) */
  targetPath: string;
  /** 스테이징된 결과물 경로 */
  stagedPath: string;
  /** 모델이 작성한 변경 요약 */
  summary: string;
  /** 렌더 가능한 diff (unified diff 또는 셀 변경표) */
  diff: string;
  warnings: string[];
  /** 포맷 변환이 일어나는 경우 명시 (예: ".hwp → .hwpx") */
  willConvertFormat?: string;
}

export interface ApprovalResult {
  approved: boolean;
  reason?: string;
}

/** CLI(clack)/GUI(다이얼로그)가 주입 — core는 이 인터페이스만 안다 */
export type ApprovalHandler = (proposal: Proposal) => Promise<ApprovalResult>;
