// @vitest-environment jsdom
/**
 * FilePane 렌더러 테스트
 *
 * 회귀 방지 대상:
 * - 파일 목록 렌더 + 편집/읽기/변환 배지(.hwp=변환, writable=편집, else=읽기)
 * - 파일 선택 콜백(path)
 * - 빈 목록 안내
 * - 드롭 시 window.kodoc.doc.pathForFile로 절대경로 추출 후 onDropFiles
 * - 되돌리기 타임라인 렌더 + 복원 콜백, 비면 미표시
 * - 열기 버튼 콜백
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupEntry, FileEntry } from "../types.js";
import { FilePane } from "./FilePane.js";

const files: FileEntry[] = [
  { name: "보고서.hwpx", path: "보고서.hwpx", ext: ".hwpx", kind: "doc", writable: true },
  { name: "원본.hwp", path: "원본.hwp", ext: ".hwp", kind: "doc", writable: false },
  { name: "표.xlsx", path: "표.xlsx", ext: ".xlsx", kind: "sheet", writable: true },
  { name: "읽기.pdf", path: "읽기.pdf", ext: ".pdf", kind: "other", writable: false },
];

beforeEach(() => {
  vi.stubGlobal("kodoc", {
    doc: { pathForFile: (f: File) => `/abs/${f.name}` },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function baseProps() {
  return {
    files,
    activePath: null,
    onSelect: vi.fn(),
    onOpenDialog: vi.fn(),
    onDropFiles: vi.fn(),
    backups: [] as BackupEntry[],
    onRestore: vi.fn(),
  };
}

describe("FilePane — 파일 목록/배지", () => {
  it("파일별로 편집/변환/읽기 배지를 정확히 보여준다", () => {
    render(<FilePane {...baseProps()} />);
    // .hwpx writable → 편집, .hwp → 변환, .pdf non-writable → 읽기
    expect(screen.getAllByText("편집")).toHaveLength(2); // hwpx + xlsx
    expect(screen.getByText("변환")).toBeTruthy(); // hwp
    expect(screen.getByText("읽기")).toBeTruthy(); // pdf
  });

  it("파일 클릭 시 onSelect(path)", async () => {
    const props = baseProps();
    render(<FilePane {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /보고서\.hwpx/ }));
    expect(props.onSelect).toHaveBeenCalledWith("보고서.hwpx");
  });

  it("빈 목록이면 안내문을 보여준다", () => {
    render(<FilePane {...baseProps()} files={[]} />);
    expect(screen.getByText("지원 문서가 없습니다")).toBeTruthy();
  });

  it("열기 버튼은 onOpenDialog를 호출한다", async () => {
    const props = baseProps();
    render(<FilePane {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /열기/ }));
    expect(props.onOpenDialog).toHaveBeenCalledTimes(1);
  });
});

describe("FilePane — 드롭", () => {
  it("드롭 시 pathForFile로 절대경로를 만들어 onDropFiles", () => {
    const props = baseProps();
    const { container } = render(<FilePane {...props} />);
    const zone = container.querySelector(".dropzone") as HTMLElement;
    const file = new File(["x"], "새파일.hwpx");
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(props.onDropFiles).toHaveBeenCalledWith(["/abs/새파일.hwpx"]);
  });

  it("dragover 시 강조 클래스가 붙는다", () => {
    const { container } = render(<FilePane {...baseProps()} />);
    const zone = container.querySelector(".dropzone") as HTMLElement;
    fireEvent.dragOver(zone);
    expect(zone.className).toContain("dropzone--over");
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain("dropzone--over");
  });
});

describe("FilePane — 되돌리기 타임라인", () => {
  it("백업이 없으면 타임라인을 표시하지 않는다", () => {
    render(<FilePane {...baseProps()} />);
    expect(screen.queryByText("되돌리기 타임라인")).toBeNull();
  });

  it("백업 항목 클릭 시 onRestore(entry)", async () => {
    const props = baseProps();
    const backups: BackupEntry[] = [
      {
        filename: "bak-1",
        name: "보고서.hwpx",
        time: "2026-06-16 23:18:42",
        mtimeMs: 1,
        summary: "제목 수정",
      },
    ];
    render(<FilePane {...props} backups={backups} />);
    expect(screen.getByText("되돌리기 타임라인")).toBeTruthy();
    // time.slice(11,16) → "23:18"
    expect(screen.getByText("23:18")).toBeTruthy();
    await userEvent.click(screen.getByText("제목 수정"));
    expect(props.onRestore).toHaveBeenCalledWith(backups[0]);
  });
});
