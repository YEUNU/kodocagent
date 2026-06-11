import { useCallback, useRef, useState } from "react";

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({
  disabled,
  running,
  onSend,
  onAbort,
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (running) {
          // Enter while running = no-op (Esc aborts)
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
    <div className="composer">
      <textarea
        ref={textareaRef}
        className="composer__input"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={
          running ? "응답 중... (Esc로 중단)" : "메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
        }
        disabled={disabled && !running}
        rows={3}
        aria-label="메시지 입력"
      />
      <div className="composer__actions">
        {running ? (
          <button type="button" className="composer__btn composer__btn--abort" onClick={onAbort}>
            중단 (Esc)
          </button>
        ) : (
          <button
            type="button"
            className="composer__btn composer__btn--send"
            onClick={handleSend}
            disabled={!value.trim() || disabled}
          >
            전송
          </button>
        )}
      </div>
    </div>
  );
}
