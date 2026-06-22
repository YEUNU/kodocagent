// @vitest-environment jsdom
/**
 * DocumentPreview 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - 로딩/빈/성공/오류 4상태 렌더
 * - 성공 시 iframe sandbox는 allow-same-origin만(스크립트 불가), srcDoc에 CSP 메타가 박힌다
 * - CSP가 외부 스크립트/이미지/연결을 차단(default-src 'none', img-src data:만)
 * - 미리보기 HTML이 srcDoc body에 들어간다(근사 안내문 포함)
 * - proposal 없으면 변경본·diff 탭 비활성(원본만), 있으면 활성·내용 렌더
 * - redact-pii proposal의 diff에서 원문 평문이 DOM에 노출되지 않음(보안 회귀 방지)
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Proposal } from "../types.js";
import { DocumentPreview } from "./DocumentPreview.js";

afterEach(cleanup);

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    kind: "edit",
    targetPath: "보고서.hwpx",
    stagedPath: "/tmp/staged/보고서.hwpx",
    summary: "1페이지 제목을 수정합니다",
    diff: "@@ -1 +1 @@\n-옛 제목\n+새 제목",
    warnings: [],
    ...overrides,
  };
}

describe("DocumentPreview — 상태별 렌더", () => {
  it("loading이면 스피너 안내를 보여준다", () => {
    const { container } = render(
      <DocumentPreview activeName="a.hwpx" preview={null} loading={true} />,
    );
    expect(container.querySelector(".preview-loading")).not.toBeNull();
  });

  it("activeName이 없으면 빈 안내(끌어다 놓기)", () => {
    render(<DocumentPreview activeName={null} preview={null} loading={false} />);
    expect(screen.getByText(/끌어다 놓으세요/)).toBeTruthy();
  });

  it("preview 오류면 에러 메시지를 보여준다", () => {
    render(
      <DocumentPreview
        activeName="a.hwp"
        preview={{ ok: false, error: ".hwp는 변환이 필요합니다" }}
        loading={false}
      />,
    );
    expect(screen.getByText(".hwp는 변환이 필요합니다")).toBeTruthy();
  });
});

describe("DocumentPreview — 성공/보안", () => {
  function renderSuccess(html: string) {
    return render(
      <DocumentPreview
        activeName="보고서.hwpx"
        preview={{ ok: true, html, markdown: "" }}
        loading={false}
      />,
    );
  }

  it("iframe sandbox는 allow-same-origin만(스크립트 실행 불가)", () => {
    const { container } = renderSuccess("<h1>제목</h1>");
    const iframe = container.querySelector("iframe.preview-frame") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
  });

  it("srcDoc에 CSP 메타가 박혀 외부 리소스를 차단한다", () => {
    const { container } = renderSuccess("<p>본문</p>");
    const iframe = container.querySelector("iframe.preview-frame") as HTMLIFrameElement;
    const srcDoc = iframe.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain("default-src 'none'");
    // 외부 이미지로 IP가 추적되는 것을 막기 위해 data: 이미지만 허용
    expect(srcDoc).toContain("img-src data:");
    // 스크립트는 허용 목록에 없다
    expect(srcDoc).not.toContain("script-src");
  });

  it("미리보기 HTML과 근사 안내가 srcDoc/문서에 반영된다", () => {
    const { container } = renderSuccess("<h1>분기 보고서</h1>");
    const iframe = container.querySelector("iframe.preview-frame") as HTMLIFrameElement;
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>분기 보고서</h1>");
    expect(screen.getByText(/HTML 미리보기는 근사입니다/)).toBeTruthy();
  });
});

describe("DocumentPreview — 변경본/diff 탭", () => {
  it("proposal이 없으면 변경본·diff 탭이 비활성(disabled)이고 원본만 보인다", () => {
    const { container } = render(
      <DocumentPreview
        activeName="보고서.hwpx"
        preview={{ ok: true, html: "<h1>원본</h1>", markdown: "" }}
        loading={false}
      />,
    );
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>(".tabs .tab"));
    const byLabel = (label: string) => tabs.find((b) => b.textContent?.trim() === label);
    expect(byLabel("원본")?.classList.contains("tab--active")).toBe(true);
    expect(byLabel("변경본")?.disabled).toBe(true);
    expect(byLabel("변경본")?.classList.contains("is-disabled")).toBe(true);
    expect(byLabel("diff")?.disabled).toBe(true);
    expect(byLabel("diff")?.classList.contains("is-disabled")).toBe(true);
  });

  it("proposal이 있으면 변경본·diff 탭이 활성(enabled)된다", () => {
    const { container } = render(
      <DocumentPreview
        activeName="보고서.hwpx"
        preview={{ ok: true, html: "<h1>원본</h1>", markdown: "" }}
        loading={false}
        proposal={makeProposal()}
        onRequestStagedPreview={vi.fn()}
      />,
    );
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>(".tabs .tab"));
    const byLabel = (label: string) => tabs.find((b) => b.textContent?.trim() === label);
    expect(byLabel("변경본")?.disabled).toBe(false);
    expect(byLabel("변경본")?.classList.contains("is-disabled")).toBe(false);
    expect(byLabel("diff")?.disabled).toBe(false);
  });

  it("diff 탭을 클릭하면 proposal.diff가 렌더된다", () => {
    render(
      <DocumentPreview
        activeName="보고서.hwpx"
        preview={{ ok: true, html: "<h1>원본</h1>", markdown: "" }}
        loading={false}
        proposal={makeProposal({ diff: "@@ -1 +1 @@\n-옛 제목\n+새 제목" })}
        onRequestStagedPreview={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff" }));
    expect(screen.getByText("+새 제목")).toBeTruthy();
    expect(screen.getByText("-옛 제목")).toBeTruthy();
  });

  it("변경본 탭을 처음 열면 stagedPath로 미리보기를 1회 요청해 렌더한다", async () => {
    const onRequestStagedPreview = vi
      .fn()
      .mockResolvedValue({ ok: true, html: "<h1>변경된 제목</h1>", markdown: "" });
    const { container } = render(
      <DocumentPreview
        activeName="보고서.hwpx"
        preview={{ ok: true, html: "<h1>원본</h1>", markdown: "" }}
        loading={false}
        proposal={makeProposal({ stagedPath: "/tmp/staged/보고서.hwpx" })}
        onRequestStagedPreview={onRequestStagedPreview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "변경본" }));
    await waitFor(() => {
      const iframe = container.querySelector("iframe.preview-frame") as HTMLIFrameElement | null;
      expect(iframe?.getAttribute("srcdoc")).toContain("<h1>변경된 제목</h1>");
    });
    expect(onRequestStagedPreview).toHaveBeenCalledTimes(1);
    expect(onRequestStagedPreview).toHaveBeenCalledWith("/tmp/staged/보고서.hwpx");
  });

  it("redact-pii proposal의 diff 탭은 원문 평문을 DOM에 노출하지 않는다(보안)", () => {
    // 원문 평문(010-1234-5678 등 실제 값)이 diff에 섞여 들어와도 화면에 그대로 나오면 안 된다.
    // ProposalDiff redact-pii 분기는 "유형: N건 → 마스킹예시" 형식 라인만 칩으로 렌더하고,
    // 그 형식에 맞지 않는 라인(평문이 실릴 수 있는)은 드롭한다 — 아래 입력엔 실제 평문이 든
    // 비매칭 라인을 일부러 섞어, 그것이 DOM에 흘러가지 않음을 검증한다(보안 회귀 방지).
    const { container } = render(
      <DocumentPreview
        activeName="채용지원서.hwpx"
        preview={{ ok: true, html: "<h1>원본</h1>", markdown: "" }}
        loading={false}
        proposal={makeProposal({
          kind: "redact-pii",
          summary: "개인정보 1건 비식별",
          diff: "개인정보 1건 비식별 처리\n- 전화번호: 1건 → 010-****-5678\n원본 전화번호 010-1234-5678",
        })}
        onRequestStagedPreview={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff" }));
    // 허니스티 배너 + 마스킹 예시는 보이고, 비매칭 라인의 원문 평문(010-1234-5678)은 어디에도 없다
    expect(screen.getByText(/원문 값은 표시하지 않습니다/)).toBeTruthy();
    expect(screen.getByText(/010-\*\*\*\*-5678/)).toBeTruthy();
    expect(container.textContent).not.toContain("010-1234-5678");
  });
});
