/**
 * update.ts 단위 테스트
 * - compareSemver: 버전 비교 케이스
 * - checkForUpdate: 캐시 읽기/쓰기, 24h 윈도우, 네트워크 실패 시 null
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareSemver } from "./update.js";

// ──────────────────────────────────────────────
// compareSemver
// ──────────────────────────────────────────────

describe("compareSemver", () => {
  it("1.0.0 < 1.0.1", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
  });

  it("1.9.0 < 1.10.0 (숫자 비교)", () => {
    expect(compareSemver("1.9.0", "1.10.0")).toBe(-1);
  });

  it("동일 버전은 0", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("2.0.0 > 1.99.99", () => {
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
  });

  it("0.1.0 < 0.1.1", () => {
    expect(compareSemver("0.1.0", "0.1.1")).toBe(-1);
  });

  it("프리릴리스 접미사는 무시 (1.0.0-alpha < 1.0.1)", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.1")).toBe(-1);
  });

  it("앞에 v 접두사 허용 (v1.0.0 === 1.0.0)", () => {
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
  });
});

// ──────────────────────────────────────────────
// checkForUpdate
// ──────────────────────────────────────────────

describe("checkForUpdate", () => {
  let testDir: string;
  let cachePath: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `kodoc-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    cachePath = join(testDir, "update-check.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("네트워크에서 최신 버전을 받아 새 버전 반환 + 캐시 저장", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.2.0" }),
    } as Response);

    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: mockFetch });

    expect(result).toBe("0.2.0");
    expect(mockFetch).toHaveBeenCalledOnce();

    // 캐시가 저장되었는지 확인
    const raw = await readFile(cachePath, "utf-8");
    const cache = JSON.parse(raw) as { latest: string; checkedAt: string };
    expect(cache.latest).toBe("0.2.0");
    expect(cache.checkedAt).toBeTruthy();
  });

  it("현재 버전이 최신이면 null 반환", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.1.0" }),
    } as Response);

    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: mockFetch });
    expect(result).toBeNull();
  });

  it("24h 이내 캐시가 있으면 네트워크 호출 없이 캐시 사용", async () => {
    // 캐시 직접 작성 (30분 전)
    const recentCache = {
      checkedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      latest: "0.3.0",
    };
    await mkdir(testDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cachePath, JSON.stringify(recentCache), "utf-8");

    const mockFetch = vi.fn();

    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: mockFetch });

    expect(result).toBe("0.3.0");
    expect(mockFetch).not.toHaveBeenCalled(); // 네트워크 요청 없음
  });

  it("24h 초과된 캐시는 무시하고 네트워크 요청", async () => {
    // 25시간 전 캐시
    const oldCache = {
      checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      latest: "0.1.0",
    };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cachePath, JSON.stringify(oldCache), "utf-8");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.2.0" }),
    } as Response);

    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: mockFetch });

    expect(result).toBe("0.2.0");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("네트워크 오류 시 null 반환, 캐시 불변", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: mockFetch });

    expect(result).toBeNull();

    // 캐시 파일이 생성되지 않아야 함
    await expect(readFile(cachePath, "utf-8")).rejects.toThrow();
  });

  it("HTTP 404 시 null 반환, 캐시 불변 (미게시 패키지 시나리오)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    } as Response);

    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: mockFetch });

    expect(result).toBeNull();
    // 캐시 저장 안 됨
    await expect(readFile(cachePath, "utf-8")).rejects.toThrow();
  });

  it("기존 유효 캐시가 있을 때 네트워크 실패해도 캐시 불변", async () => {
    // 유효 캐시 먼저 저장 (1시간 전)
    const validCache = {
      checkedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      latest: "0.2.0",
    };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cachePath, JSON.stringify(validCache), "utf-8");

    const mockFetch = vi.fn(); // 네트워크 호출 없어야 함

    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: mockFetch });
    expect(result).toBe("0.2.0");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
