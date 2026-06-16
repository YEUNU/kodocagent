/**
 * propose_find_replace 테스트
 *
 * 1. verifyReplacementComplete 단위 테스트 — 순수 함수, WASM 불필요
 * 2. 통합 테스트 — 실제 @rhwp/core WASM 사용 (타임아웃 넉넉히)
 *
 * 테스트 시나리오:
 * 1. verifyReplacementComplete: 완전 치환 / 불완전 치환 / replace가 find를 포함 /
 *    대소문자 구분 / caseSensitive=false
 * 2. 기본 치환: HWPX → 텍스트 찾아 바꾸기 → commit → 내용 확인
 * 3. 표 셀 내 텍스트 치환
 * 4. 찾을 텍스트 없음 → 오류 반환, 파일 무수정
 * 5. 여러 곳 치환 (all:true) → 모두 교체 확인
 * 6. .hwp 입력 → 출력이 .hwpx (willConvertFormat, 경로), 경고 포함
 * 7. 지원하지 않는 확장자 → 오류
 *
 * 임시 파일은 OS tmpdir()에 생성하며 OS가 자동 정리한다.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { markdownToHwpx } from "@clazic/kordoc";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposeFindReplaceTool, verifyReplacementComplete } from "./propose-find-replace.js";

// ─────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-find-replace-test-${Date.now()}`);
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
async function readSectionText(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const entry = zip.file("Contents/section0.xml");
  if (!entry) return "";
  return entry.async("string");
}

// ─────────────────────────────────────────────────────────
// 1. verifyReplacementComplete 단위 테스트 (WASM 불필요)
// ─────────────────────────────────────────────────────────

describe("verifyReplacementComplete — 순수 함수 단위 테스트", () => {
  it("완전 치환: after에 find가 없으면 ok:true, remaining:0", () => {
    const result = verifyReplacementComplete("원본 텍스트", "바뀐 텍스트", "원본", "바뀐", false);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it("불완전 치환: after에 find가 남아 있으면 ok:false, remaining>0", () => {
    const result = verifyReplacementComplete(
      "원본 텍스트 원본",
      "원본 텍스트 원본", // 치환이 전혀 반영 안 됨
      "원본",
      "교체",
      false,
    );
    expect(result.ok).toBe(false);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.skipped).toBe(false);
  });

  it("불완전 치환: 일부만 교체됨 (remaining=1)", () => {
    // "원본"이 3곳인데 2곳만 교체된 상황
    const result = verifyReplacementComplete(
      "원본 원본 원본",
      "교체 교체 원본", // 마지막 1개 남음
      "원본",
      "교체",
      false,
    );
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(1);
    expect(result.skipped).toBe(false);
  });

  it("replace가 find를 포함: skipped:true, ok:true (remaining은 참고용)", () => {
    // "찾기" → "찾기완료" : replace("찾기완료")에 find("찾기")가 포함됨
    const result = verifyReplacementComplete(
      "찾기 텍스트",
      "찾기완료 텍스트", // 치환 후에도 "찾기"가 포함된 상태
      "찾기",
      "찾기완료",
      false,
    );
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    // remaining은 양수 (찾기완료 안에 "찾기"가 있음)
    expect(result.remaining).toBeGreaterThan(0);
  });

  it("caseSensitive:true — 대소문자 구분: 대소문자 다르면 찾지 못함 → 치환 없음으로 간주 (남은=0)", () => {
    // caseSensitive=true 이면 "HELLO"와 "hello"는 다름
    // after에서 "HELLO"를 찾는데 "hello"만 있으면 → remaining=0 → ok:true
    const result = verifyReplacementComplete(
      "HELLO world",
      "hello world", // after에는 소문자만 있음
      "HELLO",
      "hello",
      true, // caseSensitive
    );
    // caseSensitive=true이면 "HELLO"를 대문자로 찾음 → after에 없음 → remaining=0
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it("caseSensitive:false — 대소문자 무시: after에 find 소문자가 있으면 remaining에 반영", () => {
    // caseSensitive=false이면 "HELLO"와 "hello"는 같음
    // after에 "hello"가 남아 있으면 → remaining=1 → ok:false
    const result = verifyReplacementComplete(
      "HELLO world",
      "hello world", // 치환이 안 됐거나 replace가 소문자 버전
      "HELLO",
      "교체됨",
      false, // caseSensitive
    );
    // caseSensitive=false이므로 "hello"도 "hello"(normalized)로 매칭 → remaining=1
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(1);
    expect(result.skipped).toBe(false);
  });

  it("caseSensitive:false — replace가 find(대소문자 무시)를 포함: skipped:true", () => {
    // "abc" → "ABC" : caseSensitive=false이면 "ABC".toLowerCase()="abc"가 "abc"를 포함
    const result = verifyReplacementComplete("abc def", "ABC def", "abc", "ABC", false);
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 2. 기본 치환 — propose + commit + 내용 확인
// ─────────────────────────────────────────────────────────

describe("proposeFindReplaceTool — 기본 치환", () => {
  it("원본텍스트 → 바뀐텍스트 (단락): propose + commit 후 파일에 반영됨", async () => {
    const subDir = join(testDir, `basic-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const md = `# 테스트

원본텍스트 입니다.

두 번째 단락.
`;
    const filePath = await saveHwpx(subDir, "test.hwpx", md);

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

    // 오류 문자열이 아닌 ProposeOutcome이어야 함
    expect(typeof result).not.toBe("string");
    const outcome = result as { proposal: unknown; commit: () => Promise<string> };
    expect(outcome.proposal).toBeDefined();
    expect(outcome.commit).toBeTypeOf("function");

    // diff에 치환 정보 포함
    const proposal = outcome.proposal as {
      diff: string;
      kind: string;
      targetPath: string;
      willConvertFormat: string | undefined;
    };
    expect(proposal.diff).toContain("원본텍스트");
    expect(proposal.diff).toContain("바뀐텍스트");
    expect(proposal.kind).toBe("find-replace");

    // .hwpx 입력 → 출력도 .hwpx (포맷 변환 없음)
    expect(extname(proposal.targetPath).toLowerCase()).toBe(".hwpx");
    expect(proposal.willConvertFormat).toBeUndefined();

    // commit 실행
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain("저장 완료");

    // 파일 내용 확인
    const sectionText = await readSectionText(filePath);
    expect(sectionText).not.toContain("원본텍스트");
    expect(sectionText).toContain("바뀐텍스트");
  }, 30000); // WASM 초기화 포함

  it("표 셀 내 텍스트도 치환됨", async () => {
    const subDir = join(testDir, `table-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const md = `# 표 테스트

| 항목 | 값 |
| --- | --- |
| 찾을셀 | 100 |
| 기타 | 200 |
`;
    const filePath = await saveHwpx(subDir, "table.hwpx", md);

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

    const sectionText = await readSectionText(filePath);
    expect(sectionText).not.toContain("찾을셀");
    expect(sectionText).toContain("바뀐셀");
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// 3. 찾을 텍스트 없음 → 오류, 파일 무수정
// ─────────────────────────────────────────────────────────

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

    // 오류 문자열 반환
    expect(typeof result).toBe("string");
    expect(result as string).toContain("찾을 텍스트를 문서에서 발견하지 못했습니다");

    // 파일 내용 변경 없음
    const afterBuf = await readFile(filePath);
    expect(Buffer.from(afterBuf).equals(Buffer.from(originalBuf))).toBe(true);
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// 4. 여러 곳 치환 (all:true) → 개수 확인
// ─────────────────────────────────────────────────────────

describe("proposeFindReplaceTool — 여러 곳 치환", () => {
  it("4번 등장하는 텍스트 all:true → 모두 교체됨", async () => {
    const subDir = join(testDir, `multi-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    const md = `# 다중 치환 테스트

반복단어 입니다. 반복단어 두 번째. 반복단어 세 번째.

| 항목 | 값 |
| --- | --- |
| 반복단어 | 100 |
| 기타 | 200 |
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

    // diff에 교체 개수 포함
    const proposal = outcome.proposal as { diff: string };
    expect(proposal.diff).toContain("교체됨");

    await outcome.commit();

    const sectionText = await readSectionText(filePath);
    expect(sectionText).not.toContain("반복단어");
    // 교체완료가 적어도 1개 이상 있어야 함
    expect(sectionText.includes("교체완료")).toBe(true);
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// 5. .hwp 입력 → 출력이 .hwpx, willConvertFormat 설정, 경고 포함
// ─────────────────────────────────────────────────────────

describe("proposeFindReplaceTool — .hwp 입력 → .hwpx 출력", () => {
  it(".hwpx를 .hwp로 복사 후 치환: 출력 경로가 .hwpx, willConvertFormat 설정, 경고 포함", async () => {
    const subDir = join(testDir, `hwp-input-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // .hwpx를 생성한 뒤 .hwp 확장자로 복사 (rhwp는 확장자로만 구분)
    const md = `# HWP 입력 테스트

변환테스트 텍스트입니다.
`;
    const hwpxPath = await saveHwpx(subDir, "source.hwpx", md);
    const hwpContent = await readFile(hwpxPath);

    // .hwp 확장자로 저장 (실제로는 hwpx 바이트, 단순 확장자 변경)
    const hwpPath = join(subDir, "test.hwp");
    await writeFile(hwpPath, hwpContent);

    const ctx = makeCtx(subDir);
    const result = await proposeFindReplaceTool.propose?.({
      input: {
        path: "test.hwp",
        find: "변환테스트",
        replace: "변환완료",
        caseSensitive: false,
        all: true,
        summary: "hwp 파일 텍스트 교체",
      },
      ctx,
    });

    // 오류 문자열이 아닌 ProposeOutcome이어야 함
    expect(typeof result).not.toBe("string");
    const outcome = result as {
      proposal: {
        targetPath: string;
        willConvertFormat: string | undefined;
        warnings: string[];
      };
      commit: () => Promise<string>;
    };

    // 출력 경로가 .hwpx
    expect(extname(outcome.proposal.targetPath).toLowerCase()).toBe(".hwpx");

    // willConvertFormat 설정됨
    expect(outcome.proposal.willConvertFormat).toBeDefined();
    expect(outcome.proposal.willConvertFormat).toContain(".hwp");
    expect(outcome.proposal.willConvertFormat).toContain(".hwpx");

    // .hwp 입력 경고 포함
    expect(outcome.proposal.warnings).toContain(
      "rhwp는 .hwp 직접 저장을 지원하지 않아 .hwpx로 저장됩니다.",
    );

    // commit 실행 — 출력 경로가 .hwpx이어야 함
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain("저장 완료");
    expect(commitMsg).toContain(".hwpx");
  }, 30000);
});

// ─────────────────────────────────────────────────────────
// 6. 지원하지 않는 확장자 → 오류
// ─────────────────────────────────────────────────────────

describe("proposeFindReplaceTool — 확장자 검증", () => {
  it(".docx 파일 → 지원 안 함 오류", async () => {
    const subDir = join(testDir, `ext-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // 빈 파일 생성 (내용 무관, 확장자 검사가 먼저)
    const filePath = join(subDir, "test.docx");
    await writeFile(filePath, Buffer.from("fake"));

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
    expect(result as string).toContain(".hwp");
  }, 10000);
});
