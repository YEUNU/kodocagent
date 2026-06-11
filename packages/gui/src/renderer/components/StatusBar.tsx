interface StatusBarProps {
  provider: string;
  model: string | null;
  cwd: string;
  appState: "idle" | "running" | "config-missing";
  onNewSession: () => void;
  onSelectCwd: () => void;
}

export function StatusBar({
  provider,
  model,
  cwd,
  appState,
  onNewSession,
  onSelectCwd,
}: StatusBarProps): React.ReactElement {
  const modelDisplay = model ?? "(기본값)";
  const cwdDisplay = cwd ? shortenPath(cwd) : "폴더 미선택";

  const stateLabel: Record<string, string> = {
    idle: "대기",
    running: "응답 중...",
    "config-missing": "설정 필요",
  };

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__app-name">kodocagent</span>
        <span className="status-bar__sep">|</span>
        <span className="status-bar__provider">
          {provider} / {modelDisplay}
        </span>
        <span className="status-bar__sep">|</span>
        <span className="status-bar__state" data-state={appState}>
          {stateLabel[appState] ?? appState}
        </span>
      </div>
      <div className="status-bar__right">
        <button
          type="button"
          className="status-bar__btn"
          onClick={onSelectCwd}
          title={cwd || "작업 폴더 선택"}
          aria-label={`작업 폴더: ${cwdDisplay}`}
        >
          📁 {cwdDisplay}
        </button>
        <button
          type="button"
          className="status-bar__btn"
          onClick={onNewSession}
          title="새 세션 시작"
          aria-label="새 세션"
          disabled={appState === "running"}
        >
          새 세션
        </button>
      </div>
    </div>
  );
}

/** 긴 경로를 말줄임으로 단축 */
function shortenPath(p: string): string {
  const MAX = 40;
  if (p.length <= MAX) return p;
  const parts = p.split(/[/\\]/);
  if (parts.length <= 2) return `…${p.slice(-(MAX - 1))}`;
  return `…/${parts.slice(-2).join("/")}`;
}
