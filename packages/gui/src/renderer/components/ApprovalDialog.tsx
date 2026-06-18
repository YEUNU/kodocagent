import { useState } from "react";
import type { Proposal } from "../types.js";

interface ApprovalDialogProps {
  proposal: Proposal;
  onRespond: (proposalId: string, approved: boolean, reason?: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  edit: "문서 수정",
  "find-replace": "찾기·바꾸기",
  "cell-edit": "표 셀 수정",
  "table-structure": "표 구조 변경",
  "sheet-edit": "시트 셀 수정",
  "redact-pii": "개인정보 가리기",
  "form-fill": "양식 채우기",
  "form-object": "양식 객체",
  export: "내보내기",
  restore: "되돌리기",
  "new-document": "새 문서",
  "new-spreadsheet": "새 스프레드시트",
};

function DocIcon(): React.ReactElement {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h5" />
    </svg>
  );
}

function AlertIcon(): React.ReactElement {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4 2.8 20h18.4z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

function LockIcon(): React.ReactElement {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function XIcon(): React.ReactElement {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5 10 17 19 7" />
    </svg>
  );
}

function renderDiffLines(diff: string): React.ReactNode {
  if (!diff) {
    return (
      <span className="diff__line diff__line--ctx" key="empty">
        (변경 내용 없음){"\n"}
      </span>
    );
  }
  return diff.split("\n").map((line, i) => {
    let cls = "diff__line diff__line--ctx";
    if (line.startsWith("+")) cls = "diff__line diff__line--add";
    else if (line.startsWith("-")) cls = "diff__line diff__line--remove";
    else if (line.startsWith("@@")) cls = "diff__line diff__line--hunk";
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: diff 라인은 정렬 없음 — index가 안정 키
      <span className={cls} key={i}>
        {line}
        {"\n"}
      </span>
    );
  });
}

export function ApprovalDialog({ proposal, onRespond }: ApprovalDialogProps): React.ReactElement {
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");

  const { id, kind, targetPath, summary, diff, warnings, willConvertFormat } = proposal;
  const kindLabel = KIND_LABEL[kind] ?? kind;

  function handleApprove() {
    onRespond(id, true);
  }

  function handleRejectConfirm() {
    onRespond(id, false, reason.trim() || undefined);
  }

  function handleCancelReason() {
    setShowReason(false);
    setReason("");
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal__header">
          <div className="modal__title">{kindLabel} — 승인 요청</div>
          <div className="row gap-4" style={{ marginTop: "8px" }}>
            <span className="chip chip--tool">
              <DocIcon />
              {targetPath}
            </span>
          </div>
          {willConvertFormat && (
            <div className="banner banner--warn" style={{ marginTop: "8px" }}>
              <AlertIcon />
              포맷 변환: {willConvertFormat}
            </div>
          )}
          {warnings.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 경고 목록은 정렬 없음
            <div className="banner banner--warn" key={i} style={{ marginTop: "8px" }}>
              <AlertIcon />
              {w}
            </div>
          ))}
        </div>

        <div className="modal__body">
          <div className="h-section">변경 요약</div>
          <p className="t-sm">{summary}</p>

          <div className="h-section">변경 내용</div>
          <pre className="diff">{renderDiffLines(diff)}</pre>

          <span className="safe-note">
            <LockIcon />
            승인 전까지 원본은 바뀌지 않습니다
          </span>

          {showReason && (
            <div style={{ marginTop: "16px" }}>
              <label className="field-label" htmlFor="reject-reason">
                거절 사유 (선택)
              </label>
              <textarea
                id="reject-reason"
                className="field"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="거절 사유를 입력하세요"
                rows={3}
                // biome-ignore lint/a11y/noAutofocus: 거절 사유 입력 시 즉시 포커스 — 의도된 UX
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="modal__footer">
          <div className="modal__footer-actions">
            {!showReason ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setShowReason(true)}
                >
                  <XIcon />
                  거절
                </button>
                <button type="button" className="btn btn--approve" onClick={handleApprove}>
                  <CheckIcon />
                  승인
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn--ghost" onClick={handleCancelReason}>
                  <XIcon />
                  취소
                </button>
                <button type="button" className="btn btn--danger" onClick={handleRejectConfirm}>
                  <XIcon />
                  거절 확인
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
