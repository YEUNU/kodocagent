import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 홈 디렉터리 — KODOCAGENT_HOME 환경변수로 오버라이드 가능.
 * (테스트 격리 필수: vitest.setup.ts가 임시 디렉터리로 설정해
 *  테스트가 실제 ~/.kodocagent에 쓰는 것을 차단한다)
 */
export const KODOC_HOME = process.env.KODOCAGENT_HOME ?? join(homedir(), ".kodocagent");

export const KODOC_PATHS = {
  home: KODOC_HOME,
  config: join(KODOC_HOME, "config.json"),
  mcpConfig: join(KODOC_HOME, "mcp.json"),
  sessions: join(KODOC_HOME, "sessions"),
  staging: join(KODOC_HOME, "staging"),
  backups: join(KODOC_HOME, "backups"),
  updateCheck: join(KODOC_HOME, "update-check.json"),
} as const;

/** 프로젝트 단위 MCP 설정 (cwd 기준) — 사용자 설정을 서버명 단위로 덮어씀 */
export function projectMcpConfigPath(cwd: string): string {
  return join(cwd, ".kodocagent", "mcp.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 동시 인스턴스 경고 — PID 파일 기반 가벼운 인지 경고
// ─────────────────────────────────────────────────────────────────────────────

/** .lock 파일 경로 */
export const KODOC_LOCK_PATH = join(KODOC_HOME, ".lock");

/**
 * 주어진 pid가 살아있는 프로세스인지 확인한다(process.kill(pid, 0) 기반).
 * 같은 사용자 소유라면 권한 없이도 존재 여부만 확인할 수 있다.
 * 순수 함수(부작용 없음) — 단위 테스트 용이.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 앱 시작 시 호출한다.
 * - 기존 .lock 파일의 pid가 살아있으면 경고 문자열을 반환한다(차단하지 않음).
 * - 죽은 pid 또는 파일 없음 → 현재 pid를 기록하고 null 반환.
 * - 실패는 조용히 무시(기동을 막지 않는다).
 *
 * @returns 다른 인스턴스가 살아있으면 경고 메시지, 아니면 null
 */
export async function acquireInstanceLock(): Promise<string | null> {
  try {
    await mkdir(KODOC_HOME, { recursive: true });
    let existingPid: number | null = null;
    try {
      const raw = await readFile(KODOC_LOCK_PATH, "utf-8");
      const parsed = parseInt(raw.trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        existingPid = parsed;
      }
    } catch {
      // 파일 없음 또는 읽기 실패 → 무시
    }

    if (existingPid !== null && existingPid !== process.pid && isPidAlive(existingPid)) {
      // 살아있는 피어가 락 소유 — 덮어쓰지 않고(피어를 소유자로 유지) 경고만 반환.
      // 락은 KODOC_HOME(설정/백업 데이터) 전역이며, 같은 "문서"를 동시 편집할 때 위험하다.
      return (
        `다른 kodocagent 인스턴스가 실행 중입니다(pid ${existingPid}). ` +
        "같은 문서를 동시에 편집·저장하면 변경이 덮어써질 수 있습니다."
      );
    }

    // 죽은 pid 또는 첫 실행 → 현재 pid 기록(이 인스턴스가 소유)
    await writeFile(KODOC_LOCK_PATH, String(process.pid), "utf-8");
    return null;
  } catch {
    // 실패는 조용히 무시 — 기동을 막지 않는다
    return null;
  }
}

/**
 * 앱 종료 시 자기 pid 파일을 정리한다(선택적).
 * 다른 인스턴스의 파일은 건드리지 않는다.
 */
export async function releaseInstanceLock(): Promise<void> {
  try {
    const raw = await readFile(KODOC_LOCK_PATH, "utf-8");
    const pid = parseInt(raw.trim(), 10);
    if (pid === process.pid) {
      await unlink(KODOC_LOCK_PATH);
    }
  } catch {
    // 파일 없거나 실패 → 무시
  }
}
