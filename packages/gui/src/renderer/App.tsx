import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { DocumentPreview } from "./components/DocumentPreview.js";
import { FilePane } from "./components/FilePane.js";
import { type QuickActionKey, QuickActions } from "./components/QuickActions.js";
import { Topbar } from "./components/Topbar.js";
import type {
  ChatMessage,
  DocPreviewResult,
  FileEntry,
  Proposal,
  SerializedAgentEvent,
} from "./types.js";
import { formatToolCallSummary } from "./types.js";

type AppState = "idle" | "running" | "config-missing";

/** 컨텍스트 게이지 근사용 기준 윈도 (실제 모델 윈도와 무관한 표시 근사치) */
const CONTEXT_WINDOW = 200_000;

let messageIdCounter = 0;
function nextId(): string {
  return String(++messageIdCounter);
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

export function App(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [appState, setAppState] = useState<AppState>("idle");
  const [pendingProposal, setPendingProposal] = useState<Proposal | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const [configMissing, setConfigMissing] = useState(false);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFile, setActiveFile] = useState<{ name: string; path: string } | null>(null);
  const [preview, setPreview] = useState<DocPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [cumulativeInput, setCumulativeInput] = useState(0);
  const [cumulativeOutput, setCumulativeOutput] = useState(0);
  const [lastInputTokens, setLastInputTokens] = useState(0);

  const currentAssistantIdRef = useRef<string | null>(null);
  const activeFileRef = useRef<{ name: string; path: string } | null>(null);
  activeFileRef.current = activeFile;

  const refreshFiles = useCallback(() => {
    if (typeof window.kodoc === "undefined") return;
    window.kodoc.files
      .list()
      .then(setFiles)
      .catch(() => setFiles([]));
  }, []);

  const loadPreview = useCallback((path: string) => {
    setPreviewLoading(true);
    window.kodoc.doc
      .preview(path)
      .then(setPreview)
      .catch((err: unknown) =>
        setPreview({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setPreviewLoading(false));
  }, []);

  // config 초기 로드
  useEffect(() => {
    if (typeof window.kodoc === "undefined") return;
    window.kodoc.config
      .get()
      .then((cfg) => {
        setModel(cfg.model);
        if (!Object.values(cfg.hasKeys).some(Boolean)) {
          setConfigMissing(true);
          setAppState("config-missing");
        }
      })
      .catch(() => {
        setConfigMissing(true);
        setAppState("config-missing");
      });
  }, []);

  // dev 전용: ?demoApproval=<kind> 로 승인 다이얼로그 미리보기 (프로덕션 빌드에서 제거됨)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const k = new URLSearchParams(window.location.search).get("demoApproval");
    if (!k) return;
    const samples: Record<string, Partial<Proposal>> = {
      "cell-edit": {
        kind: "cell-edit",
        targetPath: "예산보고서.hwpx",
        summary: "금액 셀에 천 단위 콤마를 적용합니다.",
        diff: "| 표·셀 | 이전 | 이후 |\n| --- | --- | --- |\n| B3 | 1500000 | 1,500,000 |\n| B4 | 820000 | 820,000 |\n| B5 | 3200000 | 3,200,000 |",
      },
      "redact-pii": {
        kind: "redact-pii",
        targetPath: "채용지원서.hwpx",
        summary: "발견된 개인정보 4건을 마스킹합니다.",
        diff: "개인정보 4건 비식별 처리\n- 이름: 2건 → 홍**, 김**\n- 전화번호: 1건 → 010-****-1234\n- 주민등록번호: 1건 → ******-*******",
      },
      edit: {
        kind: "edit",
        targetPath: "계약서.hwpx",
        summary: "계약 일자와 금액 문구를 수정합니다.",
        warnings: ["일부 복합 서식은 단순화될 수 있습니다."],
        willConvertFormat: ".hwp → .hwpx",
        diff: "@@ 제1조 (목적) @@\n 본 계약의 내용은 다음과 같다.\n-계약 일자: 2025년 1월 1일\n+계약 일자: 2026년 6월 18일\n-계약 금액: 일금 오백만원정\n+계약 금액: 일금 칠백만원정",
      },
      "form-fill": {
        kind: "form-fill",
        targetPath: "민원신청서.hwpx",
        summary: "신청서 양식 필드를 채웁니다.",
        diff: "| 라벨 | 이전 값 | 새 값 |\n| --- | --- | --- |\n| 성명 | (없음) | 홍길동 |\n| 신청일 | (없음) | 2026-06-18 |\n| 연락처 | (없음) | 010-1234-5678 |",
      },
    };
    const s = samples[k];
    if (s) {
      setPendingProposal({ id: "demo", stagedPath: "(데모)", warnings: [], ...s } as Proposal);
    }
  }, []);

  // cwd 변경 → 파일 목록 새로고침, 미리보기 초기화
  useEffect(() => {
    if (typeof window.kodoc === "undefined") return;
    const unsub = window.kodoc.cwd.onChange((newCwd) => {
      setCwd(newCwd);
      setActiveFile(null);
      setPreview(null);
      refreshFiles();
    });
    refreshFiles();
    return unsub;
  }, [refreshFiles]);

  // AgentEvent 구독
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount 시 1회 구독 (IPC 리스너 패턴)
  useEffect(() => {
    if (typeof window.kodoc === "undefined") return;
    const unsub = window.kodoc.chat.onEvent((ev: SerializedAgentEvent) => handleEvent(ev));
    return unsub;
  }, []);

  const handleEvent = useCallback(
    (ev: SerializedAgentEvent) => {
      switch (ev.type) {
        case "text-delta": {
          const assistantId = currentAssistantIdRef.current;
          if (!assistantId) {
            const id = nextId();
            currentAssistantIdRef.current = id;
            setMessages((prev) => [
              ...prev,
              { id, role: "assistant", parts: [{ type: "text", text: ev.text }], complete: false },
            ]);
          } else {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId || m.role !== "assistant") return m;
                const parts = [...m.parts];
                const last = parts[parts.length - 1];
                if (last?.type === "text") {
                  parts[parts.length - 1] = { type: "text", text: last.text + ev.text };
                } else {
                  parts.push({ type: "text", text: ev.text });
                }
                return { ...m, parts };
              }),
            );
          }
          break;
        }

        case "tool-call": {
          const summary = formatToolCallSummary(ev.toolName, ev.args);
          const assistantId =
            currentAssistantIdRef.current ??
            (() => {
              const id = nextId();
              currentAssistantIdRef.current = id;
              setMessages((prev) => [
                ...prev,
                { id, role: "assistant", parts: [], complete: false },
              ]);
              return id;
            })();
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId || m.role !== "assistant") return m;
              return {
                ...m,
                parts: [
                  ...m.parts,
                  {
                    type: "tool-call" as const,
                    toolName: ev.toolName,
                    argSummary: summary,
                    callId: ev.callId,
                  },
                ],
              };
            }),
          );
          break;
        }

        case "approval-required": {
          setPendingProposal(ev.proposal as Proposal);
          break;
        }

        case "turn-complete": {
          currentAssistantIdRef.current = null;
          setAppState("idle");
          if (ev.usage) {
            setCumulativeInput((n) => n + (ev.usage?.inputTokens ?? 0));
            setCumulativeOutput((n) => n + (ev.usage?.outputTokens ?? 0));
            setLastInputTokens(ev.usage.inputTokens ?? 0);
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role !== "assistant") return prev;
              return prev.map((m) =>
                m.id === last.id && m.role === "assistant"
                  ? {
                      ...m,
                      complete: true,
                      parts: [
                        ...m.parts,
                        {
                          type: "usage" as const,
                          inputTokens: ev.usage?.inputTokens ?? 0,
                          outputTokens: ev.usage?.outputTokens ?? 0,
                        },
                      ],
                    }
                  : m,
              );
            });
          } else {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role !== "assistant") return prev;
              return prev.map((m) =>
                m.id === last.id && m.role === "assistant" ? { ...m, complete: true } : m,
              );
            });
          }
          // 편집이 적용됐을 수 있으니 활성 문서 미리보기 + 파일 목록 새로고침
          const af = activeFileRef.current;
          if (af) loadPreview(af.path);
          refreshFiles();
          break;
        }

        case "error": {
          if (!ev.recoverable) {
            currentAssistantIdRef.current = null;
            setAppState("idle");
          }
          setMessages((prev) => [...prev, { id: nextId(), role: "error", message: ev.message }]);
          break;
        }

        default:
          break;
      }
    },
    [loadPreview, refreshFiles],
  );

  const handleSend = useCallback(
    (text: string) => {
      if (appState === "running") return;
      const id = nextId();
      currentAssistantIdRef.current = null;
      setMessages((prev) => [...prev, { id, role: "user", text }]);
      setAppState("running");
      window.kodoc.chat.send(text);
    },
    [appState],
  );

  const handleAbort = useCallback(() => {
    window.kodoc.chat.abort();
    setAppState("idle");
    currentAssistantIdRef.current = null;
  }, []);

  const handleNewSession = useCallback(() => {
    window.kodoc.session.new();
    setMessages([]);
    currentAssistantIdRef.current = null;
    setAppState("idle");
  }, []);

  const handleSelectCwd = useCallback(async () => {
    const newCwd = await window.kodoc.cwd.select();
    if (newCwd) {
      setCwd(newCwd);
      handleNewSession();
    }
  }, [handleNewSession]);

  const handleSelectFile = useCallback(
    (path: string) => {
      const f = files.find((x) => x.path === path);
      setActiveFile({ name: f?.name ?? basename(path), path });
      loadPreview(path);
    },
    [files, loadPreview],
  );

  const handleDropFiles = useCallback(
    (absPaths: string[]) => {
      const first = absPaths[0];
      if (!first) return;
      setActiveFile({ name: basename(first), path: first });
      loadPreview(first);
    },
    [loadPreview],
  );

  const handleApprovalRespond = useCallback(
    (proposalId: string, approved: boolean, reason?: string) => {
      window.kodoc.approval.respond(proposalId, approved, reason);
      setPendingProposal(null);
    },
    [],
  );

  const handleQuickAction = useCallback(
    (key: QuickActionKey) => {
      if (appState === "running") return;
      const name = activeFile?.name;
      const ref = name ? `${name} 문서를` : "이 문서를";
      const prompts: Record<QuickActionKey, string> = {
        summary: `${ref} 핵심만 요약해줘.`,
        review: `${ref} 검토하고, 오류나 보완할 점이 있으면 알려줘. 법령 관련이면 근거도 함께.`,
        redact: `${ref}에서 개인정보(이름·전화·주민번호 등)를 찾아 가려줘.`,
        export: `${ref} HTML로 내보내줘.`,
      };
      handleSend(prompts[key]);
    },
    [appState, activeFile, handleSend],
  );

  const contextPct =
    lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / CONTEXT_WINDOW) * 100))
      : null;

  if (configMissing) {
    return (
      <div className="config-missing">
        <div className="config-missing__card">
          <h2>설정이 필요합니다</h2>
          <p>
            CLI에서 <code>kodocagent</code>를 실행해 온보딩(API 키 설정)을 완료하세요.
          </p>
          <p>
            설정 파일: <code>~/.kodocagent/config.json</code>
          </p>
          <p>온보딩 후 앱을 재시작하세요.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ws">
      <Topbar
        brand="kodocagent"
        model={model}
        cwd={cwd}
        appState={appState}
        cumulativeInput={cumulativeInput}
        cumulativeOutput={cumulativeOutput}
        contextPct={contextPct}
        onSelectCwd={handleSelectCwd}
        onNewSession={handleNewSession}
      />
      <div className="panes">
        <FilePane
          files={files}
          activePath={activeFile?.path ?? null}
          onSelect={handleSelectFile}
          onOpenDialog={handleSelectCwd}
          onDropFiles={handleDropFiles}
        />
        <DocumentPreview
          activeName={activeFile?.name ?? null}
          preview={preview}
          loading={previewLoading}
        />
        <section className="pane">
          <div className="pane__header">
            <span className="pane__title">대화</span>
          </div>
          <ChatView messages={messages} />
          <QuickActions
            disabled={appState === "running"}
            hasDoc={!!activeFile}
            onAction={handleQuickAction}
          />
        </section>
      </div>
      <Composer
        disabled={appState === "running" || appState === "config-missing"}
        running={appState === "running"}
        onSend={handleSend}
        onAbort={handleAbort}
      />
      {pendingProposal && (
        <ApprovalDialog proposal={pendingProposal} onRespond={handleApprovalRespond} />
      )}
    </div>
  );
}
