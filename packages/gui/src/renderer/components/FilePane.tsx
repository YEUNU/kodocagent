import { useState } from "react";
import type { FileEntry } from "../types.js";

interface FilePaneProps {
  files: FileEntry[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onOpenDialog: () => void;
  onDropFiles: (absPaths: string[]) => void;
}

export function FilePane(props: FilePaneProps): React.ReactElement {
  const { files, activePath, onSelect, onOpenDialog, onDropFiles } = props;
  const [over, setOver] = useState(false);

  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setOver(true);
  }

  function handleDragLeave(): void {
    setOver(false);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.kodoc.doc.pathForFile(f))
      .filter(Boolean) as string[];
    if (paths.length) onDropFiles(paths);
  }

  return (
    <aside className="pane">
      <div className="pane__header">
        <span className="pane__title">파일</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenDialog}>
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          열기
        </button>
      </div>
      <div className="pane__body">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 파일 드롭 영역 */}
        <div
          className={`dropzone${over ? " dropzone--over" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          파일을 끌어다 놓으세요
          <span className="t-xs">.hwp · .hwpx · .xlsx</span>
        </div>

        {files.length === 0 ? (
          <div className="file-empty">지원 문서가 없습니다</div>
        ) : (
          files.map((f) => {
            const isActive = f.path === activePath;
            const isHwp = f.ext === ".hwp";

            return (
              <button
                key={f.path}
                type="button"
                className={`file${isActive ? " file--active" : ""}`}
                onClick={() => onSelect(f.path)}
              >
                {f.kind === "sheet" ? (
                  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <path d="M4 10h16M4 15h16M10 4v16" />
                  </svg>
                ) : (
                  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                    <path d="M14 3v5h5" />
                    <path d="M9 13h6M9 17h5" />
                  </svg>
                )}
                <span className="file__name">{f.name}</span>
                {isHwp ? (
                  <span className="file__badge file__badge--ro">변환</span>
                ) : f.writable ? (
                  <span className="file__badge file__badge--ok">편집</span>
                ) : (
                  <span className="file__badge file__badge--ro">읽기</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
