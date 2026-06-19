// @vitest-environment jsdom
/**
 * ApprovalDialog 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - role="dialog" + aria-modal + aria-labelledby가 제목 id를 가리킨다(스크린리더 접근성)
 * - 승인/거절 콜백이 올바른 proposalId·approved·reason으로 호출된다
 * - 거절 흐름(사유 입력 → 거절 확인)에서 reason이 전달되고, 취소는 reason을 비운다
 * - 경고·포맷변환 배너가 렌더된다
 * - redact-pii diff는 원문 값을 노출하지 않는다(허니스티 배너)
 * - 마운트 시 첫 인터랙티브 요소에 포커스(포커스 트랩 진입점)
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Proposal } from "../types.js";
import { ApprovalDialog } from "./ApprovalDialog.js";

afterEach(cleanup);

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    kind: "edit",
    targetPath: "/docs/report.hwpx",
    stagedPath: "/tmp/staged/report.hwpx",
    summary: "1페이지 제목을 수정합니다",
    diff: "@@ -1 +1 @@\n-옛 제목\n+새 제목",
    warnings: [],
    ...overrides,
  };
}

describe("ApprovalDialog — 접근성/대화상자 구조", () => {
  it("role=dialog + aria-modal + aria-labelledby가 제목 요소를 가리킨다", () => {
    render(<ApprovalDialog proposal={makeProposal()} onRespond={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const title = document.getElementById(labelId as string);
    expect(title).not.toBeNull();
    expect(title?.textContent).toContain("문서 수정"); // KIND_LABEL["edit"]
    expect(title?.textContent).toContain("승인 요청");
  });

  it("마운트 시 첫 인터랙티브 요소(거절 버튼)에 포커스가 간다", () => {
    render(<ApprovalDialog proposal={makeProposal()} onRespond={vi.fn()} />);
    // 첫 버튼 = 거절
    const active = document.activeElement;
    expect(active?.tagName).toBe("BUTTON");
    expect(active?.textContent).toContain("거절");
  });
});

describe("ApprovalDialog — 승인/거절 콜백", () => {
  it("승인 클릭 시 onRespond(id, true)가 호출된다", async () => {
    const onRespond = vi.fn();
    render(<ApprovalDialog proposal={makeProposal()} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: /승인/ }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("prop-1", true);
  });

  it("거절 → 사유 입력 → 거절 확인: onRespond(id, false, reason)", async () => {
    const onRespond = vi.fn();
    render(<ApprovalDialog proposal={makeProposal()} onRespond={onRespond} />);

    // 1단계: 거절 클릭 → 사유 textarea 노출
    await userEvent.click(screen.getByRole("button", { name: /^거절$/ }));
    const textarea = screen.getByLabelText(/거절 사유/);
    await userEvent.type(textarea, "맥락이 틀렸습니다");

    // 2단계: 거절 확인
    await userEvent.click(screen.getByRole("button", { name: /거절 확인/ }));
    expect(onRespond).toHaveBeenCalledWith("prop-1", false, "맥락이 틀렸습니다");
  });

  it("거절 사유 없이 거절 확인하면 reason은 undefined", async () => {
    const onRespond = vi.fn();
    render(<ApprovalDialog proposal={makeProposal()} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: /^거절$/ }));
    await userEvent.click(screen.getByRole("button", { name: /거절 확인/ }));
    expect(onRespond).toHaveBeenCalledWith("prop-1", false, undefined);
  });

  it("거절 사유 입력 중 취소하면 입력이 사라지고 onRespond는 호출되지 않는다", async () => {
    const onRespond = vi.fn();
    render(<ApprovalDialog proposal={makeProposal()} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: /^거절$/ }));
    await userEvent.type(screen.getByLabelText(/거절 사유/), "임시");
    await userEvent.click(screen.getByRole("button", { name: /취소/ }));
    expect(onRespond).not.toHaveBeenCalled();
    // textarea가 사라지고 다시 승인 버튼이 보인다
    expect(screen.queryByLabelText(/거절 사유/)).toBeNull();
    expect(screen.getByRole("button", { name: /승인/ })).toBeTruthy();
  });
});

describe("ApprovalDialog — 경고/포맷 변환/PII 안전성", () => {
  it("warnings와 willConvertFormat 배너를 렌더한다", () => {
    render(
      <ApprovalDialog
        proposal={makeProposal({
          warnings: ["병합 셀이 풀릴 수 있습니다"],
          willConvertFormat: ".hwp → .hwpx",
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText(/병합 셀이 풀릴 수 있습니다/)).toBeTruthy();
    expect(screen.getByText(/\.hwp → \.hwpx/)).toBeTruthy();
  });

  it("redact-pii diff는 원문 값을 노출하지 않고 허니스티 배너를 보여준다", () => {
    render(
      <ApprovalDialog
        proposal={makeProposal({
          kind: "redact-pii",
          summary: "개인정보 2건 비식별",
          diff: "개인정보 2건 비식별 처리\n- 전화번호: 2건 → 010-****-1234",
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText(/원문 값은 표시하지 않습니다/)).toBeTruthy();
    // 마스킹된 예시(별표 포함)는 표시되지만 원문 평문 번호는 없다
    expect(screen.getByText(/010-\*\*\*\*-1234/)).toBeTruthy();
  });

  it("markdown table diff(cell-edit)는 표로 렌더된다", () => {
    render(
      <ApprovalDialog
        proposal={makeProposal({
          kind: "cell-edit",
          diff: "| 행 | 기존 | 변경 |\n| --- | --- | --- |\n| 1 | 가 | 나 |",
        })}
        onRespond={vi.fn()}
      />,
    );
    const tables = document.querySelectorAll("table.doc-table");
    expect(tables.length).toBe(1);
    expect(screen.getByText("나")).toBeTruthy();
  });
});

describe("ApprovalDialog — 포커스 트랩", () => {
  it("마지막 요소에서 Tab을 누르면 첫 요소로 순환한다", () => {
    render(<ApprovalDialog proposal={makeProposal()} onRespond={vi.fn()} />);
    // keydown 리스너는 .modal 컨테이너에 붙어 있으므로 그 내부 요소에서 발화시킨다.
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".modal button"));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);
    // 마지막에서 Tab → 첫 요소로 래핑(이벤트는 모달 내부에서 버블링)
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("첫 요소에서 Shift+Tab을 누르면 마지막 요소로 순환한다", () => {
    render(<ApprovalDialog proposal={makeProposal()} onRespond={vi.fn()} />);
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".modal button"));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
