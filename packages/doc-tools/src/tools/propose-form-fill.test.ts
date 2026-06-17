/**
 * propose_form_fill 테스트
 *
 * OLE2 .hwp 바이너리 가드 — 실제 HWP5 OLE 파일을 흉내낸 바이트로
 * 친절한 안내 메시지가 반환되고 파일이 수정되지 않음을 확인한다.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposeFormFillTool } from "./propose-form-fill.js";

// ─────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-form-fill-test-${Date.now()}`);
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

// ─────────────────────────────────────────────────────────
// OLE2 .hwp 바이너리 가드
// ─────────────────────────────────────────────────────────

describe("proposeFormFillTool — OLE2 .hwp 바이너리 가드", () => {
  it("OLE2 시그니처 바이트(.hwp)가 감지되면 친절한 안내 메시지를 반환하고 파일을 쓰지 않는다", async () => {
    const subDir = join(testDir, `ole2-guard-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // OLE2/CFB 매직 바이트(D0 CF 11 E0 A1 B1 1A E1)로 시작하는 실제 .hwp 바이너리를 모사
    const oleBytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    const hwpPath = join(subDir, "form.hwp");
    await writeFile(hwpPath, oleBytes);

    const ctx = makeCtx(subDir);
    const result = await proposeFormFillTool.propose?.({
      input: {
        path: "form.hwp",
        fields: { 이름: "홍길동" },
        summary: "hwp OLE 양식 채우기 시도",
      },
      ctx,
    });

    // 오류 문자열이 반환되어야 함
    expect(typeof result).toBe("string");
    const msg = result as string;

    // 안내 메시지에 .hwpx 언급 + propose_edit 언급 + 변환 안내 포함
    expect(msg).toContain("hwpx");
    expect(msg).toContain("propose_edit");
    expect(msg).toContain("다른 이름으로 저장");

    // 파일이 수정되지 않았는지 확인 (원본 bytes 그대로)
    const afterBytes = await readFile(hwpPath);
    expect(Buffer.from(afterBytes).equals(oleBytes)).toBe(true);
  }, 10000);
});
