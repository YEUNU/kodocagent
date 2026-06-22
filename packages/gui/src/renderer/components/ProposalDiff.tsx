/**
 * ProposalDiff — proposal.diff를 kind별로 렌더하는 공유 컴포넌트.
 *
 * ApprovalDialog(승인 모달)와 DocumentPreview("diff" 탭)가 동일한 산출을 재사용한다.
 *
 * 보안 동작(반드시 보존):
 * - redact-pii diff는 원문 평문 값을 절대 노출하지 않는다. 유형·건수·마스킹 예시만 칩으로
 *   보여주고, "원문 값은 표시하지 않습니다" 허니스티 배너를 항상 함께 렌더한다.
 *   (diff 문자열 자체에 원문이 들어오지 않는 것이 propose 측 계약이며, 여기서는 추가로
 *   파싱 실패 시에도 원문 평문이 그대로 흘러가지 않도록 redact-pii 분기를 우선한다.)
 */

import type React from "react";

function AlertIcon(): React.ReactElement {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4 2.8 20h18.4z" />
      <path d="M12 10v4M12 17h.01" />
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

      {/* Fallback: if no entries parsed, show only the summary line (원문 평문 비노출 보장) */}
      {entries.length === 0 && diff.trim() && (
        <pre className="diff">{renderDiffLines(diff.split("\n")[0] ?? "")}</pre>
      )}
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

interface ProposalDiffProps {
  kind: string;
  diff: string;
}

/**
 * Top-level diff dispatcher by kind and diff format.
 * - redact-pii: 원문 비노출 칩 + 허니스티 배너
 * - markdown 표(`|`로 시작): cell-edit / form-fill / form-object → doc-table
 * - 그 외: unified diff / plain text
 */
export function ProposalDiff({ kind, diff }: ProposalDiffProps): React.ReactElement {
  if (kind === "redact-pii") {
    return <>{renderPiiDiff(diff)}</>;
  }

  // Markdown table format: cell-edit, form-fill, form-object (and sheet-edit if tabular)
  const isMarkdownTable = diff.trimStart().startsWith("|");
  if (isMarkdownTable) {
    return <>{renderMarkdownTable(diff)}</>;
  }

  // Unified diff / plain text
  return <pre className="diff">{renderDiffLines(diff)}</pre>;
}
