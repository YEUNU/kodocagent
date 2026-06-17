/**
 * propose_find_replace 테스트 (XML 직접 패치 방식)
 *
 * 1. replaceInSectionXml 단위 테스트 — 순수 함수, WASM 불필요
 *    - <hp:t> 내용 치환; 태그 밖 텍스트/속성은 변경 없음
 *    - caseSensitive true/false
 *    - all=true 전체 치환 vs all=false 첫 번째만
 *    - XML 이스케이프 (& < > 포함된 find/replace)
 *    - <hp:t/> self-closing은 변경 없음
 *    - 카운트 정확성
 * 2. 통합 테스트 (kordoc markdownToHwpx + JSZip)
 *    - 단락 텍스트 치환 → commit → kordoc 재파싱: 신규 텍스트 있음, 구텍스트 없음,
 *      block/table 카운트 UNCHANGED (구조 보존)
 *    - 표 셀 텍스트 치환
 *    - 찾을 텍스트 없음 → 오류, 파일 무수정
 *    - .hwp 확장자 → 오류
 *    - 기타 확장자 → 오류
 *    - ZIP 매직이 아닌 파일 → 오류
 *
 * 임시 파일은 OS tmpdir()에 생성하며 OS가 자동 정리한다.
 * rhwp WASM을 사용하지 않으므로 모든 테스트가 빠르게 실행된다.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import JSZip from "jszip";
import { markdownToHwpx, parse } from "kordoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectChangedSnippets,
  escapeXml,
  makeChangeSnippet,
  proposeFindReplaceTool,
  replaceInSectionXml,
  unescapeXml,
} from "./propose-find-replace.js";

// ─────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-find-replace-xml-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(() => {
  // 임시 디렉터리는 OS가 자동 정리
});

function makeCtx(subDir?: string): { cwd: string; sessionId: string } {
  return {
    cwd: subDir ?? testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

/**
 * markdownToHwpx가 반환하는 ArrayBuffer를 HWPX 파일로 저장하고 경로를 반환한다.
 */
async function saveHwpx(dir: string, name: string, md: string): Promise<string> {
  const buf = await markdownToHwpx(md);
  const filePath = join(dir, name);
  await writeFile(filePath, new Uint8Array(buf as ArrayBuffer));
  return filePath;
}

/**
 * HWPX 파일의 section0.xml 텍스트 내용을 추출한다.
 */
async function readSectionXml(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const entry = zip.file("Contents/section0.xml");
  if (!entry) return "";
  return entry.async("string");
}

/**
 * kordoc parse()로 HWPX의 블록 히스토그램을 반환한다.
 */
async function blockHistogram(buf: Uint8Array): Promise<Record<string, number>> {
  const result = await parse(buf.buffer as ArrayBuffer);
  if (!result.success) return {};
  const h: Record<string, number> = {};
  for (const b of result.blocks) {
    h[b.type] = (h[b.type] ?? 0) + 1;
  }
  return h;
}

// ─────────────────────────────────────────────────────────
// 1. replaceInSectionXml 단위 테스트 (WASM 불필요)
// ─────────────────────────────────────────────────────────

describe("replaceInSectionXml — 순수 함수 단위 테스트", () => {
  it("<hp:t> 내용을 치환한다", () => {
    const xml = `<hp:p><hp:run><hp:t>원본텍스트</hp:t></hp:run></hp:p>`;
    const { xml: out, count } = replaceInSectionXml(
      xml,
      "원본텍스트",
      "바뀐텍스트",
      false,
      true,
      0,
    );
    expect(out).toContain("<hp:t>바뀐텍스트</hp:t>");
    expect(out).not.toContain("원본텍스트");
    expect(count).toBe(1);
  });

  it("<hp:t> 바깥의 텍스트(태그 이름, 속성)는 변경하지 않는다", () => {
    // 태그 이름 및 속성에 find가 있어도 건드리지 않아야 함
    const xml = `<hp:run data-원본텍스트="x"><hp:t>원본텍스트</hp:t></hp:run>`;
    const { xml: out } = replaceInSectionXml(xml, "원본텍스트", "교체", false, true, 0);
    // <hp:t> 내용은 교체
    expect(out).toContain("<hp:t>교체</hp:t>");
    // 속성 값은 변경 없음
    expect(out).toContain('data-원본텍스트="x"');
  });

  it("caseSensitive=true: 대소문자 정확히 일치해야 치환", () => {
    const xml = `<hp:t>Hello World</hp:t><hp:t>hello world</hp:t>`;
    const { xml: out, count } = replaceInSectionXml(xml, "Hello", "HI", true, true, 0);
    expect(out).toContain("<hp:t>HI World</hp:t>");
    expect(out).toContain("<hp:t>hello world</hp:t>"); // 소문자 hello는 변경 없음
    expect(count).toBe(1);
  });

  it("caseSensitive=false: 대소문자 무시하여 치환", () => {
    const xml = `<hp:t>HELLO</hp:t><hp:t>hello</hp:t>`;
    const { xml: out, count } = replaceInSectionXml(xml, "hello", "교체", false, true, 0);
    // 둘 다 교체되어야 함
    expect(count).toBe(2);
    expect(out).not.toContain("HELLO");
    expect(out).not.toContain("hello");
    // 두 노드 모두 교체 텍스트로 바뀜
    const matches = out.match(/<hp:t>교체<\/hp:t>/g);
    expect(matches).toHaveLength(2);
  });

  it("all=true: 모든 발생을 치환", () => {
    const xml = `<hp:t>반복</hp:t><hp:t>반복</hp:t><hp:t>반복</hp:t>`;
    const { count } = replaceInSectionXml(xml, "반복", "교체", false, true, 0);
    expect(count).toBe(3);
  });

  it("all=false: 첫 번째 발생만 치환 (alreadyReplaced=0)", () => {
    const xml = `<hp:t>반복</hp:t><hp:t>반복</hp:t><hp:t>반복</hp:t>`;
    const { xml: out, count } = replaceInSectionXml(xml, "반복", "교체", false, false, 0);
    expect(count).toBe(1);
    // 첫 번째 <hp:t>만 교체
    expect(out).toContain("<hp:t>교체</hp:t>");
    // 나머지 두 개는 원본 유지
    const remaining = out.match(/<hp:t>반복<\/hp:t>/g);
    expect(remaining).toHaveLength(2);
  });

  it("all=false + alreadyReplaced=1: 이미 치환됐으면 이 섹션은 스킵", () => {
    const xml = `<hp:t>반복</hp:t>`;
    const { xml: out, count } = replaceInSectionXml(xml, "반복", "교체", false, false, 1);
    expect(count).toBe(0);
    expect(out).toContain("반복"); // 변경 없음
  });

  it("XML 이스케이프: find에 & 포함 — XML 내 &amp; 와 매칭", () => {
    // XML 내에서 & 는 &amp; 로 저장됨
    const xml = `<hp:t>A&amp;B</hp:t>`;
    // find는 평문 "A&B" → XML 내 &amp; 와 매칭되어야 함
    const { xml: out, count } = replaceInSectionXml(xml, "A&B", "C&D", false, true, 0);
    expect(count).toBe(1);
    expect(out).toContain("<hp:t>C&amp;D</hp:t>");
  });

  it("XML 이스케이프: find에 < 포함 — XML 내 &lt; 와 매칭", () => {
    const xml = `<hp:t>x&lt;y</hp:t>`;
    const { xml: out, count } = replaceInSectionXml(xml, "x<y", "교체", false, true, 0);
    expect(count).toBe(1);
    expect(out).toContain("<hp:t>교체</hp:t>");
  });

  it("XML 이스케이프: replace에 > 포함 — &gt; 로 삽입됨", () => {
    const xml = `<hp:t>원본</hp:t>`;
    const { xml: out, count } = replaceInSectionXml(xml, "원본", "a>b", false, true, 0);
    expect(count).toBe(1);
    expect(out).toContain("<hp:t>a&gt;b</hp:t>");
  });

  it("<hp:t/> self-closing은 변경하지 않는다", () => {
    const xml = `<hp:t/><hp:t>원본</hp:t><hp:t/>`;
    const { xml: out, count } = replaceInSectionXml(xml, "원본", "교체", false, true, 0);
    expect(count).toBe(1);
    // self-closing 은 그대로
    const selfClosingCount = (out.match(/<hp:t\/>/g) ?? []).length;
    expect(selfClosingCount).toBe(2);
    expect(out).toContain("<hp:t>교체</hp:t>");
  });

  it("find 텍스트가 없으면 count=0, xml 변경 없음", () => {
    const xml = `<hp:t>다른텍스트</hp:t>`;
    const { xml: out, count } = replaceInSectionXml(xml, "없는텍스트", "교체", false, true, 0);
    expect(count).toBe(0);
    expect(out).toBe(xml);
  });

  it("하나의 <hp:t> 노드 내 여러 발생을 all=true로 전부 치환", () => {
    const xml = `<hp:t>AAA AAA AAA</hp:t>`;
    const { count } = replaceInSectionXml(xml, "AAA", "BBB", false, true, 0);
    expect(count).toBe(3);
  });

  it("escapeXml 헬퍼: & < > 를 정확히 이스케이프", () => {
    expect(escapeXml("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
    expect(escapeXml("normal text")).toBe("normal text");
  });
});

// ─────────────────────────────────────────────────────────
// 2. 새 순수 헬퍼 단위 테스트
// ─────────────────────────────────────────────────────────

describe("unescapeXml — XML 이스케이프 역변환", () => {
  it("escapeXml의 역함수: &amp; &lt; &gt; 를 평문으로 되돌린다", () => {
    const original = "a&b<c>d";
    expect(unescapeXml(escapeXml(original))).toBe(original);
  });

  it("순서: &amp; 를 마지막에 처리해 이중 치환 없음", () => {
    // &amp;lt; → &lt; (amp를 먼저 처리하면 &lt;가 되고 그게 다시 < 로 바뀌는 버그 발생)
    // 올바른 구현은 lt/gt를 먼저, amp를 마지막에
    expect(unescapeXml("&amp;lt;")).toBe("&lt;");
    expect(unescapeXml("&lt;&gt;&amp;")).toBe("<>&");
  });

  it("이스케이프 없는 일반 텍스트는 그대로 반환", () => {
    expect(unescapeXml("hello world")).toBe("hello world");
  });
});

describe("makeChangeSnippet — 변경 구간 스니펫 생성", () => {
  it("짧은 문자열은 통째로 반환 (… 없음)", () => {
    const { before, after } = makeChangeSnippet("abc", "axc");
    expect(before).toBe("abc");
    expect(after).toBe("axc");
    expect(before).not.toContain("…");
    expect(after).not.toContain("…");
  });

  it("긴 문자열에서 가운데만 바뀌면 양끝이 잘리고 … 가 붙는다", () => {
    const prefix = "A".repeat(50);
    const suffix = "Z".repeat(50);
    const before = `${prefix}OLD${suffix}`;
    const after = `${prefix}NEW${suffix}`;
    const snip = makeChangeSnippet(before, after);
    // 변경 구간(OLD/NEW) 은 포함
    expect(snip.before).toContain("OLD");
    expect(snip.after).toContain("NEW");
    // 양쪽 끝은 잘려서 … 가 있어야 함
    expect(snip.before).toContain("…");
    expect(snip.after).toContain("…");
    // 원본 전체 길이보다 짧아야 함
    expect(snip.before.length).toBeLessThan(before.length);
  });

  it("앞만 다른 경우 — 뒤쪽만 … 붙거나 안 붙음", () => {
    const before = "CHANGED" + "X".repeat(60);
    const after = "NEWVAL" + "X".repeat(60);
    const snip = makeChangeSnippet(before, after);
    expect(snip.before).toContain("CHANGED");
    expect(snip.after).toContain("NEWVAL");
  });
});

describe("collectChangedSnippets — 변경 노드 스니펫 수집", () => {
  it("변경된 <hp:t> 노드만 반환한다", () => {
    const beforeXml = `<hp:t>unchanged</hp:t><hp:t>original</hp:t>`;
    const afterXml = `<hp:t>unchanged</hp:t><hp:t>replaced</hp:t>`;
    const snippets = collectChangedSnippets(beforeXml, afterXml, 10);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.before).toBe("original");
    expect(snippets[0]!.after).toBe("replaced");
  });

  it("변경 없으면 빈 배열 반환", () => {
    const xml = `<hp:t>same</hp:t><hp:t>same2</hp:t>`;
    expect(collectChangedSnippets(xml, xml, 10)).toHaveLength(0);
  });

  it("maxSamples를 초과하면 잘린다", () => {
    const beforeXml = Array.from({ length: 5 }, (_, i) => `<hp:t>before${i}</hp:t>`).join("");
    const afterXml = Array.from({ length: 5 }, (_, i) => `<hp:t>after${i}</hp:t>`).join("");
    const snippets = collectChangedSnippets(beforeXml, afterXml, 3);
    expect(snippets).toHaveLength(3);
  });

  it("XML 이스케이프를 평문으로 변환해서 반환한다", () => {
    const beforeXml = `<hp:t>A&amp;B</hp:t>`;
    const afterXml = `<hp:t>C&amp;D</hp:t>`;
    const snippets = collectChangedSnippets(beforeXml, afterXml, 10);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.before).toBe("A&B");
    expect(snippets[0]!.after).toBe("C&D");
  });
});

// ─────────────────────────────────────────────────────────
// 3. 통합 테스트
// ─────────────────────────────────────────────────────────

describe("proposeFindReplaceTool — 기본 치환 (단락)", () => {
  it("단락 텍스트 치환 → commit → kordoc 재파싱: 새 텍스트 있음, 구텍스트 없음, 구조 보존", async () => {
    const subDir = join(testDir, `basic-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const md = `# 테스트

원본텍스트 입니다.

두 번째 단락.
`;
    const filePath = await saveHwpx(subDir, "test.hwpx", md);

    // 치환 전 블록 히스토그램
    const origBuf = await readFile(filePath);
    const beforeHist = await blockHistogram(
      new Uint8Array(origBuf.buffer, origBuf.byteOffset, origBuf.byteLength),
    );

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "test.hwpx",
        find: "원본텍스트",
        replace: "바뀐텍스트",
        caseSensitive: false,
        all: true,
        summary: "원본텍스트를 바뀐텍스트로 교체",
      },
      ctx,
    });

    // ProposeOutcome이어야 함 (오류 문자열이 아님)
    expect(typeof result).not.toBe("string");
    const outcome = result as { proposal: unknown; commit: () => Promise<string> };
    expect(outcome.proposal).toBeDefined();
    expect(outcome.commit).toBeTypeOf("function");

    const proposal = outcome.proposal as {
      diff: string;
      kind: string;
      targetPath: string;
      willConvertFormat: string | undefined;
      warnings: string[];
    };
    expect(proposal.diff).toContain("원본텍스트");
    expect(proposal.diff).toContain("바뀐텍스트");
    // 새 포맷: "N곳 교체: ..." 헤더 + numbered 스니펫 라인
    expect(proposal.diff).toContain("곳 교체:");
    expect(proposal.kind).toBe("find-replace");

    // .hwpx 입력 → 출력도 .hwpx (포맷 변환 없음)
    expect(extname(proposal.targetPath).toLowerCase()).toBe(".hwpx");
    expect(proposal.willConvertFormat).toBeUndefined();

    // commit
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain("저장 완료");

    // kordoc 재파싱으로 내용 검증
    const afterBuf = await readFile(filePath);
    const afterHist = await blockHistogram(
      new Uint8Array(afterBuf.buffer, afterBuf.byteOffset, afterBuf.byteLength),
    );

    // 구조 보존: 블록 카운트 동일
    for (const [type, cnt] of Object.entries(beforeHist)) {
      expect(afterHist[type]).toBe(cnt);
    }

    // 섹션 XML에서 직접 확인
    const sectionXml = await readSectionXml(filePath);
    expect(sectionXml).not.toContain("원본텍스트");
    expect(sectionXml).toContain("바뀐텍스트");
  }, 30000);
});

describe("proposeFindReplaceTool — 표 셀 텍스트 치환", () => {
  it("표 셀 내 텍스트도 치환됨; block/table 카운트 보존", async () => {
    const subDir = join(testDir, `table-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const md = `# 표 테스트

| 항목 | 값 |
| --- | --- |
| 찾을셀 | 100 |
| 기타 | 200 |
`;
    const filePath = await saveHwpx(subDir, "table.hwpx", md);
    const origBuf = await readFile(filePath);
    const beforeHist = await blockHistogram(
      new Uint8Array(origBuf.buffer, origBuf.byteOffset, origBuf.byteLength),
    );

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "table.hwpx",
        find: "찾을셀",
        replace: "바뀐셀",
        caseSensitive: false,
        all: true,
        summary: "표 셀 텍스트 교체",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as { commit: () => Promise<string> };
    await outcome.commit();

    const afterBuf = await readFile(filePath);
    const afterHist = await blockHistogram(
      new Uint8Array(afterBuf.buffer, afterBuf.byteOffset, afterBuf.byteLength),
    );

    // 구조 보존
    for (const [type, cnt] of Object.entries(beforeHist)) {
      expect(afterHist[type]).toBe(cnt);
    }

    const sectionXml = await readSectionXml(filePath);
    expect(sectionXml).not.toContain("찾을셀");
    expect(sectionXml).toContain("바뀐셀");
  }, 30000);
});

describe("proposeFindReplaceTool — 찾을 텍스트 없음", () => {
  it("문서에 없는 텍스트 → 오류 문자열 반환, 파일 무수정", async () => {
    const subDir = join(testDir, `notfound-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const md = `# 없는 텍스트 테스트

이 문서에는 찾을텍스트가 없습니다.
`;
    const filePath = await saveHwpx(subDir, "notfound.hwpx", md);
    const originalBuf = await readFile(filePath);

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "notfound.hwpx",
        find: "절대존재하지않는텍스트XYZ",
        replace: "교체값",
        caseSensitive: false,
        all: true,
        summary: "없는 텍스트 교체 시도",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("찾을 텍스트를 문서에서 발견하지 못했습니다");

    // 파일 무수정
    const afterBuf = await readFile(filePath);
    expect(Buffer.from(afterBuf).equals(Buffer.from(originalBuf))).toBe(true);
  }, 30000);
});

describe("proposeFindReplaceTool — 여러 곳 치환 (all:true)", () => {
  it("여러 단락+표 셀에 등장하는 텍스트를 전부 교체", async () => {
    const subDir = join(testDir, `multi-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const md = `# 다중 치환 테스트

반복단어 입니다. 반복단어 두 번째.

| 항목 | 값 |
| --- | --- |
| 반복단어 | 100 |
`;
    const filePath = await saveHwpx(subDir, "multi.hwpx", md);

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "multi.hwpx",
        find: "반복단어",
        replace: "교체완료",
        caseSensitive: false,
        all: true,
        summary: "모든 반복단어를 교체",
      },
      ctx,
    });

    expect(typeof result).not.toBe("string");
    const outcome = result as { proposal: unknown; commit: () => Promise<string> };
    const proposal = outcome.proposal as { diff: string };
    // 새 포맷: "N곳 교체: ..." 헤더
    expect(proposal.diff).toContain("곳 교체:");

    await outcome.commit();

    const sectionXml = await readSectionXml(filePath);
    expect(sectionXml).not.toContain("반복단어");
    expect(sectionXml).toContain("교체완료");
  }, 30000);
});

describe("proposeFindReplaceTool — .hwp 확장자 오류", () => {
  it(".hwp 파일 → 오류 반환 (.hwpx로 저장 안내)", async () => {
    const subDir = join(testDir, `hwp-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // HWPX 내용을 .hwp 확장자로 저장 (실제로는 ZIP 바이트)
    const md = `# HWP 파일\n\n내용입니다.\n`;
    const hwpxPath = await saveHwpx(subDir, "source.hwpx", md);
    const hwpContent = await readFile(hwpxPath);
    const hwpPath = join(subDir, "test.hwp");
    await writeFile(hwpPath, hwpContent);

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "test.hwp",
        find: "내용",
        replace: "교체",
        caseSensitive: false,
        all: true,
        summary: "hwp 치환 시도",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    // .hwpx로 저장 안내 포함
    expect(result as string).toContain(".hwpx");
    // 오류 메시지
    expect(result as string).toContain("오류");
  }, 15000);
});

describe("proposeFindReplaceTool — 지원하지 않는 확장자", () => {
  it(".docx 파일 → 오류 반환", async () => {
    const subDir = join(testDir, `ext-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const filePath = join(subDir, "test.docx");
    await writeFile(filePath, Buffer.from("fake docx content"));

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "test.docx",
        find: "텍스트",
        replace: "교체",
        caseSensitive: false,
        all: true,
        summary: "docx 치환 시도",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain(".hwpx");
    expect(result as string).toContain("오류");
  }, 10000);
});

describe("proposeFindReplaceTool — ZIP 매직 바이트 검증", () => {
  it("ZIP이 아닌 .hwpx 파일 → 오류 반환", async () => {
    const subDir = join(testDir, `magic-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // ZIP 매직 바이트가 아닌 파일 (.hwpx 확장자지만 OLE 바이너리처럼 0xD0 0xCF로 시작)
    const fakePath = join(subDir, "fake.hwpx");
    await writeFile(fakePath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]));

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "fake.hwpx",
        find: "텍스트",
        replace: "교체",
        caseSensitive: false,
        all: true,
        summary: "손상 파일 치환 시도",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("오류");
    expect(result as string).toContain(".hwpx");
  }, 10000);
});
