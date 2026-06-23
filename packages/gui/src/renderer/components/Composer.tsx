import { useCallback, useRef, useState } from "react";

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  /** 키가 있는 프로바이더가 2개 이상이면 "모델 비교" 버튼 노출 */
  canCompare?: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  onCompare?: (text: string) => void;
}

export function Composer({
  disabled,
  running,
  canCompare,
  onSend,
  onAbort,
  onCompare,
}: ComposerProps): React.ReactElement {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    textareaRef.current?.focus();
  }, [value, disabled, onSend]);

  const handleCompare = useCallback(() => {
    const text = value.trim();
    if (!text || disabled || !onCompare) return;
    onCompare(text);
    setValue("");
    textareaRef.current?.focus();
  }, [value, disabled, onCompare]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (running) {
          return;
        }
        handleSend();
      } else if (e.key === "Escape") {
        if (running) {
          onAbort();
        } else {
          setValue("");
        }
      }
    },
    [handleSend, running, onAbort],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  return (
    <footer className="composer">
      <textarea
        ref={textareaRef}
        className="field"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={
          running ? "응답 중… (Esc로 중단)" : "메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
        }
        disabled={disabled && !running}
        rows={3}
        aria-label="메시지 입력"
      />
      {running ? (
        <button type="button" className="btn btn--danger btn--lg" onClick={onAbort}>
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          중단
        </button>
      ) : (
        <div className="row gap-4">
          {canCompare && onCompare && (
            <button
              type="button"
              className="btn btn--secondary btn--lg"
              onClick={handleCompare}
              disabled={!value.trim() || disabled}
              title="키가 있는 여러 모델에 같은 질문을 보내 응답을 비교(읽기 전용)"
            >
              모델 비교
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary btn--lg"
            onClick={handleSend}
            disabled={!value.trim() || disabled}
          >
            전송
          </button>
        </div>
      )}
    </footer>
  );
}
