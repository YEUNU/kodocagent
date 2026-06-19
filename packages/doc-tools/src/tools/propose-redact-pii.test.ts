/**
 * propose_redact_pii 통합 테스트
 *
 * 1. PII가 포함된 .txt → ProposeOutcome 반환; commit 후 원문 없음·마스킹 있음; diff에 원문 없음
 * 2. PII가 없는 .txt → 노-op 문자열 반환 (proposal 아님)
 * 3. .docx → 미지원 포맷 오류 문자열
 */

import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { markdownToHwpx, parse } from "kordoc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeRedactPiiTool } from "./propose-redact-pii.js";

/** markdownToHwpx로 .hwpx 파일을 만들고 경로를 반환한다. */
async function saveHwpx(dir: string, name: string, md: string): Promise<string> {
  const buf = await markdownToHwpx(md);
  const filePath = join(dir, name);
  await writeFile(filePath, new Uint8Array(buf as ArrayBuffer));
  return filePath;
}

/** HWPX의 section0.xml을 새 내용으로 교체한다(크로스런 픽스처 조립용). */
async function rewriteSectionXml(
  filePath: string,
  transform: (xml: string) => string,
): Promise<void> {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const entry = zip.file("Contents/section0.xml");
  if (!entry) throw new Error("section0.xml 없음");
  zip.file("Contents/section0.xml", transform(await entry.async("string")));
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(filePath, new Uint8Array(out as unknown as ArrayBuffer));
}

async function reparseMarkdown(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const re = await parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  return re.success ? re.markdown : "";
}

const TEST_DIR_BASE = join(tmpdir(), `kodocagent-test-redact-pii-${Date.now()}`);

let testDir: string;
let ctx: { cwd: string; sessionId: string };

beforeEach(async () => {
  testDir = `${TEST_DIR_BASE}-${Math.random().toString(36).slice(2)}`;
  await mkdir(testDir, { recursive: true });
  ctx = {
    cwd: await realpath(testDir),
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("proposeRedactPiiTool", () => {
  it("PII가 포함된 .txt → ProposeOutcome 반환, commit 후 원문 제거·마스킹 확인, diff에 원문 없음", async () => {
    const rawPhone = "010-1234-5678";
    const rawEmail = "user@example.com";
    const rawRrn = "901215-1234567";
    const content = [
      `담당자: 홍길동`,
      `전화: ${rawPhone}`,
      `이메일: ${rawEmail}`,
      `주민번호: ${rawRrn}`,
    ].join("\n");

    const filename = "contact.txt";
    await writeFile(join(testDir, filename), content, "utf-8");

    const result = await proposeRedactPiiTool.propose?.({
      input: { path: filename },
      ctx,
    });

    // ProposeOutcome이어야 한다 (string이면 오류)
    expect(typeof result).not.toBe("string");
    const outcome = result as Exclude<typeof result, string | undefined>;

    expect(outcome.proposal.kind).toBe("redact-pii");
    expect(outcome.proposal.targetPath).toContain(filename);
    // read 시점 mtime을 lost-update 베이스라인으로 실어 보낸다
    expect(typeof outcome.proposal.sourceMtimeMs).toBe("number");

    // diff에 원문 PII가 없어야 한다
    const diff = outcome.proposal.diff;
    expect(diff).not.toContain("1234-5678");
    expect(diff).not.toContain("user@");
    expect(diff).not.toContain("901215-1234567");
    // diff에는 마스킹 형태나 건수가 포함되어야 한다
    expect(diff).toContain("건");

    // commit 실행
    const commitMsg = await outcome.commit();
    expect(commitMsg).toContain(filename);

    // 커밋된 파일에서 원문 PII가 없어야 한다
    const saved = await readFile(outcome.proposal.targetPath, "utf-8");
    expect(saved).not.toContain("1234-5678");
    expect(saved).not.toContain("user@example");
    expect(saved).not.toContain("901215-1234567");
    // 마스킹 형태가 있어야 한다
    expect(saved).toContain("****");
  });

  it("PII가 없는 .txt → 노-op 문자열 반환 (proposal 없음)", async () => {
    await writeFile(
      join(testDir, "clean.txt"),
      "회의는 3시입니다. 예산은 1,000,000원입니다.",
      "utf-8",
    );

    const result = await proposeRedactPiiTool.propose?.({
      input: { path: "clean.txt" },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("발견되지 않아");
  });

  it(".docx 경로 → 미지원 포맷 오류 문자열", async () => {
    // 실제 파일이 없어도 경로 확인 전에 ext 체크가 된다
    // resolveSafePath가 ENOENT에서 부모 디렉터리를 사용하므로 testDir 안에 가짜 .docx 만들기
    await writeFile(join(testDir, "test.docx"), "PK fake", "utf-8");

    const result = await proposeRedactPiiTool.propose?.({
      input: { path: "test.docx" },
      ctx,
    });

    expect(typeof result).toBe("string");
    const msg = result as string;
    expect(msg).toContain("오류");
    expect(msg).toContain(".hwpx");
  });
});

// ─────────────────────────────────────────────────────────
// .hwpx 마스킹 (kordoc splice 경로) — 구조 보존 + 서식 분리 PII
// ─────────────────────────────────────────────────────────

describe("proposeRedactPiiTool — .hwpx splice 마스킹", () => {
  it(".hwpx 본문 PII를 마스킹하고 커밋 후 재파싱에 원문 없음·마스킹 있음", async () => {
    const md = "# 연락처\n\n전화: 010-1234-5678 / 이메일: user@example.com\n";
    const filePath = await saveHwpx(testDir, "contact.hwpx", md);

    const result = await proposeRedactPiiTool.propose?.({ input: { path: "contact.hwpx" }, ctx });
    expect(typeof result).not.toBe("string");
    const outcome = result as Exclude<typeof result, string | undefined>;
    expect(outcome.proposal.kind).toBe("redact-pii");
    // read 시점 mtime을 lost-update 베이스라인으로 실어 보낸다
    expect(typeof outcome.proposal.sourceMtimeMs).toBe("number");
    // diff에 원문 PII 미노출
    expect(outcome.proposal.diff).not.toContain("1234-5678");
    expect(outcome.proposal.diff).not.toContain("user@example");

    await outcome.commit();
    const markdown = await reparseMarkdown(filePath);
    expect(markdown).not.toContain("010-1234-5678");
    expect(markdown).not.toContain("user@example.com");
    expect(markdown).toContain("010-****-5678");
  }, 15000);

  it("여러 hp:t 런에 나뉜 전화번호도 경계를 가로질러 마스킹한다(splice 경로)", async () => {
    const md = "# 연락처\n\n대표번호 010-1234-5678 입니다.\n";
    const filePath = await saveHwpx(testDir, "crossrun-pii.hwpx", md);

    // "010-1234-5678" 을 "010-1234" | "-5678" 두 런으로 분할 → 노드 단위로는 매칭 불가
    await rewriteSectionXml(filePath, (xml) => {
      const one = "<hp:t>대표번호 010-1234-5678 입니다.</hp:t>";
      if (!xml.includes(one)) throw new Error("전제: 단일 hp:t 미발견");
      const two =
        '<hp:t>대표번호 010-1234</hp:t></hp:run><hp:run charPrIDRef="0">' +
        "<hp:t>-5678 입니다.</hp:t>";
      return xml.replace(one, two);
    });

    const result = await proposeRedactPiiTool.propose?.({
      input: { path: "crossrun-pii.hwpx" },
      ctx,
    });
    // 제안 객체 반환 = 크로스런 PII가 탐지·마스킹됨(구 노드 경로면 PII 미발견 노-op이었을 것)
    expect(typeof result).not.toBe("string");
    const outcome = result as Exclude<typeof result, string | undefined>;

    await outcome.commit();
    const markdown = await reparseMarkdown(filePath);
    expect(markdown).not.toContain("010-1234-5678");
    expect(markdown).toContain("010-****-5678");
  }, 15000);
});
