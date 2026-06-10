import { homedir } from "node:os";
import { join } from "node:path";

export const KODOC_HOME = join(homedir(), ".kodocagent");

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
