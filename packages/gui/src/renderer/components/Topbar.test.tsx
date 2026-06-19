// @vitest-environment jsdom
/**
 * Topbar 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - 폴더 선택 / 새 세션 콜백
 * - running 중 새 세션 버튼 비활성
 * - 긴 cwd 축약(…/마지막 두 단계), 빈 cwd는 "폴더 선택"
 * - 누적 토큰 k 축약, 컨텍스트 게이지 null이면 미표시·임계 초과 시 warn 클래스
 * - 상태 라벨/모델 폴백
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar.js";

afterEach(cleanup);

function baseProps() {
  return {
    brand: "kodocagent",
    model: "claude-opus-4-8",
    cwd: "/Users/me/projects/docs",
    appState: "idle" as const,
    cumulativeInput: 125_000,
    cumulativeOutput: 8_200,
    contextPct: 40,
    onSelectCwd: vi.fn(),
    onNewSession: vi.fn(),
  };
}

describe("Topbar — 콜백/비활성", () => {
  it("폴더·새 세션 버튼이 콜백을 호출한다", async () => {
    const props = baseProps();
    render(<Topbar {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /docs/ }));
    expect(props.onSelectCwd).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "새 세션" }));
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
  });

  it("running 상태에서 새 세션 버튼은 비활성", () => {
    render(<Topbar {...baseProps()} appState="running" />);
    expect((screen.getByRole("button", { name: "새 세션" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("Topbar — 표시 로직", () => {
  it("긴 cwd는 …/마지막 두 단계로 축약된다", () => {
    render(<Topbar {...baseProps()} cwd="/Users/me/projects/docs" />);
    expect(screen.getByText("…/projects/docs")).toBeTruthy();
  });

  it("빈 cwd는 '폴더 선택'을 보여준다", () => {
    render(<Topbar {...baseProps()} cwd="" />);
    expect(screen.getByText("폴더 선택")).toBeTruthy();
  });

  it("누적 토큰을 k 단위로 축약한다", () => {
    render(<Topbar {...baseProps()} cumulativeInput={125_000} cumulativeOutput={8_200} />);
    expect(screen.getByText(/입력 125\.0k/)).toBeTruthy();
    expect(screen.getByText(/출력 8\.2k/)).toBeTruthy();
  });

  it("contextPct가 null이면 게이지를 표시하지 않는다", () => {
    const { container } = render(<Topbar {...baseProps()} contextPct={null} />);
    expect(container.querySelector(".gauge")).toBeNull();
  });

  it("contextPct가 85 초과면 게이지에 warn 클래스가 붙는다", () => {
    const { container } = render(<Topbar {...baseProps()} contextPct={90} />);
    expect(container.querySelector(".gauge__fill--warn")).not.toBeNull();
  });

  it("contextPct가 85(경계)이면 warn 클래스가 없다(> 85 임계)", () => {
    const { container } = render(<Topbar {...baseProps()} contextPct={85} />);
    expect(container.querySelector(".gauge__fill--warn")).toBeNull();
  });

  it("모델이 null이면 (기본값)으로 폴백한다", () => {
    render(<Topbar {...baseProps()} model={null} />);
    expect(screen.getByText("(기본값)")).toBeTruthy();
  });

  it("appState 라벨을 보여준다(idle→대기)", () => {
    render(<Topbar {...baseProps()} appState="idle" />);
    expect(screen.getByText("대기")).toBeTruthy();
  });
});
