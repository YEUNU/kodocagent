import type React from "react";
import type { DocPreviewResult } from "../types.js";

interface DocumentPreviewProps {
  activeName: string | null;
  preview: DocPreviewResult | null;
  loading: boolean;
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

function buildSrcDoc(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${paperCss}</style></head><body><div class="doc-body">${html}</div></body></html>`;
}

export function DocumentPreview(props: DocumentPreviewProps): React.ReactElement {
  const { activeName, preview, loading } = props;

  return (
    <main className="pane">
      <div className="pane__header doc-toolbar">
        <div className="tabs">
          <button type="button" className="tab tab--active">
            원본
          </button>
          <button type="button" className="tab is-disabled">
            변경본
          </button>
          <button type="button" className="tab is-disabled">
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
        {loading ? (
          <div className="preview-loading">
            <span className="spin" />
            문서 읽는 중&hellip;
          </div>
        ) : !activeName ? (
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
        ) : preview?.ok ? (
          <>
            <iframe
              className="preview-frame"
              sandbox=""
              title="문서 미리보기"
              srcDoc={buildSrcDoc(preview.html)}
            />
            <div className="approx">
              <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
              HTML 미리보기는 근사입니다 &mdash; 픽셀 정확도는 한글에서 확인하세요.
            </div>
          </>
        ) : preview && !preview.ok ? (
          <div className="preview-empty">
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4 2.8 20h18.4z" />
              <path d="M12 10v4M12 17h.01" />
            </svg>
            <div>{preview.error}</div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
