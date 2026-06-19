// @vitest-environment jsdom
/**
 * DocumentPreview 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - 로딩/빈/성공/오류 4상태 렌더
 * - 성공 시 iframe sandbox는 allow-same-origin만(스크립트 불가), srcDoc에 CSP 메타가 박힌다
 * - CSP가 외부 스크립트/이미지/연결을 차단(default-src 'none', img-src data:만)
 * - 미리보기 HTML이 srcDoc body에 들어간다(근사 안내문 포함)
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentPreview } from "./DocumentPreview.js";

afterEach(cleanup);

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
