import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types.js";

interface ChatViewProps {
  messages: ChatMessage[];
}

export function ChatView({ messages }: ChatViewProps): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bottomRef는 안정 ref — messages 변경 시만 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="chat chat--empty">
        <div>
          <p>kodocagent — 한국어 문서 AI</p>
          <p className="t-sm t-faint">왼쪽에서 문서를 열고, 무엇을 할지 입력하세요.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat" role="log" aria-live="polite" aria-relevant="additions">
      {messages.map((msg) => {
        if (msg.role === "user") {
          return (
            <div key={msg.id} className="bubble-user">
              {msg.text}
            </div>
          );
        }

        if (msg.role === "error") {
          return (
            <div key={msg.id} className="msg-error">
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4 2.8 20h18.4z" />
                <path d="M12 10v4M12 17h.01" />
              </svg>
              <span>{msg.message}</span>
            </div>
          );
        }

        // assistant
        return (
          <div key={msg.id} className="bubble-assistant">
            {msg.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 텍스트 파트는 append-only — index가 안정 키
                  <span key={i} className="msg-text">
                    {part.text}
                  </span>
                );
              }
              if (part.type === "tool-call") {
                return (
                  <div key={part.callId} className="tool-row tool-row--done">
                    <svg
                      className="ico ico--sm tool-row__icon"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M5 12.5 10 17 19 7" />
                    </svg>
                    {part.argSummary}
                  </div>
                );
              }
              if (part.type === "usage") {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: usage 파트는 마지막 1개 — index가 안정 키
                  <div key={i} className="msg-usage">
                    입력 {part.inputTokens.toLocaleString("ko-KR")}·출력{" "}
                    {part.outputTokens.toLocaleString("ko-KR")} 토큰
                  </div>
                );
              }
              return null;
            })}
            {!msg.complete && <span className="msg-cursor" aria-hidden="true" />}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
