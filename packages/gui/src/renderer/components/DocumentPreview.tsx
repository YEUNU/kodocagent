import type React from "react";
import { useEffect, useState } from "react";
import type { DocPreviewResult, Proposal } from "../types.js";
import { ProposalDiff } from "./ProposalDiff.js";

type PreviewTab = "original" | "changed" | "diff";

interface DocumentPreviewProps {
  activeName: string | null;
  preview: DocPreviewResult | null;
  loading: boolean;
  /**
   * 현재 활성 문서에 대한 대기 중 제안(승인 대기). 같은 파일을 대상으로 할 때만 App에서 전달한다.
   * 있으면 "변경본"·"diff" 탭이 활성화된다.
   */
  proposal?: Proposal | null;
  /**
   * 스테이징된 결과물(proposal.stagedPath)의 미리보기를 로드하는 콜백.
   * "변경본" 탭을 처음 열 때 1회 호출된다. (App이 window.kodoc.doc.preview로 위임)
   */
  onRequestStagedPreview?: (stagedPath: string) => Promise<DocPreviewResult>;
}

const paperCss = `
body {
  margin: 0;
  background: #fff;
  color: #1a1d24;
  font-family: system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  font-size: 14px;
  line-height: 1.7;
  padding: 32px 36px;
}
.doc-body {
  max-width: 720px;
  margin: 0 auto;
}
h1 { font-size: 20px; }
h2 { font-size: 16px; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
}
th, td {
  border: 1px solid #e2e5ea;
  padding: 7px 11px;
  text-align: left;
}
th { background: #f5f6f8; }
img { max-width: 100%; }
`;

/**
 * CSP: 외부 리소스(스크립트·외부 CSS·외부 연결·외부 이미지) 차단, 인라인 스타일·임베드(data:)
 * 이미지만 허용. 신뢰할 수 없는 문서의 외부 이미지 로드로 IP가 추적되는 것을 막는다.
 */
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none';";

function buildSrcDoc(html: string): string {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>${paperCss}</style></head><body><div class="doc-body">${html}</div></body></html>`;
}

/** 원본/변경본 공통: DocPreviewResult를 iframe 또는 오류 박스로 렌더. */
function PreviewBody(props: {
  result: DocPreviewResult | null;
  loading: boolean;
  title: string;
}): React.ReactElement | null {
  const { result, loading, title } = props;
  if (loading) {
    return (
      <div className="preview-loading">
        <span className="spin" />
        문서 읽는 중&hellip;
      </div>
    );
  }
  if (result?.ok) {
    return (
      <>
        <iframe
          className="preview-frame"
          sandbox="allow-same-origin"
          title={title}
          srcDoc={buildSrcDoc(result.html)}
        />
        <div className="approx">
          <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
          </svg>
          HTML 미리보기는 근사입니다 &mdash; 픽셀 정확도는 한글에서 확인하세요.
        </div>
      </>
    );
  }
  if (result && !result.ok) {
    return (
      <div className="preview-empty">
        <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4 2.8 20h18.4z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
        <div>{result.error}</div>
      </div>
    );
  }
  return null;
}

export function DocumentPreview(props: DocumentPreviewProps): React.ReactElement {
  const { activeName, preview, loading, proposal, onRequestStagedPreview } = props;
  const hasProposal = !!proposal;

  const [tab, setTab] = useState<PreviewTab>("original");
  const [staged, setStaged] = useState<DocPreviewResult | null>(null);
  const [stagedLoading, setStagedLoading] = useState(false);

  // 제안이 사라지거나 바뀌면 탭/스테이지 상태를 초기화한다(다른 제안의 변경본이 남지 않도록).
  // biome-ignore lint/correctness/useExhaustiveDependencies: proposal.id 변화에만 반응(객체 동일성 무관)
  useEffect(() => {
    setTab("original");
    setStaged(null);
    setStagedLoading(false);
  }, [proposal?.id]);

  // "변경본" 탭을 열었고 아직 스테이지 미리보기를 로드하지 않았으면 1회 로드.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 탭/제안 전환 시에만 트리거
  useEffect(() => {
    if (tab !== "changed") return;
    if (!proposal || !onRequestStagedPreview) return;
    if (staged !== null || stagedLoading) return;
    setStagedLoading(true);
    onRequestStagedPreview(proposal.stagedPath)
      .then(setStaged)
      .catch((err: unknown) =>
        setStaged({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setStagedLoading(false));
  }, [tab, proposal?.id]);

  function tabClass(t: PreviewTab, enabled: boolean): string {
    if (!enabled) return "tab is-disabled";
    return tab === t ? "tab tab--active" : "tab";
  }

  return (
    <main className="pane">
      <div className="pane__header doc-toolbar">
        <div className="tabs">
          <button
            type="button"
            className={tabClass("original", true)}
            onClick={() => setTab("original")}
          >
            원본
          </button>
          <button
            type="button"
            className={tabClass("changed", hasProposal)}
            disabled={!hasProposal}
            onClick={() => hasProposal && setTab("changed")}
          >
            변경본
          </button>
          <button
            type="button"
            className={tabClass("diff", hasProposal)}
            disabled={!hasProposal}
            onClick={() => hasProposal && setTab("diff")}
          >
            diff
          </button>
        </div>
        <div className="row gap-4">
          <span className="chip is-disabled">
            <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6" />
              <path d="m20 20-3.4-3.4" />
            </svg>
            찾기
          </span>
          {activeName && <span className="chip">{activeName}</span>}
        </div>
      </div>

      <div className="doc-canvas">
        {!activeName && !hasProposal ? (
          <div className="preview-empty">
            <svg className="ico ico--xl" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 3v5h5" />
              <path d="M9 13h6M9 17h5" />
            </svg>
            <div>
              왼쪽에서 문서를 선택하거나
              <br />
              파일을 끌어다 놓으세요
            </div>
          </div>
        ) : tab === "diff" && proposal ? (
          <div className="diff-pane">
            <ProposalDiff kind={proposal.kind} diff={proposal.diff ?? ""} />
          </div>
        ) : tab === "changed" && proposal ? (
          <PreviewBody result={staged} loading={stagedLoading} title="변경본 미리보기" />
        ) : (
          <PreviewBody result={preview} loading={loading} title="문서 미리보기" />
        )}
      </div>
    </main>
  );
}
