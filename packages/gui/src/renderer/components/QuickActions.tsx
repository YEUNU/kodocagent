import type React from "react";

export type QuickActionKey = "summary" | "review" | "redact" | "export";

interface QuickActionsProps {
  disabled: boolean;
  hasDoc: boolean;
  onAction: (key: QuickActionKey) => void;
}

export function QuickActions(props: QuickActionsProps): React.ReactElement {
  const { disabled, hasDoc, onAction } = props;
  const isDisabled = disabled || !hasDoc;

  return (
    <div className="quick">
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={isDisabled}
        onClick={() => onAction("summary")}
      >
        요약
      </button>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={isDisabled}
        onClick={() => onAction("review")}
      >
        검토
      </button>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={isDisabled}
        onClick={() => onAction("redact")}
      >
        개인정보 가리기
      </button>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={isDisabled}
        onClick={() => onAction("export")}
      >
        <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
          <path d="M5 19h14" />
        </svg>
        내보내기
      </button>
    </div>
  );
}
