import { useEffect, useRef, useState } from "react";
import type { Proposal } from "../types.js";
import { ProposalDiff } from "./ProposalDiff.js";

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

// ── Icons ──────────────────────────────────────────────────────────────────

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

// ── Main component ─────────────────────────────────────────────────────────

export function ApprovalDialog({ proposal, onRespond }: ApprovalDialogProps): React.ReactElement {
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = `approval-title-${proposal.id}`;

  const { id, kind, targetPath, summary, diff, warnings, willConvertFormat } = proposal;
  const kindLabel = KIND_LABEL[kind] ?? kind;

  // 마운트 시 첫 인터랙티브 요소에 포커스
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const first = modal.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, []);

  // Tab/Shift+Tab 포커스 트랩 + Escape 처리
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleCancelReason은 상태 setter만 사용해 동작이 안정적 — showReason 변화에만 재바인딩하면 충분
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    function handleKeyDown(e: KeyboardEvent): void {
      // Escape: 거절 사유 입력 중이면 사유 입력만 취소 (모달 자체는 닫지 않음 — 승인/거절 필수)
      if (e.key === "Escape" && showReason) {
        e.preventDefault();
        handleCancelReason();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        modal?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    modal.addEventListener("keydown", handleKeyDown);
    return () => modal.removeEventListener("keydown", handleKeyDown);
  }, [showReason]);

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
    <div className="modal-scrim">
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* ── Header ── */}
        <div className="modal__header">
          <div className="modal__title" id={titleId}>
            {kindLabel} — 승인 요청
          </div>
          <div className="row" style={{ marginTop: "8px", flexWrap: "wrap", gap: "6px" }}>
            <span className="chip chip--tool">{kind}</span>
            <span className="chip">
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

        {/* ── Body ── */}
        <div className="modal__body">
          <div className="h-section">변경 요약</div>
          <p className="t-sm">{summary}</p>

          <div className="h-section">변경 내용</div>
          <ProposalDiff kind={kind} diff={diff ?? ""} />

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

        {/* ── Footer ── */}
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
