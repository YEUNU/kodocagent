import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { StatusBar } from "./components/StatusBar.js";
import type { ChatMessage, Proposal, SerializedAgentEvent } from "./types.js";
import { formatToolCallSummary } from "./types.js";

type AppState = "idle" | "running" | "config-missing";

let messageIdCounter = 0;
function nextId(): string {
  return String(++messageIdCounter);
}

export function App(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [appState, setAppState] = useState<AppState>("idle");
  const [pendingProposal, setPendingProposal] = useState<Proposal | null>(null);
  const [provider, setProvider] = useState<string>("anthropic");
  const [model, setModel] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const [configMissing, setConfigMissing] = useState(false);

  // 현재 어시스턴트 메시지 id를 ref로 추적
  const currentAssistantIdRef = useRef<string | null>(null);

  // config 초기 로드
  useEffect(() => {
    if (typeof window.kodoc === "undefined") return;
    window.kodoc.config
      .get()
      .then((cfg) => {
        setProvider(cfg.provider);
        setModel(cfg.model);
        const anyKey = Object.values(cfg.hasKeys).some(Boolean);
        if (!anyKey) {
          setConfigMissing(true);
          setAppState("config-missing");
        }
      })
      .catch(() => {
        setConfigMissing(true);
        setAppState("config-missing");
      });
  }, []);

  // cwd 변경 이벤트 구독
  useEffect(() => {
    if (typeof window.kodoc === "undefined") return;
    const unsub = window.kodoc.cwd.onChange((newCwd) => {
      setCwd(newCwd);
    });
    return unsub;
  }, []);

  // AgentEvent 구독
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleEvent는 mount 시 1회만 구독 (IPC 리스너 패턴)
  useEffect(() => {
    if (typeof window.kodoc === "undefined") return;

    const unsub = window.kodoc.chat.onEvent((ev: SerializedAgentEvent) => {
      handleEvent(ev);
    });

    return unsub;
  }, []);

  const handleEvent = useCallback((ev: SerializedAgentEvent) => {
    switch (ev.type) {
      case "text-delta": {
        const assistantId = currentAssistantIdRef.current;
        if (!assistantId) {
          // 새 어시스턴트 메시지 시작
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
            setMessages((prev) => [...prev, { id, role: "assistant", parts: [], complete: false }]);
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
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role !== "assistant") return prev;
            return prev.map((m) => {
              if (m.id !== last.id || m.role !== "assistant") return m;
              const usage = ev.usage;
              return {
                ...m,
                complete: true,
                parts: [
                  ...m.parts,
                  {
                    type: "usage" as const,
                    inputTokens: usage?.inputTokens ?? 0,
                    outputTokens: usage?.outputTokens ?? 0,
                  },
                ],
              };
            });
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
  }, []);

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

  const handleApprovalRespond = useCallback(
    (proposalId: string, approved: boolean, reason?: string) => {
      window.kodoc.approval.respond(proposalId, approved, reason);
      setPendingProposal(null);
    },
    [],
  );

  if (configMissing) {
    return (
      <div className="config-missing">
        <div className="config-missing__card">
          <h2>설정이 필요합니다</h2>
          <p>
            CLI에서 <code>kodocagent</code>를 실행해 온보딩을 완료하세요.
          </p>
          <p className="config-missing__path">
            설정 파일 위치: <code>~/.kodocagent/config.json</code>
          </p>
          <p>온보딩 후 앱을 재시작하세요.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <StatusBar
        provider={provider}
        model={model}
        cwd={cwd}
        appState={appState}
        onNewSession={handleNewSession}
        onSelectCwd={handleSelectCwd}
      />
      <main className="app__main">
        <ChatView messages={messages} />
      </main>
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
