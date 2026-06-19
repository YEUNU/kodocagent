import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertFileSizeWithinLimit, resolveSafePath } from "./security.js";

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
    // 플랫폼 독립: cwd 밖에 실제 존재하는 파일을 만들어 검증 (/etc/passwd는 Windows에 없음)
    const outsideDir = join(tmpdir(), `kodocagent-test-outside-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret", "utf-8");
    try {
      await expect(resolveSafePath(testDir, outsideFile)).rejects.toThrow("허용되지 않는 경로");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
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
    // cwd 이하이면 허용 — Windows 8.3 단축 경로(RUNNER~1 등) 대응 위해 realpath 기준 비교
    expect(result).toContain(realTestDir);
  });

  it("cwd 자체 경로는 허용된다", async () => {
    const result = await resolveSafePath(testDir, ".");
    expect(result).toBe(realTestDir);
  });

  // ── Windows 예약 파일명 / 후행 점·공백 가드 (OS 무관 로직) ──────────────
  it("Windows 예약명(NUL, 확장자 없음)은 거절된다", async () => {
    await expect(resolveSafePath(testDir, "NUL")).rejects.toThrow("사용할 수 없는 파일명입니다");
  });

  it("Windows 예약명(소문자 con)은 거절된다", async () => {
    await expect(resolveSafePath(testDir, "con")).rejects.toThrow("사용할 수 없는 파일명입니다");
  });

  it("Windows 예약명(확장자 포함 CON.txt)은 거절된다", async () => {
    await expect(resolveSafePath(testDir, "CON.txt")).rejects.toThrow("사용할 수 없는 파일명");
  });

  it("Windows 예약명(COM1, LPT9)은 거절된다", async () => {
    await expect(resolveSafePath(testDir, "COM1")).rejects.toThrow("사용할 수 없는 파일명");
    await expect(resolveSafePath(testDir, "lpt9.hwpx")).rejects.toThrow("사용할 수 없는 파일명");
  });

  it("후행 점(.)으로 끝나는 파일명은 거절된다", async () => {
    await expect(resolveSafePath(testDir, "report.")).rejects.toThrow("사용할 수 없는 파일명");
  });

  it("후행 공백으로 끝나는 파일명은 거절된다", async () => {
    await expect(resolveSafePath(testDir, "report ")).rejects.toThrow("사용할 수 없는 파일명");
  });

  it("예약명 거절 시 hint에 Windows 안내가 포함된다", async () => {
    const { KodocError } = await import("@kodocagent/shared");
    await expect(resolveSafePath(testDir, "PRN")).rejects.toSatisfy(
      (e) =>
        e instanceof KodocError &&
        typeof (e as InstanceType<typeof KodocError>).hint === "string" &&
        (e as InstanceType<typeof KodocError>).hint?.includes("Windows 예약") === true,
    );
  });

  it("정상 파일명(예약 접두어를 포함하나 예약명이 아닌 경우)은 통과한다", async () => {
    // CONTRACT는 CON으로 시작하지만 예약명이 아니다 → 허용
    const result = await resolveSafePath(testDir, "CONTRACT.hwpx");
    expect(result).toBe(join(realTestDir, "CONTRACT.hwpx"));
  });

  it("정상 파일명(report.hwpx)은 통과한다", async () => {
    const result = await resolveSafePath(testDir, "report.hwpx");
    expect(result).toBe(join(realTestDir, "report.hwpx"));
  });
});

describe("assertFileSizeWithinLimit", () => {
  const tmpBase = join(tmpdir(), `kodocagent-test-filesize-${Date.now()}`);
  let realTmpBase: string;

  beforeEach(async () => {
    await mkdir(tmpBase, { recursive: true });
    realTmpBase = await realpath(tmpBase);
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("파일이 한도 이내이면 통과한다", async () => {
    const file = join(realTmpBase, "small.txt");
    await writeFile(file, "abc", "utf-8"); // 3바이트
    await expect(assertFileSizeWithinLimit(file, 10)).resolves.toBeUndefined();
  });

  it("파일이 정확히 한도와 같으면 통과한다", async () => {
    const file = join(realTmpBase, "exact.txt");
    await writeFile(file, "1234567890", "utf-8"); // 10바이트
    await expect(assertFileSizeWithinLimit(file, 10)).resolves.toBeUndefined();
  });

  it("파일이 한도를 초과하면 KodocError를 던진다", async () => {
    const file = join(realTmpBase, "large.txt");
    await writeFile(file, "12345678901", "utf-8"); // 11바이트 > 10
    await expect(assertFileSizeWithinLimit(file, 10)).rejects.toThrow("파일이 너무 커서");
  });

  it("파일이 없으면 던지지 않고 통과한다(후속 읽기가 친화 메시지로 처리)", async () => {
    const missing = join(realTmpBase, "does-not-exist.txt");
    await expect(assertFileSizeWithinLimit(missing, 10)).resolves.toBeUndefined();
  });

  it("KodocError의 hint에 해결 방법이 포함된다", async () => {
    const file = join(realTmpBase, "large2.txt");
    await writeFile(file, "x".repeat(20), "utf-8");
    const { KodocError } = await import("@kodocagent/shared");
    await expect(assertFileSizeWithinLimit(file, 5)).rejects.toSatisfy(
      (e) =>
        e instanceof KodocError && typeof (e as InstanceType<typeof KodocError>).hint === "string",
    );
  });
});
