/**
 * text-encoding 단위 테스트 + read_document EUC-KR 통합 테스트
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeTextFile } from "./text-encoding.js";
import { readDocumentTool } from "./tools/read-document.js";
import type { ToolContext } from "./types.js";

// ─────────────────────────────────────────────────────────
// decodeTextFile 단위 테스트
// ─────────────────────────────────────────────────────────

describe("decodeTextFile", () => {
  it("UTF-8 문자열 round-trip → encoding utf-8", () => {
    const text = "안녕하세요 Hello 123";
    const buf = Buffer.from(text, "utf-8");
    const result = decodeTextFile(buf);
    expect(result.encoding).toBe("utf-8");
    expect(result.text).toBe(text);
  });

  it("EUC-KR-proper 바이트 '안녕'(0xBE 0xC8 0xB3 0xE7) → text '안녕', encoding cp949", () => {
    // 0xBE 0xC8 = 안, 0xB3 0xE7 = 녕 (EUC-KR/CP949 공통 영역)
    const buf = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]);
    const result = decodeTextFile(buf);
    expect(result.encoding).toBe("cp949");
    expect(result.text).toBe("안녕");
  });

  it("CP949/UHC 확장 음절(EUC-KR-proper 밖)도 깨지지 않고 디코딩된다", () => {
    // '똠방각하'는 UHC 확장 영역 음절 — Node TextDecoder('euc-kr')로는 깨지지만
    // iconv-lite cp949는 정확히 디코딩한다. cp949로 인코딩한 바이트를 round-trip 검증.
    const original = "똠방각하 꿔";
    const cp949Bytes = iconv.encode(original, "cp949");
    // 유효한 UTF-8이 아님을 전제로 폴백 경로를 타야 한다
    const result = decodeTextFile(cp949Bytes);
    expect(result.encoding).toBe("cp949");
    expect(result.text).toBe(original);
  });

  it("UTF-16LE BOM(0xFF 0xFE + 'A\\0') → 'A', encoding utf-16le", () => {
    // BOM + 'A' in UTF-16LE
    const buf = Buffer.from([0xff, 0xfe, 0x41, 0x00]);
    const result = decodeTextFile(buf);
    expect(result.encoding).toBe("utf-16le");
    // TextDecoder utf-16le with BOM strips the BOM
    expect(result.text).toContain("A");
  });

  it("UTF-8 BOM(0xEF 0xBB 0xBF + '가') → '가'(BOM 제거), encoding utf-8", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const text = Buffer.from("가", "utf-8");
    const buf = Buffer.concat([bom, text]);
    const result = decodeTextFile(buf);
    expect(result.encoding).toBe("utf-8");
    // TextDecoder utf-8 with fatal:true strips UTF-8 BOM automatically
    expect(result.text).toBe("가");
  });

  it("순수 ASCII → utf-8", () => {
    const buf = Buffer.from("Hello, World!", "ascii");
    const result = decodeTextFile(buf);
    expect(result.encoding).toBe("utf-8");
    expect(result.text).toBe("Hello, World!");
  });

  it("BOM 없는 UTF-16LE '가나다라' → cp949 모지바케 대신 UTF-16으로 디코딩", () => {
    // BOM 없는 UTF-16은 fatal UTF-8 검증 실패 → 예전엔 무조건 cp949 폴백(모지바케).
    // 이제 NUL 바이트 감지 후 LE/BE/cp949 중 가장 깨끗한 디코딩을 선택한다.
    const s = "가나다라";
    const le = Buffer.from(
      Uint8Array.from([...s].flatMap((c) => [c.codePointAt(0)! & 0xff, c.codePointAt(0)! >> 8])),
    );
    const result = decodeTextFile(le);
    expect(result.encoding).toBe("utf-16le");
    expect(result.text).toBe(s);
  });

  it("BOM 없는 UTF-16BE도 올바르게 디코딩", () => {
    const s = "한글ABC";
    const be = Buffer.from(
      Uint8Array.from([...s].flatMap((c) => [c.codePointAt(0)! >> 8, c.codePointAt(0)! & 0xff])),
    );
    const result = decodeTextFile(be);
    expect(result.encoding).toBe("utf-16be");
    expect(result.text).toBe(s);
  });
});

// ─────────────────────────────────────────────────────────
// read_document EUC-KR .txt 통합 테스트
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-encoding-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

function makeCtx(): ToolContext {
  return {
    cwd: testDir,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

describe("read_document EUC-KR .txt 통합", () => {
  it("EUC-KR .txt 픽스처 → 한글 깨지지 않고 인코딩 메타 표시", async () => {
    const ctx = makeCtx();

    // "안녕하세요" in EUC-KR bytes
    // 안=0xBEC8, 녕=0xB3E7, 하=0xC7CF, 세=0xBCBC, 요=0xBFE4
    const euckrBytes = Buffer.from([
      0xbe,
      0xc8, // 안
      0xb3,
      0xe7, // 녕
      0xc7,
      0xcf, // 하
      0xbc,
      0xbc, // 세
      0xbf,
      0xe4, // 요
    ]);
    const fixturePath = join(testDir, "euckr-test.txt");
    await writeFile(fixturePath, euckrBytes);

    const result = await (readDocumentTool.execute as NonNullable<typeof readDocumentTool.execute>)(
      {
        input: { path: fixturePath },
        ctx,
      },
    );

    expect(typeof result).toBe("string");
    const text = result as string;

    // 한글이 올바르게 디코딩되어야 함
    expect(text).toContain("안녕하세요");
    // 인코딩 메타 표시 확인
    expect(text).toContain("cp949");
    expect(text).toContain("UTF-8로 변환해 표시");
  });
});
