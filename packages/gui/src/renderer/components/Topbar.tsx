import type React from "react";

interface TopbarProps {
  brand: string;
  model: string | null;
  cwd: string;
  appState: "idle" | "running" | "config-missing";
  cumulativeInput: number;
  cumulativeOutput: number;
  contextPct: number | null;
  onSelectCwd: () => void;
  onNewSession: () => void;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function shortCwd(cwd: string): string {
  if (!cwd) return "";
  const sep = cwd.includes("/") ? "/" : "\\";
  const parts = cwd.split(sep).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

const STATE_LABEL: Record<TopbarProps["appState"], string> = {
  idle: "대기",
  running: "작업 중…",
  "config-missing": "설정 필요",
};

export function Topbar(props: TopbarProps): React.ReactElement {
  const {
    brand,
    model,
    cwd,
    appState,
    cumulativeInput,
    cumulativeOutput,
    contextPct,
    onSelectCwd,
    onNewSession,
  } = props;

  return (
    <header className="topbar">
      {/* 좌측 */}
      <div className="row gap-12">
        <span className="topbar__brand">
          <span className="brand-mark">k</span> {brand}
        </span>
        <button type="button" className="topbar__folder" onClick={onSelectCwd}>
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          {cwd ? shortCwd(cwd) : "폴더 선택"}
        </button>
      </div>

      {/* 우측 */}
      <div className="topbar__right">
        {/* 누적 토큰 */}
        <span className="topbar__tokens">
          누적{" "}
          <b>
            입력 {fmtTokens(cumulativeInput)}·출력 {fmtTokens(cumulativeOutput)}
          </b>{" "}
          토큰
        </span>

        {/* 컨텍스트 게이지 */}
        {contextPct != null && (
          <span className="gauge">
            컨텍스트{" "}
            <span className="gauge__track">
              <span
                className={`gauge__fill${contextPct > 85 ? " gauge__fill--warn" : ""}`}
                style={{ width: `${contextPct}%` }}
              />
            </span>{" "}
            {contextPct}%
          </span>
        )}

        {/* 모델 버튼 */}
        <button type="button" className="model-pick">
          {model ?? "(기본값)"}
          <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9.5 6 6 6-6" />
          </svg>
        </button>

        {/* 상태 */}
        <span className="topbar__state" data-state={appState}>
          {STATE_LABEL[appState]}
        </span>

        {/* 새 세션 */}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onNewSession}
          disabled={appState === "running"}
        >
          새 세션
        </button>
      </div>
    </header>
  );
}
