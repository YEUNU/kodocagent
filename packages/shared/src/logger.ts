/**
 * 구조화 로깅 + KODOC_DEBUG 디버그 모드 (의존성 없음)
 *
 * 불변 원칙:
 * - **모든 출력은 stderr** (process.stderr.write). stdout 은 CLI 가 모델 출력
 *   스트리밍에 쓰므로 절대 사용하지 않는다.
 * - debug 는 KODOC_DEBUG 가 truthy 일 때만 방출한다. info/warn/error 는 항상.
 * - KODOC_DEBUG 설정 시 KODOC_PATHS.logs 디렉터리에 append 로그파일을 남긴다
 *   (best-effort: 실패는 조용히 무시하며, 절대 throw 하지 않는다).
 * - 사용자 대면 메시지·CLI 모델 출력은 로깅이 아니다 — 진단 용도로만 쓴다.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { KODOC_PATHS } from "./paths.js";

/** 로그 레벨 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 구조화 필드 (선택) */
export type LogFields = Record<string, unknown>;

/** KODOC_DEBUG 가 truthy(빈문자열·"0"·"false" 제외)인지 판정 */
function isDebugEnabled(): boolean {
  const v = process.env.KODOC_DEBUG;
  if (!v) return false;
  const lowered = v.trim().toLowerCase();
  return lowered !== "" && lowered !== "0" && lowered !== "false";
}

/**
 * 구조화 필드를 순환참조에 안전하게 JSON 직렬화한다.
 * 직렬화 자체가 실패해도 throw 하지 않고 빈 문자열을 반환한다.
 */
function safeStringify(fields: LogFields): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(fields, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Error) {
        return { name: value.name, message: value.message };
      }
      return value;
    });
    // 빈 객체({})는 부가정보가 없으므로 생략
    return json && json !== "{}" ? json : "";
  } catch {
    return "";
  }
}

/** `[ISO타임스탬프] [LEVEL] 메시지 {fields}` 한 줄을 만든다(개행 포함) */
function formatLine(level: LogLevel, message: string, fields?: LogFields): string {
  const ts = new Date().toISOString();
  const head = `[${ts}] [${level.toUpperCase()}] ${message}`;
  const extra = fields ? safeStringify(fields) : "";
  return extra ? `${head} ${extra}\n` : `${head}\n`;
}

/** 오늘 날짜 기준 로그파일 경로 (KODOC_PATHS.logs/kodoc-YYYY-MM-DD.log) */
function logFilePath(): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(KODOC_PATHS.logs, `kodoc-${day}.log`);
}

/**
 * KODOC_DEBUG 설정 시 로그파일에 append 한다(best-effort).
 * 디렉터리 생성·쓰기 실패는 모두 무시하며 절대 throw 하지 않는다.
 */
function appendToFile(line: string): void {
  try {
    mkdirSync(KODOC_PATHS.logs, { recursive: true });
    appendFileSync(logFilePath(), line, "utf-8");
  } catch {
    // best-effort — 실패는 조용히 무시
  }
}

/** 한 줄을 방출한다: 항상 stderr, KODOC_DEBUG 시 파일에도 append */
function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const line = formatLine(level, message, fields);
  try {
    process.stderr.write(line);
  } catch {
    // stderr 쓰기 실패조차 삼킨다 — 로깅이 앱을 죽이면 안 된다
  }
  if (isDebugEnabled()) {
    appendToFile(line);
  }
}

/**
 * 구조화 로거. 모든 출력은 stderr 로 가며, 진단 용도로만 사용한다.
 * debug 는 KODOC_DEBUG 가 켜졌을 때만, 나머지는 항상 방출한다.
 */
export const logger = {
  /** KODOC_DEBUG 가 truthy 일 때만 방출 */
  debug(message: string, fields?: LogFields): void {
    if (!isDebugEnabled()) return;
    emit("debug", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    emit("info", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    emit("warn", message, fields);
  },
  error(message: string, fields?: LogFields): void {
    emit("error", message, fields);
  },
} as const;
