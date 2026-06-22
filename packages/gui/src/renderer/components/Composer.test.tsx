// @vitest-environment jsdom
/**
 * Composer 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - 입력 + 전송 버튼 클릭 시 trim된 텍스트로 onSend, 입력은 비워진다
 * - 빈/공백 입력은 전송 비활성·콜백 미발생
 * - Enter 전송 / Shift+Enter 줄바꿈(전송 안 함)
 * - running 중 Enter는 무시, Esc는 onAbort
 * - running 중 중단 버튼은 onAbort, 비-running Esc는 입력 비움
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";

afterEach(cleanup);

describe("Composer — 전송", () => {
  it("텍스트 입력 후 전송 클릭 시 trim된 값으로 onSend, 입력 초기화", async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} running={false} onSend={onSend} onAbort={vi.fn()} />);
    const ta = screen.getByLabelText("메시지 입력") as HTMLTextAreaElement;
    await userEvent.type(ta, "  안녕  ");
    await userEvent.click(screen.getByRole("button", { name: "전송" }));
    expect(onSend).toHaveBeenCalledWith("안녕");
    expect(ta.value).toBe("");
  });

  it("공백만 입력하면 전송 버튼이 비활성이고 onSend 미발생", async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} running={false} onSend={onSend} onAbort={vi.fn()} />);
    const sendBtn = screen.getByRole("button", { name: "전송" }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("메시지 입력"), "   ");
    expect(sendBtn.disabled).toBe(true);
  });

  it("Enter는 전송, Shift+Enter는 줄바꿈(전송 안 함)", async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} running={false} onSend={onSend} onAbort={vi.fn()} />);
    const ta = screen.getByLabelText("메시지 입력");
    await userEvent.type(ta, "첫줄{Shift>}{Enter}{/Shift}둘째줄");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(ta, "{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toContain("첫줄");
    expect(onSend.mock.calls[0]![0]).toContain("둘째줄");
  });
});

describe("Composer — running 상태", () => {
  it("running이면 전송 대신 중단 버튼을 보여주고 클릭 시 onAbort", async () => {
    const onAbort = vi.fn();
    render(<Composer disabled={false} running={true} onSend={vi.fn()} onAbort={onAbort} />);
    const abortBtn = screen.getByRole("button", { name: /중단/ });
    await userEvent.click(abortBtn);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "전송" })).toBeNull();
  });

  it("running 중 Enter는 전송하지 않고, Esc는 onAbort", async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    render(<Composer disabled={false} running={true} onSend={onSend} onAbort={onAbort} />);
    const ta = screen.getByLabelText("메시지 입력");
    await userEvent.type(ta, "무시될 내용{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(ta, "{Escape}");
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("비-running 상태에서 Esc는 입력을 비운다(중단 아님)", async () => {
    const onAbort = vi.fn();
    render(<Composer disabled={false} running={false} onSend={vi.fn()} onAbort={onAbort} />);
    const ta = screen.getByLabelText("메시지 입력") as HTMLTextAreaElement;
    await userEvent.type(ta, "지울 내용");
    await userEvent.type(ta, "{Escape}");
    expect(ta.value).toBe("");
    expect(onAbort).not.toHaveBeenCalled();
  });
});
