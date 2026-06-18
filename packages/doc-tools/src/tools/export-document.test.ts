/**
 * export_document 테스트
 *
 * - .hwpx → .html: 변환·커밋·출력 파일에 HTML/본문 텍스트 확인
 * - .hwpx → .pdf: puppeteer-core 미설치 환경에서 친절한 안내 문자열 반환
 * - 지원하지 않는 출력 확장자(.txt) → 오류 문자열
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToHwpx } from "kordoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportDocumentTool } from "./export-document.js";

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-export-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(() => {
  // OS가 임시 디렉터리 정리
});

function makeCtx(dir: string): { cwd: string; sessionId: string } {
  return { cwd: dir, sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

async function saveHwpx(dir: string, name: string, md: string): Promise<string> {
  const buf = await markdownToHwpx(md);
  const p = join(dir, name);
  await writeFile(p, new Uint8Array(buf as ArrayBuffer));
  return p;
}

describe("exportDocumentTool", () => {
  it(".hwpx를 .html로 내보내고 커밋하면 HTML 파일이 생성된다", async () => {
    const subDir = join(testDir, `html-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    await saveHwpx(subDir, "src.hwpx", "# 보고서 제목\n\n본문 문단입니다.\n");

    const ctx = makeCtx(subDir);
    const result = await exportDocumentTool.propose?.({
      input: { path: "src.hwpx", outputPath: "out.html" },
      ctx,
    });

    expect(typeof result).toBe("object");
    if (result == null || typeof result === "string") throw new Error(String(result));
    expect(result.proposal.kind).toBe("export");
    expect(result.proposal.targetPath).toContain("out.html");

    const msg = await result.commit();
    expect(msg).toContain("out.html");

    const html = await readFile(join(subDir, "out.html"), "utf-8");
    expect(html.toLowerCase()).toContain("<html");
    expect(html).toContain("보고서 제목");
  }, 15000);

  it(".pdf 출력은 puppeteer-core 미설치 시 친절한 안내를 반환한다", async () => {
    const subDir = join(testDir, `pdf-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    await saveHwpx(subDir, "src.hwpx", "# 제목\n\n본문.\n");

    const ctx = makeCtx(subDir);
    const result = await exportDocumentTool.propose?.({
      input: { path: "src.hwpx", outputPath: "out.pdf" },
      ctx,
    });

    // puppeteer-core 미설치 환경: 안내 문자열. (설치 환경이면 제안 객체 — 둘 다 허용)
    if (typeof result === "string") {
      expect(result).toContain("puppeteer-core");
      expect(result).toContain(".html");
    } else {
      expect(result?.proposal.kind).toBe("export");
    }
  }, 15000);

  it("지원하지 않는 출력 확장자(.txt)는 오류를 반환한다", async () => {
    const subDir = join(testDir, `bad-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    await saveHwpx(subDir, "src.hwpx", "# 제목\n");

    const ctx = makeCtx(subDir);
    const result = await exportDocumentTool.propose?.({
      input: { path: "src.hwpx", outputPath: "out.txt" },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("오류");
    expect(result as string).toContain(".html");
  }, 15000);
});
