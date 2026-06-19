/**
 * CLI 최상위 미처리 예외 그물 — best-effort 정리 + 한국어 친절 메시지
 *
 * `unhandledRejection`/`uncaughtException`에서 호출한다.
 * - 인스턴스 락 해제(이미 해제되어도 안전 — releaseInstanceLock은 idempotent).
 * - 현재 활성 세션의 스테이징 정리(세션 ID가 등록되어 있을 때만).
 * - 정리 단계가 throw해도 무시한다(그물의 역할은 "조용히 죽지 않게" 하는 것).
 *
 * 프로세스 핸들러 자체는 단위 테스트가 어려우므로, 정리 로직을 의존성 주입형
 * 순수 헬퍼(runEmergencyCleanup)로 분리해 테스트한다.
 */
import { cleanSessionStaging } from "@kodocagent/doc-tools";
import { releaseInstanceLock } from "@kodocagent/shared";

/** 현재 활성 세션 ID (대화형 세션 진입 시 등록, 정상 종료 시 해제 가능) */
let activeSessionId: string | null = null;

/**
 * 정리 대상이 될 활성 세션 ID를 등록한다.
 * 대화형 세션 store 생성 직후 호출하라.
 */
export function setActiveSessionId(id: string | null): void {
  activeSessionId = id;
}

/** 테스트/내부용 — 현재 등록된 세션 ID를 반환한다. */
export function getActiveSessionId(): string | null {
  return activeSessionId;
}

/** runEmergencyCleanup에 주입 가능한 정리 의존성 (테스트용) */
export interface CleanupDeps {
  releaseLock: () => Promise<void>;
  cleanStaging: (sessionId: string) => Promise<void>;
  sessionId: string | null;
}

/**
 * best-effort 정리를 수행한다. 각 단계는 독립적으로 실패를 무시한다.
 * 모든 정리는 idempotent해야 한다(정상 종료의 finally 정리와 충돌하지 않게).
 *
 * @param deps 주입할 정리 함수·세션 ID (기본값: 실제 락·스테이징 헬퍼 + 등록된 세션)
 */
export async function runEmergencyCleanup(deps?: Partial<CleanupDeps>): Promise<void> {
  const releaseLock = deps?.releaseLock ?? releaseInstanceLock;
  const cleanStaging = deps?.cleanStaging ?? cleanSessionStaging;
  const sessionId = deps?.sessionId !== undefined ? deps.sessionId : activeSessionId;

  // 1) 인스턴스 락 해제 (실패 무시)
  await releaseLock().catch(() => {});

  // 2) 활성 세션 스테이징 정리 (세션이 있을 때만, 실패 무시)
  if (sessionId) {
    await cleanStaging(sessionId).catch(() => {});
  }
}

/**
 * 미처리 예외/거부를 한 줄 한국어 요약으로 stderr에 출력한다.
 * KODOC_DEBUG가 설정돼 있으면 원본 스택도 함께 출력한다.
 *
 * @param kind   "예외"(uncaughtException) 또는 "거부"(unhandledRejection)
 * @param reason 던져진 값
 * @param write  stderr 쓰기 함수 (테스트용 주입; 기본값 process.stderr.write)
 */
export function formatFatal(
  kind: "예외" | "거부",
  reason: unknown,
  write: (s: string) => void = (s) => {
    process.stderr.write(s);
  },
): void {
  const message =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason);
  write(`\n예기치 못한 오류로 종료합니다(미처리 ${kind}): ${message}\n`);
  if (process.env.KODOC_DEBUG) {
    const stack = reason instanceof Error ? (reason.stack ?? message) : String(reason);
    write(`${stack}\n`);
  } else {
    write("자세한 내용을 보려면 KODOC_DEBUG=1 환경변수를 설정해 다시 실행하세요.\n");
  }
}

/**
 * 최상위 미처리 예외 핸들러를 등록한다.
 * 엔트리 초반(인터랙티브 진입 전)에 한 번만 호출하라.
 */
export function installFatalHandlers(): void {
  const onFatal = (kind: "예외" | "거부", reason: unknown): void => {
    formatFatal(kind, reason);
    // best-effort 정리 후 종료. 정리가 매달려도 영원히 안 죽지 않게 즉시 exit로 이어준다.
    void runEmergencyCleanup()
      .catch(() => {})
      .finally(() => process.exit(1));
  };

  process.on("uncaughtException", (err) => onFatal("예외", err));
  process.on("unhandledRejection", (reason) => onFatal("거부", reason));
}
