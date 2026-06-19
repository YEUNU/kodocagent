import { useEffect, useRef, useState } from "react";
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

// ── Diff renderers ─────────────────────────────────────────────────────────

/** Parse a markdown pipe-table string into header row + data rows (array of string[]). */
function parseMarkdownTable(diff: string): { headers: string[]; rows: string[][] } | null {
  const lines = diff
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  // All lines must start/end with "|" for a markdown table
  const firstLine = lines[0];
  if (!firstLine?.startsWith("|")) return null;

  const splitRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const isSeparator = (line: string) => /^\|[\s|:-]+\|$/.test(line);

  const dataLines = lines.filter((l) => !isSeparator(l));
  if (dataLines.length < 2) return null;

  const headerLine = dataLines[0];
  if (!headerLine) return null;
  const headers = splitRow(headerLine);
  const rows = dataLines.slice(1).map(splitRow);

  return { headers, rows };
}

/** Render markdown table (cell-edit / form-fill / form-object) as <table className="doc-table">. */
function renderMarkdownTable(diff: string): React.ReactNode {
  const parsed = parseMarkdownTable(diff);
  if (!parsed) {
    return <pre className="diff">{renderDiffLines(diff)}</pre>;
  }

  const { headers, rows } = parsed;
  const lastColIdx = headers.length - 1;

  return (
    <div style={{ overflowX: "auto" }}>
      <div className="paper" style={{ padding: "16px 20px" }}>
        <table className="doc-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 헤더 열은 정렬 없음
                <th key={i} style={{ textAlign: "left" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 데이터 행은 정렬 없음
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const isChanged = ci === lastColIdx;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 셀은 정렬 없음
                    <td key={ci} className={isChanged ? "cell--changed" : undefined}>
                      {cell}
                    </td>
                  );
                })}
                {/* pad missing cells */}
                {row.length < headers.length &&
                  Array.from({ length: headers.length - row.length }).map((_, pi) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 패딩 셀
                    <td key={`pad-${pi}`} />
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Parse redact-pii diff format:
 *  Line 0: "개인정보 N건 비식별 처리" (summary — unused here, shown in proposal.summary)
 *  Lines 1+: "- {타입}: {N}건 → {마스킹예시}"
 */
interface PiiEntry {
  type: string;
  count: string;
  example: string;
}

function parsePiiDiff(diff: string): PiiEntry[] {
  const entries: PiiEntry[] = [];
  for (const line of diff.split("\n")) {
    const trimmed = line.replace(/^-\s*/, "").trim();
    // "전화번호: 2건 → 010-****-1234"
    const match = trimmed.match(/^(.+?):\s*(\d+)건\s*→\s*(.+)$/);
    if (match?.[1] && match[2] && match[3]) {
      entries.push({ type: match[1].trim(), count: match[2], example: match[3].trim() });
    }
  }
  return entries;
}

function renderPiiDiff(diff: string): React.ReactNode {
  const entries = parsePiiDiff(diff);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Honesty banner */}
      <div className="banner banner--warn">
        <AlertIcon />
        <span>원문 값은 표시하지 않습니다 — 유형·위치·마스킹 결과만</span>
      </div>

      {/* PII chips */}
      {entries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {entries.map((entry, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: PII 항목은 정렬 없음
            <span key={i} className="chip chip--pii">
              {entry.type} {entry.count}건
              {entry.example && (
                <>
                  {" "}
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-xs)" }}>
                    {entry.example}
                  </code>
                </>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Fallback: if no entries parsed, show raw diff */}
      {entries.length === 0 && diff.trim() && <pre className="diff">{renderDiffLines(diff)}</pre>}
    </div>
  );
}

/** Unified diff / plain text renderer. */
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

/** Top-level diff dispatcher by kind and diff format. */
function renderDiff(kind: string, diff: string): React.ReactNode {
  if (kind === "redact-pii") {
    return renderPiiDiff(diff);
  }

  // Markdown table format: cell-edit, form-fill, form-object (and sheet-edit if tabular)
  const isMarkdownTable = diff.trimStart().startsWith("|");
  if (isMarkdownTable) {
    return renderMarkdownTable(diff);
  }

  // Unified diff / plain text
  return <pre className="diff">{renderDiffLines(diff)}</pre>;
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

  // Tab/Shift+Tab 포커스 트랩
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    function handleKeyDown(e: KeyboardEvent): void {
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
  }, []);

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
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal" ref={modalRef}>
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
          {renderDiff(kind, diff ?? "")}

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
