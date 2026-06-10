import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSafePath } from "./security.js";

const testDir = join(tmpdir(), `kodocagent-test-security-${Date.now()}`);
// macOS에서 /var/folders → /private/var/folders 심링크이므로 realpath로 정규화
let realTestDir: string = testDir;

describe("resolveSafePath", () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    // macOS symlink 해결
    realTestDir = await realpath(testDir);
    // 서브 디렉터리 생성
    await mkdir(join(testDir, "subdir"), { recursive: true });
    await writeFile(join(testDir, "file.txt"), "test", "utf-8");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("cwd 이하 경로는 허용된다", async () => {
    const result = await resolveSafePath(testDir, "file.txt");
    expect(result).toBe(join(realTestDir, "file.txt"));
  });

  it("상대 경로 '../' 이탈은 거절된다", async () => {
    await expect(resolveSafePath(testDir, "../escape.txt")).rejects.toThrow("허용되지 않는 경로");
  });

  it("절대 경로가 cwd 밖이면 거절된다", async () => {
    await expect(resolveSafePath(testDir, "/etc/passwd")).rejects.toThrow("허용되지 않는 경로");
  });

  it("서브 디렉터리 이하 경로는 허용된다", async () => {
    const result = await resolveSafePath(testDir, "subdir/../file.txt");
    expect(result).toBe(join(realTestDir, "file.txt"));
  });

  it("NFD 한국어 경로를 NFC로 정규화하여 처리한다", async () => {
    // NFD 형식 한국어 파일명 (macOS 방식)
    const nfcName = "한글파일.txt";
    const nfdName = nfcName.normalize("NFD");
    await writeFile(join(testDir, nfcName), "내용", "utf-8");

    // NFD 경로를 입력해도 NFC로 정규화되어 처리된다
    // (실제 파일 시스템에 NFD로 저장된 경우 realpath가 NFD로 반환할 수 있으나
    //  security 함수는 NFC 정규화 후 비교하므로 에러가 나지 않아야 함)
    const result = await resolveSafePath(testDir, nfdName);
    // cwd 이하이면 허용
    expect(result).toContain(testDir);
  });

  it("cwd 자체 경로는 허용된다", async () => {
    const result = await resolveSafePath(testDir, ".");
    expect(result).toBe(realTestDir);
  });
});
