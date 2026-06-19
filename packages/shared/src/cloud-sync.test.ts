import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCloudSyncWarning } from "./cloud-sync.js";

describe("detectCloudSyncWarning", () => {
  const base = join(tmpdir(), `kodocagent-test-cloud-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(base, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("macOS CloudStorage 경로는 동기 경고를 반환한다", () => {
    const p = "/Users/me/Library/CloudStorage/OneDrive-Personal/report.hwpx";
    const warn = detectCloudSyncWarning(p);
    expect(warn).toContain("클라우드 동기 폴더");
  });

  it("Dropbox 경로는 동기 경고를 반환한다", () => {
    const p = "/Users/me/Dropbox/문서/report.hwpx";
    expect(detectCloudSyncWarning(p)).toContain("클라우드 동기 폴더");
  });

  it("iCloud Mobile Documents 경로는 동기 경고를 반환한다", () => {
    const p = "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/문서/report.hwpx";
    expect(detectCloudSyncWarning(p)).toContain("클라우드 동기 폴더");
  });

  it("OneDrive / Google Drive 경로는 대소문자 무시하고 경고를 반환한다", () => {
    expect(detectCloudSyncWarning("/Users/me/ONEDRIVE/report.hwpx")).toContain(
      "클라우드 동기 폴더",
    );
    expect(detectCloudSyncWarning("C:\\Users\\me\\Google Drive\\report.hwpx")).toContain(
      "클라우드 동기 폴더",
    );
  });

  it("일반 tmp 경로는 null을 반환한다", () => {
    const p = join(base, "report.hwpx");
    expect(detectCloudSyncWarning(p)).toBeNull();
  });

  it(".icloud 동반 파일이 존재하면 다운로드 안내 경고를 (우선) 반환한다", async () => {
    const target = join(base, "report.hwpx");
    // placeholder 동반 파일: dirname/.{basename}.icloud
    const placeholder = join(base, ".report.hwpx.icloud");
    await writeFile(placeholder, "", "utf-8");
    const warn = detectCloudSyncWarning(target);
    expect(warn).toContain("내려받지 않은 클라우드 placeholder");
  });

  it("절대 throw 하지 않는다(빈 문자열·이상 입력)", () => {
    expect(() => detectCloudSyncWarning("")).not.toThrow();
    expect(detectCloudSyncWarning("")).toBeNull();
  });
});
