// @vitest-environment jsdom
/**
 * QuickActions 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - 4개 액션 버튼 렌더 및 각 버튼이 올바른 key로 onAction
 * - disabled OR !hasDoc일 때 모두 비활성(문서 없으면 작업 불가)
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickActions } from "./QuickActions.js";

afterEach(cleanup);

describe("QuickActions", () => {
  it("4개 버튼이 각자의 key로 onAction을 호출한다", async () => {
    const onAction = vi.fn();
    render(<QuickActions disabled={false} hasDoc={true} onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", { name: "요약" }));
    await userEvent.click(screen.getByRole("button", { name: "검토" }));
    await userEvent.click(screen.getByRole("button", { name: "개인정보 가리기" }));
    await userEvent.click(screen.getByRole("button", { name: /내보내기/ }));
    // 버튼별 개별 단언 — 단일 키 오매핑/순서 변경에 민감
    expect(onAction).toHaveBeenNthCalledWith(1, "summary");
    expect(onAction).toHaveBeenNthCalledWith(2, "review");
    expect(onAction).toHaveBeenNthCalledWith(3, "redact");
    expect(onAction).toHaveBeenNthCalledWith(4, "export");
    expect(onAction).toHaveBeenCalledTimes(4);
  });

  it("hasDoc=false이면 모든 버튼이 비활성", () => {
    render(<QuickActions disabled={false} hasDoc={false} onAction={vi.fn()} />);
    for (const btn of screen.getAllByRole("button")) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("disabled=true이면 hasDoc이어도 모든 버튼이 비활성", () => {
    render(<QuickActions disabled={true} hasDoc={true} onAction={vi.fn()} />);
    for (const btn of screen.getAllByRole("button")) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
