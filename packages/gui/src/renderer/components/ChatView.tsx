import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types.js";

interface ChatViewProps {
  messages: ChatMessage[];
}

export function ChatView({ messages }: ChatViewProps): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 새 메시지 도착 시 스크롤
  // biome-ignore lint/correctness/useExhaustiveDependencies: bottomRef는 안정 ref — messages 변경 시만 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="chat-view chat-view--empty">
        <div className="chat-view__empty-hint">
          <p>kodocagent — 한국어 문서 AI 에이전트</p>
          <p className="chat-view__empty-sub">메시지를 입력해 대화를 시작하세요.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div className="chat-view__messages">
        {messages.map((msg) => {
          if (msg.role === "user") {
            return (
              <div key={msg.id} className="chat-msg chat-msg--user">
                <div className="chat-msg__bubble">{msg.text}</div>
              </div>
            );
          }

          if (msg.role === "error") {
            return (
              <div key={msg.id} className="chat-msg chat-msg--error">
                <span className="chat-msg__error-icon">⚠</span>
                <span className="chat-msg__error-text">{msg.message}</span>
              </div>
            );
          }

          // assistant
          return (
            <div key={msg.id} className="chat-msg chat-msg--assistant">
              <div className="chat-msg__parts">
                {msg.parts.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 텍스트 파트는 append-only — index가 안정 키
                      <span key={i} className="chat-msg__text">
                        {part.text}
                      </span>
                    );
                  }
                  if (part.type === "tool-call") {
                    return (
                      <div key={part.callId} className="chat-msg__tool-chip">
                        <span className="chat-msg__tool-icon">⚙</span>
                        <span className="chat-msg__tool-name">{part.argSummary}</span>
                      </div>
                    );
                  }
                  if (part.type === "usage") {
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: usage 파트는 마지막 1개 — index가 안정 키
                      <div key={i} className="chat-msg__usage">
                        입력 {part.inputTokens.toLocaleString("ko-KR")} 토큰 / 출력{" "}
                        {part.outputTokens.toLocaleString("ko-KR")} 토큰
                      </div>
                    );
                  }
                  return null;
                })}
                {!msg.complete && <span className="chat-msg__cursor" aria-hidden="true" />}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
