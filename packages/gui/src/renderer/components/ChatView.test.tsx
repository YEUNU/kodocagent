// @vitest-environment jsdom
/**
 * ChatView 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - role=log + aria-live=polite (보조기술이 새 메시지를 읽도록)
 * - user/assistant/error 메시지 종류별 렌더
 * - assistant 파트(text/tool-call/usage) 렌더 + 미완료 시 커서
 * - 빈 상태 안내(role=log 없이 안내문)
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { ChatView } from "./ChatView.js";

// jsdom은 scrollIntoView를 구현하지 않는다 — 자동 스크롤 useEffect가 던지지 않도록 shim.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

describe("ChatView — 빈 상태", () => {
  it("메시지가 없으면 안내문을 보여주고 log 역할은 없다", () => {
    render(<ChatView messages={[]} />);
    expect(screen.getByText(/한국어 문서 AI/)).toBeTruthy();
    expect(screen.queryByRole("log")).toBeNull();
  });
});

describe("ChatView — 라이브 영역 + 메시지 렌더", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "이 문서 요약해줘" },
    {
      id: "a1",
      role: "assistant",
      complete: false,
      parts: [
        { type: "text", text: "요약 중입니다" },
        {
          type: "tool-call",
          toolName: "read_document",
          argSummary: "read_document(보고서.hwpx)",
          callId: "c1",
        },
        { type: "usage", inputTokens: 12000, outputTokens: 340 },
      ],
    },
    { id: "e1", role: "error", message: "토큰 한도를 초과했습니다" },
  ];

  it("role=log + aria-live=polite를 가진다", () => {
    render(<ChatView messages={messages} />);
    const log = screen.getByRole("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
  });

  it("user/assistant text/tool-call/error 메시지를 모두 렌더한다", () => {
    render(<ChatView messages={messages} />);
    expect(screen.getByText("이 문서 요약해줘")).toBeTruthy();
    expect(screen.getByText("요약 중입니다")).toBeTruthy();
    expect(screen.getByText("read_document(보고서.hwpx)")).toBeTruthy();
    expect(screen.getByText("토큰 한도를 초과했습니다")).toBeTruthy();
  });

  it("usage 파트는 입력·출력 토큰을 ko-KR 천단위로 렌더한다", () => {
    render(<ChatView messages={messages} />);
    expect(screen.getByText(/입력 12,000/)).toBeTruthy();
    expect(screen.getByText(/출력 340/)).toBeTruthy();
  });

  it("미완료(complete=false) assistant 메시지는 커서를 표시한다", () => {
    const { container } = render(<ChatView messages={messages} />);
    expect(container.querySelector(".msg-cursor")).not.toBeNull();
  });

  it("완료(complete=true) 메시지는 커서를 표시하지 않는다", () => {
    const done: ChatMessage[] = [
      { id: "a2", role: "assistant", complete: true, parts: [{ type: "text", text: "끝" }] },
    ];
    const { container } = render(<ChatView messages={done} />);
    expect(container.querySelector(".msg-cursor")).toBeNull();
  });
});
