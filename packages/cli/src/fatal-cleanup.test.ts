/**
 * fatal-cleanup.ts 단위 테스트
 * - runEmergencyCleanup: 락 해제·스테이징 정리 호출, 세션 ID 게이팅, 실패 무시(idempotent)
 * - formatFatal: 한국어 요약 + KODOC_DEBUG 스택
 * - setActiveSessionId/getActiveSessionId: 등록·기본값 사용
 *
 * 프로세스 핸들러(installFatalHandlers) 자체는 process.exit를 호출하므로 단위 테스트하지 않고
 * 의존성 주입형 헬퍼만 검증한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatFatal,
  getActiveSessionId,
  runEmergencyCleanup,
  setActiveSessionId,
} from "./fatal-cleanup.js";

afterEach(() => {
  setActiveSessionId(null);
  delete process.env.KODOC_DEBUG;
});

describe("runEmergencyCleanup", () => {
  it("락 해제와 세션 스테이징 정리를 모두 호출한다", async () => {
    const releaseLock = vi.fn(async () => {});
    const cleanStaging = vi.fn(async () => {});
    await runEmergencyCleanup({ releaseLock, cleanStaging, sessionId: "sess-1" });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(cleanStaging).toHaveBeenCalledTimes(1);
    expect(cleanStaging).toHaveBeenCalledWith("sess-1");
  });

  it("세션 ID가 null이면 스테이징 정리는 건너뛰고 락만 해제한다", async () => {
    const releaseLock = vi.fn(async () => {});
    const cleanStaging = vi.fn(async () => {});
    await runEmergencyCleanup({ releaseLock, cleanStaging, sessionId: null });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(cleanStaging).not.toHaveBeenCalled();
  });

  it("락 해제가 throw해도 삼키고 스테이징 정리는 계속한다(idempotent)", async () => {
    const releaseLock = vi.fn(async () => {
      throw new Error("이미 해제됨");
    });
    const cleanStaging = vi.fn(async () => {});
    await expect(
      runEmergencyCleanup({ releaseLock, cleanStaging, sessionId: "sess-2" }),
    ).resolves.toBeUndefined();
    expect(cleanStaging).toHaveBeenCalledWith("sess-2");
  });

  it("스테이징 정리가 throw해도 전체는 거부되지 않는다", async () => {
    const releaseLock = vi.fn(async () => {});
    const cleanStaging = vi.fn(async () => {
      throw new Error("rm 실패");
    });
    await expect(
      runEmergencyCleanup({ releaseLock, cleanStaging, sessionId: "sess-3" }),
    ).resolves.toBeUndefined();
  });

  it("주입 없으면 등록된 활성 세션 ID를 사용한다", async () => {
    setActiveSessionId("registered-sess");
    const cleanStaging = vi.fn(async () => {});
    const releaseLock = vi.fn(async () => {});
    await runEmergencyCleanup({ releaseLock, cleanStaging });
    expect(cleanStaging).toHaveBeenCalledWith("registered-sess");
  });
});

describe("setActiveSessionId / getActiveSessionId", () => {
  it("등록한 세션 ID를 반환하고 null로 해제할 수 있다", () => {
    expect(getActiveSessionId()).toBeNull();
    setActiveSessionId("abc");
    expect(getActiveSessionId()).toBe("abc");
    setActiveSessionId(null);
    expect(getActiveSessionId()).toBeNull();
  });
});

describe("formatFatal", () => {
  it("한국어 요약 메시지를 stderr 쓰기 함수로 출력한다", () => {
    const out: string[] = [];
    formatFatal("예외", new Error("터졌다"), (s) => out.push(s));
    const joined = out.join("");
    expect(joined).toContain("예기치 못한 오류");
    expect(joined).toContain("미처리 예외");
    expect(joined).toContain("터졌다");
  });

  it("KODOC_DEBUG 미설정 시 스택 대신 안내 문구를 출력한다", () => {
    const out: string[] = [];
    formatFatal("거부", new Error("stack-here"), (s) => out.push(s));
    const joined = out.join("");
    expect(joined).toContain("KODOC_DEBUG=1");
    expect(joined).not.toContain("at ");
  });

  it("KODOC_DEBUG 설정 시 원본 스택을 함께 출력한다", () => {
    process.env.KODOC_DEBUG = "1";
    const err = new Error("디버그");
    const out: string[] = [];
    formatFatal("예외", err, (s) => out.push(s));
    const joined = out.join("");
    expect(joined).toContain(err.stack ?? "디버그");
  });

  it("Error가 아닌 값(문자열)도 안전하게 처리한다", () => {
    const out: string[] = [];
    formatFatal("거부", "그냥 문자열 거부", (s) => out.push(s));
    expect(out.join("")).toContain("그냥 문자열 거부");
  });
});
