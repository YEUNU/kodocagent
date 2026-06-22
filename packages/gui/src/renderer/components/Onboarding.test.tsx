// @vitest-environment jsdom
/**
 * Onboarding 마법사 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - role=tablist + role=tab + aria-selected가 선택 상태를 반영(키보드/스크린리더 탭 전환)
 * - 탭 클릭으로 제공자가 전환되고 aria-selected가 따라간다
 * - 선택된 제공자 키가 비면 저장 비활성, 키 입력 시 활성화
 * - 저장 시 window.kodoc.config.save가 입력값(provider/apiKeys/lawApiKey)으로 호출되고
 *   onComplete가 스냅샷으로 호출된다
 * - 건너뛰기는 config.get → onComplete
 * - 키 입력은 기본 password(가림), 보기 토글로 text 전환
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigSnapshot } from "../types.js";
import { Onboarding } from "./Onboarding.js";

const snapshot: ConfigSnapshot = {
  provider: "anthropic",
  model: null,
  hasKeys: { anthropic: true, openai: false, google: false },
};

let saveMock: ReturnType<typeof vi.fn>;
let getMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saveMock = vi.fn().mockResolvedValue(snapshot);
  getMock = vi.fn().mockResolvedValue(snapshot);
  vi.stubGlobal("kodoc", { config: { save: saveMock, get: getMock } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Onboarding — 제공자 탭 접근성", () => {
  it("tablist와 3개 tab을 렌더하고 anthropic이 선택됨(aria-selected)으로 시작한다", () => {
    render(<Onboarding onComplete={vi.fn()} />);
    expect(screen.getByRole("tablist")).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    const claudeTab = screen.getByRole("tab", { name: "Claude" });
    expect(claudeTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "OpenAI" }).getAttribute("aria-selected")).toBe("false");
  });

  it("OpenAI 탭 클릭 시 aria-selected가 OpenAI로 이동한다", async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
    expect(screen.getByRole("tab", { name: "OpenAI" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Claude" }).getAttribute("aria-selected")).toBe("false");
  });
});

describe("Onboarding — 저장 활성화 조건", () => {
  it("선택된 제공자 키가 비면 저장 버튼이 비활성이고, 키 입력 시 활성화된다", async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    const saveBtn = screen.getByRole("button", { name: /저장하고 시작/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    await userEvent.type(screen.getByLabelText(/Claude API 키/), "sk-ant-test");
    expect(saveBtn.disabled).toBe(false);
  });

  it("anthropic 선택 상태에서 openai 키만 입력하면 여전히 비활성", async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/OpenAI API 키/), "sk-openai");
    const saveBtn = screen.getByRole("button", { name: /저장하고 시작/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });
});

describe("Onboarding — 저장/건너뛰기 동작", () => {
  it("키 입력 후 저장하면 config.save(입력값)이 호출되고 onComplete(스냅샷)", async () => {
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);
    await userEvent.type(screen.getByLabelText(/Claude API 키/), "sk-ant-xyz");
    await userEvent.type(screen.getByLabelText(/국가법령 OC 키/), "law-oc-1");
    await userEvent.click(screen.getByRole("button", { name: /저장하고 시작/ }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const arg = saveMock.mock.calls[0]![0];
    expect(arg.provider).toBe("anthropic");
    expect(arg.apiKeys.anthropic).toBe("sk-ant-xyz");
    expect(arg.apiKeys.openai).toBeUndefined();
    expect(arg.lawApiKey).toBe("law-oc-1");
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(snapshot));
  });

  it("건너뛰기는 config.get → onComplete (save 미호출)", async () => {
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);
    await userEvent.click(screen.getByRole("button", { name: /건너뛰기/ }));
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(snapshot));
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("save 실패 시 에러 배너(role=alert)를 보여주고 onComplete는 호출되지 않는다", async () => {
    saveMock.mockRejectedValueOnce(new Error("디스크 가득 참"));
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);
    await userEvent.type(screen.getByLabelText(/Claude API 키/), "sk-ant");
    await userEvent.click(screen.getByRole("button", { name: /저장하고 시작/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("디스크 가득 참");
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("Onboarding — 키 가림", () => {
  it("API 키 입력은 기본 password 타입(가림), 보기 토글로 text 전환", async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    const input = screen.getByLabelText(/Claude API 키/) as HTMLInputElement;
    expect(input.type).toBe("password");
    // "키 보기" 토글은 제공자마다 하나씩(4개) — anthropic 입력 바로 옆 버튼을 사용한다.
    const toggle = input.parentElement?.querySelector(
      'button[aria-label="키 보기"]',
    ) as HTMLButtonElement;
    await userEvent.click(toggle);
    expect(input.type).toBe("text");
  });
});
