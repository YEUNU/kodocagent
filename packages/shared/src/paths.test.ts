/**
 * ③ isPidAlive / acquireInstanceLock 단위 테스트
 */

import { describe, expect, it } from "vitest";
import { isPidAlive } from "./paths.js";

describe("isPidAlive", () => {
  it("현재 프로세스의 pid는 살아있다고 판정한다", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("존재하지 않는 매우 큰 pid는 죽은 것으로 판정한다", () => {
    // pid는 보통 최대 4,194,304(Linux) 또는 99,998(macOS)이므로 이 값은 존재하지 않는다
    // (충돌 가능성 이론상 있으나 실제 테스트 환경에서 무시할 수 있는 수준)
    expect(isPidAlive(99_999_999)).toBe(false);
  });

  it("pid 0은 신호 대상이 아니므로 에러 없이 false 또는 true를 반환한다(플랫폼별 차이 허용)", () => {
    // pid 0에 signal 0을 보내면 동일 프로세스 그룹으로 가서 플랫폼마다 다르게 동작할 수 있다.
    // 값 자체보다 예외가 나지 않는지를 검증한다.
    expect(() => isPidAlive(0)).not.toThrow();
  });
});
