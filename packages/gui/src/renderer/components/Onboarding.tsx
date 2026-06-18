import { useState } from "react";
import type { ConfigSnapshot } from "../types.js";

interface OnboardingProps {
  onComplete: (snapshot: ConfigSnapshot) => void;
}

type Provider = "anthropic" | "openai" | "google";

const PROVIDERS: { id: Provider; label: string; tabLabel: string }[] = [
  { id: "anthropic", label: "Claude", tabLabel: "Claude" },
  { id: "openai", label: "OpenAI", tabLabel: "OpenAI" },
  { id: "google", label: "Gemini", tabLabel: "Gemini" },
];

export function Onboarding(props: OnboardingProps): React.ReactElement {
  const { onComplete } = props;

  const [selected, setSelected] = useState<Provider>("anthropic");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [lawApiKey, setLawApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [showLawKey, setShowLawKey] = useState(false);

  const selectedKey =
    selected === "anthropic" ? anthropicKey : selected === "openai" ? openaiKey : googleKey;
  const canSave = !saving && selectedKey.trim().length > 0;

  function handleSave(): void {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    const values = {
      provider: selected,
      apiKeys: {
        anthropic: anthropicKey.trim() || undefined,
        openai: openaiKey.trim() || undefined,
        google: googleKey.trim() || undefined,
      },
      lawApiKey: lawApiKey.trim() || undefined,
    };

    window.kodoc.config
      .save(values)
      .then(onComplete)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`저장 중 오류가 발생했습니다: ${msg}`);
      })
      .finally(() => {
        setSaving(false);
      });
  }

  function handleSkip(): void {
    window.kodoc.config
      .get()
      .then(onComplete)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`건너뛰기 중 오류: ${msg}`);
      });
  }

  return (
    <div className="config-missing">
      <div
        className="wizard"
        style={{
          width: "560px",
          background: "var(--chrome-surface)",
          border: "1px solid var(--chrome-border)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow-2)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* ── 헤더 ── */}
        <div
          style={{
            padding: "22px 24px 16px",
            borderBottom: "1px solid var(--chrome-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <span className="brand-mark">k</span>
            <span style={{ fontSize: "var(--t-lg)", fontWeight: 700, color: "var(--text-strong)" }}>
              kodocagent 설정
            </span>
          </div>
          <p style={{ fontSize: "var(--t-sm)", color: "var(--text-muted)", lineHeight: 1.5 }}>
            사용할 AI 제공자와 API 키를 입력하세요. (키는 이 기기{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>~/.kodocagent/config.json</span> 에만
            저장됩니다.)
          </p>
        </div>

        {/* ── 본문 ── */}
        <div
          style={{
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            overflowY: "auto",
          }}
        >
          {/* 에러 배너 */}
          {error !== null && (
            <div className="banner banner--warn" role="alert">
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4 2.8 20h18.4z" />
                <path d="M12 10v4M12 17h.01" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* 제공자 선택 탭 */}
          <div>
            <span className="field-label">AI 제공자</span>
            <div className="tabs">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`tab${selected === p.id ? " tab--active" : ""}`}
                  onClick={() => setSelected(p.id)}
                >
                  {p.tabLabel}
                </button>
              ))}
            </div>
          </div>

          {/* API 키 입력 영역 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {/* Claude API 키 */}
            <div
              style={{
                background: "var(--chrome-elevated)",
                border: `1px solid ${selected === "anthropic" ? "var(--accent-line)" : "var(--chrome-border)"}`,
                borderRadius: "var(--r-md)",
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="8" cy="15" r="4" />
                  <path d="M11 12l9-9M17 6l2 2M14.5 8.5l2 2" />
                </svg>
                <span
                  style={{ fontSize: "var(--t-md)", fontWeight: 600, color: "var(--text-strong)" }}
                >
                  Claude
                </span>
                {selected === "anthropic" ? (
                  <span className="badge badge--accent">필수</span>
                ) : (
                  <span className="badge badge--neutral">선택</span>
                )}
              </div>
              <div className="field-row" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="key-anthropic">
                  Claude API 키{selected === "anthropic" && <span className="req">*</span>}
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="key-anthropic"
                    className="field"
                    type={showAnthropicKey ? "text" : "password"}
                    placeholder="sk-ant-…  (비워 두면 사용 안 함)"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    style={{ paddingRight: "40px", fontFamily: "var(--font-mono)" }}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAnthropicKey((v) => !v)}
                    aria-label={showAnthropicKey ? "키 숨기기" : "키 보기"}
                    style={{
                      position: "absolute",
                      right: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-faint)",
                      display: "flex",
                      alignItems: "center",
                      padding: 0,
                    }}
                  >
                    <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
                      {showAnthropicKey ? (
                        <>
                          <path d="M3 3l18 18" />
                          <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
                          <path d="M9.3 5.3A9.7 9.7 0 0 1 12 5c5 0 9 5 9 7a13 13 0 0 1-2.2 2.9M6.1 6.2C3.8 7.7 3 11 3 12c1 2 3 5 7 6" />
                        </>
                      ) : (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* OpenAI API 키 */}
            <div
              style={{
                background: "var(--chrome-elevated)",
                border: `1px solid ${selected === "openai" ? "var(--accent-line)" : "var(--chrome-border)"}`,
                borderRadius: "var(--r-md)",
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="8" cy="15" r="4" />
                  <path d="M11 12l9-9M17 6l2 2M14.5 8.5l2 2" />
                </svg>
                <span
                  style={{ fontSize: "var(--t-md)", fontWeight: 600, color: "var(--text-strong)" }}
                >
                  OpenAI
                </span>
                {selected === "openai" ? (
                  <span className="badge badge--accent">필수</span>
                ) : (
                  <span className="badge badge--neutral">선택</span>
                )}
              </div>
              <div className="field-row" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="key-openai">
                  OpenAI API 키{selected === "openai" && <span className="req">*</span>}
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="key-openai"
                    className="field"
                    type={showOpenaiKey ? "text" : "password"}
                    placeholder="sk-…  (비워 두면 사용 안 함)"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    style={{ paddingRight: "40px", fontFamily: "var(--font-mono)" }}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOpenaiKey((v) => !v)}
                    aria-label={showOpenaiKey ? "키 숨기기" : "키 보기"}
                    style={{
                      position: "absolute",
                      right: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-faint)",
                      display: "flex",
                      alignItems: "center",
                      padding: 0,
                    }}
                  >
                    <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
                      {showOpenaiKey ? (
                        <>
                          <path d="M3 3l18 18" />
                          <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
                          <path d="M9.3 5.3A9.7 9.7 0 0 1 12 5c5 0 9 5 9 7a13 13 0 0 1-2.2 2.9M6.1 6.2C3.8 7.7 3 11 3 12c1 2 3 5 7 6" />
                        </>
                      ) : (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Gemini API 키 */}
            <div
              style={{
                background: "var(--chrome-elevated)",
                border: `1px solid ${selected === "google" ? "var(--accent-line)" : "var(--chrome-border)"}`,
                borderRadius: "var(--r-md)",
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="8" cy="15" r="4" />
                  <path d="M11 12l9-9M17 6l2 2M14.5 8.5l2 2" />
                </svg>
                <span
                  style={{ fontSize: "var(--t-md)", fontWeight: 600, color: "var(--text-strong)" }}
                >
                  Gemini
                </span>
                {selected === "google" ? (
                  <span className="badge badge--accent">필수</span>
                ) : (
                  <span className="badge badge--neutral">선택</span>
                )}
              </div>
              <div className="field-row" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="key-google">
                  Gemini API 키{selected === "google" && <span className="req">*</span>}
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="key-google"
                    className="field"
                    type={showGoogleKey ? "text" : "password"}
                    placeholder="AIza…  (비워 두면 사용 안 함)"
                    value={googleKey}
                    onChange={(e) => setGoogleKey(e.target.value)}
                    style={{ paddingRight: "40px", fontFamily: "var(--font-mono)" }}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowGoogleKey((v) => !v)}
                    aria-label={showGoogleKey ? "키 숨기기" : "키 보기"}
                    style={{
                      position: "absolute",
                      right: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-faint)",
                      display: "flex",
                      alignItems: "center",
                      padding: 0,
                    }}
                  >
                    <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
                      {showGoogleKey ? (
                        <>
                          <path d="M3 3l18 18" />
                          <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
                          <path d="M9.3 5.3A9.7 9.7 0 0 1 12 5c5 0 9 5 9 7a13 13 0 0 1-2.2 2.9M6.1 6.2C3.8 7.7 3 11 3 12c1 2 3 5 7 6" />
                        </>
                      ) : (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* 국가법령 OC 키 (선택) */}
            <div
              style={{
                background: "var(--chrome-inset)",
                border: "1px solid var(--chrome-border)",
                borderRadius: "var(--r-md)",
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4v16M7 20h10M5 8h14M5 8l-2.6 5.2a3 3 0 0 0 5.2 0L5 8zM19 8l-2.6 5.2a3 3 0 0 0 5.2 0L19 8z" />
                </svg>
                <span
                  style={{ fontSize: "var(--t-md)", fontWeight: 600, color: "var(--text-strong)" }}
                >
                  국가법령정보 OpenAPI
                </span>
                <span className="badge badge--neutral">선택</span>
              </div>
              <p
                style={{
                  fontSize: "var(--t-sm)",
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                계약서·보도자료 검토 시 관련 법령을 자동으로 참조합니다. 무료 발급 가능.
              </p>
              <div className="field-row" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="key-law">
                  국가법령 OC 키
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="key-law"
                    className="field"
                    type={showLawKey ? "text" : "password"}
                    placeholder="(비워 두면 법령 검색 기능 비활성화)"
                    value={lawApiKey}
                    onChange={(e) => setLawApiKey(e.target.value)}
                    style={{ paddingRight: "40px", fontFamily: "var(--font-mono)" }}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLawKey((v) => !v)}
                    aria-label={showLawKey ? "키 숨기기" : "키 보기"}
                    style={{
                      position: "absolute",
                      right: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-faint)",
                      display: "flex",
                      alignItems: "center",
                      padding: 0,
                    }}
                  >
                    <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
                      {showLawKey ? (
                        <>
                          <path d="M3 3l18 18" />
                          <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
                          <path d="M9.3 5.3A9.7 9.7 0 0 1 12 5c5 0 9 5 9 7a13 13 0 0 1-2.2 2.9M6.1 6.2C3.8 7.7 3 11 3 12c1 2 3 5 7 6" />
                        </>
                      ) : (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 선택한 제공자 키가 비어 있을 때 안내 */}
          {selectedKey.trim().length === 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "var(--t-sm)",
                color: "var(--text-faint)",
              }}
            >
              <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
              선택된 제공자(
              {selected === "anthropic" ? "Claude" : selected === "openai" ? "OpenAI" : "Gemini"}
              )의 API 키를 입력하면 저장 버튼이 활성화됩니다.
            </div>
          )}
        </div>

        {/* ── 푸터 ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 24px",
            borderTop: "1px solid var(--chrome-border)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "var(--t-xs)",
              color: "var(--text-faint)",
            }}
          >
            <svg className="ico ico--sm" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            키는 이 기기에만 저장됩니다
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button type="button" className="btn btn--ghost" onClick={handleSkip} disabled={saving}>
              건너뛰기
            </button>
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={handleSave}
              disabled={!canSave}
            >
              {saving ? "저장 중…" : "저장하고 시작"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
