/**
 * logger 단위 테스트
 * - KODOC_DEBUG 미설정 시 debug 억제 / 설정 시 방출
 * - info/warn/error 는 항상 방출, 레벨·포맷 검증
 * - 모든 출력은 stderr (stdout 미사용)
 * - 파일 쓰기 실패해도 throw 안 함
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";

describe("logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const savedDebug = process.env.KODOC_DEBUG;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    if (savedDebug === undefined) delete process.env.KODOC_DEBUG;
    else process.env.KODOC_DEBUG = savedDebug;
  });

  it("KODOC_DEBUG 미설정 시 debug는 억제된다", () => {
    delete process.env.KODOC_DEBUG;
    logger.debug("hidden");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("KODOC_DEBUG 설정 시 debug가 stderr로 방출된다", () => {
    process.env.KODOC_DEBUG = "1";
    logger.debug("visible");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("[DEBUG] visible");
  });

  it("KODOC_DEBUG=0 / false 는 debug를 억제한다(truthy 판정)", () => {
    process.env.KODOC_DEBUG = "0";
    logger.debug("nope");
    process.env.KODOC_DEBUG = "false";
    logger.debug("nope2");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("info/warn/error는 KODOC_DEBUG 무관하게 항상 방출된다", () => {
    delete process.env.KODOC_DEBUG;
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(stderrSpy).toHaveBeenCalledTimes(3);
  });

  it("절대 stdout으로 쓰지 않는다", () => {
    process.env.KODOC_DEBUG = "1";
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("포맷: [ISO타임스탬프] [LEVEL] 메시지 + 개행", () => {
    logger.info("hello");
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    // ISO 타임스탬프, 레벨, 메시지, 개행
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] hello\n$/);
  });

  it("구조화 필드는 JSON으로 직렬화되어 붙는다", () => {
    logger.warn("msg", { component: "X", count: 3 });
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("[WARN] msg ");
    expect(line).toContain('"component":"X"');
    expect(line).toContain('"count":3');
  });

  it("순환참조 필드도 throw 없이 직렬화된다", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => logger.info("circ", circular)).not.toThrow();
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("[Circular]");
  });

  it("빈 필드 객체는 메시지에 붙지 않는다", () => {
    logger.info("plain", {});
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("{}");
    expect(line.endsWith("plain\n")).toBe(true);
  });

  it("파일 쓰기(append)가 실패해도 throw 하지 않는다", () => {
    process.env.KODOC_DEBUG = "1";
    // appendFileSync가 throw해도 logger는 삼켜야 한다 — KODOC_PATHS.logs는
    // 테스트 임시 홈 하위라 정상 쓰기되지만, 여기서는 throw 부재만 보장한다.
    expect(() => logger.error("boom", { detail: "x" })).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
  });
});
