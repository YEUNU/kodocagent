import { useCallback, useState } from "react";
import type { Proposal } from "../types.js";

interface ApprovalDialogProps {
  proposal: Proposal;
  onRespond: (proposalId: string, approved: boolean, reason?: string) => void;
}

export function ApprovalDialog({ proposal, onRespond }: ApprovalDialogProps): React.ReactElement {
  const [showReasonInput, setShowReasonInput] = useState(false);
  const [reason, setReason] = useState("");

  const handleApprove = useCallback(() => {
    onRespond(proposal.id, true);
  }, [proposal.id, onRespond]);

  const handleReject = useCallback(() => {
    onRespond(proposal.id, false);
  }, [proposal.id, onRespond]);

  const handleRejectWithReason = useCallback(() => {
    if (!showReasonInput) {
      setShowReasonInput(true);
      return;
    }
    onRespond(proposal.id, false, reason.trim() || undefined);
  }, [proposal.id, onRespond, showReasonInput, reason]);

  const handleCancelReason = useCallback(() => {
    setShowReasonInput(false);
    setReason("");
  }, []);

  const kindLabel: Record<string, string> = {
    edit: "문서 수정",
    "form-fill": "폼 채우기",
    "sheet-edit": "시트 수정",
    "new-document": "새 문서 생성",
    "new-spreadsheet": "새 스프레드시트 생성",
  };

  return (
    <div className="approval-overlay" role="dialog" aria-modal="true" aria-label="변경 승인">
      <div className="approval-dialog">
        <header className="approval-dialog__header">
          <h2 className="approval-dialog__title">
            {kindLabel[proposal.kind] ?? proposal.kind} — 승인 요청
          </h2>
          <div className="approval-dialog__target">
            <span className="approval-dialog__label">대상 파일:</span>
            <code className="approval-dialog__path">{proposal.targetPath}</code>
          </div>
          {proposal.willConvertFormat && (
            <div className="approval-dialog__convert">
              <span className="approval-dialog__warn-icon">⚠</span>
              포맷 변환: {proposal.willConvertFormat}
            </div>
          )}
          {proposal.warnings.length > 0 && (
            <ul className="approval-dialog__warnings">
              {proposal.warnings.map((w) => (
                <li key={w} className="approval-dialog__warning-item">
                  <span className="approval-dialog__warn-icon">⚠</span>
                  {w}
                </li>
              ))}
            </ul>
          )}
        </header>

        <div className="approval-dialog__summary">
          <strong>변경 요약:</strong>
          <p>{proposal.summary}</p>
        </div>

        <div className="approval-dialog__diff-wrapper">
          <div className="approval-dialog__diff-label">변경 내용 (diff)</div>
          <pre className="approval-dialog__diff">{renderDiff(proposal.diff)}</pre>
        </div>

        {showReasonInput && (
          <div className="approval-dialog__reason">
            <label htmlFor="reject-reason" className="approval-dialog__reason-label">
              거절 사유:
            </label>
            <textarea
              id="reject-reason"
              className="approval-dialog__reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="거절 사유를 입력하세요 (선택 사항)"
              rows={3}
              // biome-ignore lint/a11y/noAutofocus: 거절 사유 입력 시 즉시 포커스 — 의도된 UX
              autoFocus
            />
            <div className="approval-dialog__reason-actions">
              <button
                type="button"
                className="approval-dialog__btn approval-dialog__btn--reject"
                onClick={handleRejectWithReason}
              >
                거절 확인
              </button>
              <button
                type="button"
                className="approval-dialog__btn approval-dialog__btn--secondary"
                onClick={handleCancelReason}
              >
                취소
              </button>
            </div>
          </div>
        )}

        {!showReasonInput && (
          <div className="approval-dialog__actions">
            <button
              type="button"
              className="approval-dialog__btn approval-dialog__btn--approve"
              onClick={handleApprove}
            >
              승인
            </button>
            <button
              type="button"
              className="approval-dialog__btn approval-dialog__btn--reject"
              onClick={handleReject}
            >
              거절
            </button>
            <button
              type="button"
              className="approval-dialog__btn approval-dialog__btn--secondary"
              onClick={handleRejectWithReason}
            >
              거절 + 사유 입력
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** diff 텍스트를 라인별로 파싱해 컬러 span 배열 반환 */
function renderDiff(diff: string): React.ReactNode {
  if (!diff) return <span className="diff-line diff-line--context">(변경 내용 없음)</span>;
  return diff.split("\n").map((line, i) => {
    let cls = "diff-line diff-line--context";
    if (line.startsWith("+")) cls = "diff-line diff-line--add";
    else if (line.startsWith("-")) cls = "diff-line diff-line--remove";
    else if (line.startsWith("@@")) cls = "diff-line diff-line--hunk";
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: diff 라인은 정렬 없음 — index가 안정 키
      <span key={i} className={cls}>
        {line}
        {"\n"}
      </span>
    );
  });
}
