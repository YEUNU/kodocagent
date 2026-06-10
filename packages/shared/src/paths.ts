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
