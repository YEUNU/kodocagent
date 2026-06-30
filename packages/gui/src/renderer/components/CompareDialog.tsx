import { useEffect, useRef } from "react";
import type { ProviderCompareResult } from "../types.js";

interface CompareDialogProps {
  prompt: string;
  loading: boolean;
  results: ProviderCompareResult[] | null;
  error: string | null;
  onClose: () => void;
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Gemini",
};

/**
 * 멀티 프로바이더 비교 결과 모달 — 같은 질문에 대한 각 프로바이더 응답을 세로로 나란히 보여준다.
 * 읽기 전용(편집 없음). 개별 프로바이더 실패는 해당 카드에만 표시된다.
 */
export function CompareDialog({
  prompt,
  loading,
  results,
  error,
  onClose,
}: CompareDialogProps): React.ReactElement {
  const modalRef = useRef<HTMLDivElement>(null);

  // 마운트 시 첫 인터랙티브 요소에 포커스
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const first = modal.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, []);

  // Tab 포커스 트랩 + Escape로 닫기
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
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
  }, [onClose]);

  return (
    // 읽기 전용 비교 모달 — 배경(스크림) 클릭으로 닫기(직접 클릭만). 키보드 닫기는 Escape·닫기 버튼이 담당.
    // biome-ignore lint/a11y: 배경 오버레이는 마우스 편의용 — 다이얼로그 자체는 role/aria·포커스 트랩·Escape로 접근 가능
    <div
      className="modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="모델 비교 결과"
      >
        <div className="modal__header">
          <div className="modal__title">모델 비교</div>
          <div className="t-sm t-muted" style={{ wordBreak: "break-word" }}>
            “{prompt}”
          </div>
        </div>

        <div className="modal__body">
          {loading && (
            <div className="verify-note">
              <span className="spin" /> 여러 모델에 동시에 물어보는 중…
            </div>
          )}

          {error && (
            <div className="banner banner--warn" role="alert">
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4 2.8 20h18.4z" />
                <path d="M12 10v4M12 17h.01" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {results?.map((r) => (
            <div key={r.provider} className="card" style={{ padding: "12px 14px" }}>
              <div className="row between" style={{ marginBottom: "8px" }}>
                <span className="row gap-4">
                  <span className="badge badge--accent">
                    {PROVIDER_LABEL[r.provider] ?? r.provider}
                  </span>
                  <span className="t-sm t-muted t-mono">{r.model}</span>
                </span>
                <span className="t-xs t-faint">
                  {r.ok
                    ? `${(r.ms / 1000).toFixed(1)}s · ${r.inputTokens ?? 0}→${r.outputTokens ?? 0} 토큰`
                    : "실패"}
                </span>
              </div>
              {r.ok ? (
                <div className="msg-text">{r.text}</div>
              ) : (
                <div className="t-remove t-sm">{r.error ?? "오류가 발생했습니다."}</div>
              )}
            </div>
          ))}
        </div>

        <div className="modal__footer">
          <span className="t-xs t-faint">읽기 전용 비교 — 문서는 변경되지 않습니다.</span>
          <div className="modal__footer-actions">
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
