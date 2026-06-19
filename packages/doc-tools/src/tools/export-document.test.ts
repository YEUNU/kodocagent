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

  it("HTML 내보내기 결과에 <script>·on* 이벤트·javascript: 가 없다", async () => {
    const subDir = join(testDir, `xss-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    // 마크다운 안에 raw HTML(인라인 XSS 벡터) 포함
    const md =
      "# 제목\n\n본문입니다.\n\n" +
      "<script>alert('xss')</script>\n\n" +
      '<img src="x" onerror="alert(1)">\n\n' +
      '<a href="javascript:alert(2)">링크</a>\n\n' +
      '<iframe src="http://evil.example"></iframe>\n';
    await saveHwpx(subDir, "src.hwpx", md);

    const ctx = makeCtx(subDir);
    const result = await exportDocumentTool.propose?.({
      input: { path: "src.hwpx", outputPath: "out.html" },
      ctx,
    });

    expect(typeof result).toBe("object");
    if (result == null || typeof result === "string") throw new Error(String(result));

    await result.commit();
    const html = await readFile(join(subDir, "out.html"), "utf-8");

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<iframe/i);
    // 정상 본문은 보존
    expect(html).toContain("제목");
    expect(html).toContain("본문");
    // 위험 구문이 제거됐으므로 경고가 붙는다
    expect(result.proposal.warnings.some((w) => w.includes("위험 HTML"))).toBe(true);
  }, 15000);

  it("HTML 내보내기: meta http-equiv=refresh(리다이렉트)도 제거된다", async () => {
    const subDir = join(testDir, `refresh-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    const md = "# 제목\n\n" + '<meta http-equiv="refresh" content="0;url=http://evil.example">\n';
    await saveHwpx(subDir, "src.hwpx", md);

    const ctx = makeCtx(subDir);
    const result = await exportDocumentTool.propose?.({
      input: { path: "src.hwpx", outputPath: "out.html" },
      ctx,
    });
    if (result == null || typeof result === "string") throw new Error(String(result));
    await result.commit();
    const html = await readFile(join(subDir, "out.html"), "utf-8");
    expect(html).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
  }, 15000);

  it("HTML 내보내기: 표 내용은 정화 후에도 보존된다", async () => {
    const subDir = join(testDir, `safe-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    const md = "# 문서\n\n" + "| 항목 | 값 |\n|---|---|\n| 이름 | 홍길동 |\n";
    await saveHwpx(subDir, "src.hwpx", md);

    const ctx = makeCtx(subDir);
    const result = await exportDocumentTool.propose?.({
      input: { path: "src.hwpx", outputPath: "out.html" },
      ctx,
    });

    expect(typeof result).toBe("object");
    if (result == null || typeof result === "string") throw new Error(String(result));

    await result.commit();
    const html = await readFile(join(subDir, "out.html"), "utf-8");

    expect(html).toContain("홍길동");
    expect(html.toLowerCase()).toMatch(/<table/);
    // 정상(위험 구문 없는) 문서엔 보안 경고가 붙지 않는다
    expect(result.proposal.warnings.some((w) => w.includes("위험 HTML"))).toBe(false);
    // kordoc 서식 CSS(<style> 블록)가 정화 후에도 보존된다(스타일 회귀 방지)
    expect(html.toLowerCase()).toMatch(/<style/);
  }, 15000);
});
