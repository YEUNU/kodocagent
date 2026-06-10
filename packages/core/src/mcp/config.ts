/**
 * MCP 설정 로드 + 환경변수 치환
 * docs/SPEC.md §4
 *
 * - 사용자 mcp.json (~/.kodocagent/mcp.json)
 * - 프로젝트 mcp.json (./.kodocagent/mcp.json)  — 서버명 단위로 사용자 설정 덮어씀
 * - 사용자 파일이 없으면 korean-law 기본 번들 사용
 * - ${VAR} → process.env + config.lawApiKey(LAW_OC) 치환
 * - 해석 불가 변수 → 해당 서버 skipped (에러 아님)
 */

import { readFileSync } from "node:fs";
import type { KodocConfig } from "@kodocagent/shared";
import { KODOC_PATHS, LAW_ENV_VAR, projectMcpConfigPath } from "@kodocagent/shared";
import { z } from "zod";

// ── zod 스키마 ──────────────────────────────────────────────────────────────

/** stdio 타입 MCP 서버 설정 */
export const StdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
});
export type StdioServerConfig = z.infer<typeof StdioServerSchema>;

/** HTTP(Streamable HTTP) 타입 MCP 서버 설정 */
export const HttpServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
});
export type HttpServerConfig = z.infer<typeof HttpServerSchema>;

// raw 서버 설정 (파싱 전 검증용 — 타입 구분 없이 객체)
const RawServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
});
type RawServerConfig = z.infer<typeof RawServerSchema>;

export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), RawServerSchema),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

export type ServerConfig = StdioServerConfig | HttpServerConfig;

// ── 기본 번들 ────────────────────────────────────────────────────────────────

const DEFAULT_MCP_CONFIG: McpConfig = {
  mcpServers: {
    "korean-law": {
      command: "npx",
      args: ["-y", "korean-law-mcp@latest"],
      env: { LAW_OC: "${LAW_OC}" },
    },
  },
};

// ── 내부 유틸 ────────────────────────────────────────────────────────────────

function readJsonFile(path: string): unknown {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 레코드 내 모든 문자열 값에 ${VAR} 치환을 적용한다.
 * 치환 실패한 키가 하나라도 있으면 { ok: false, missingVar } 반환.
 */
function substituteRecord(
  record: Record<string, string>,
  env: Record<string, string | undefined>,
): { ok: true; result: Record<string, string> } | { ok: false; missingVar: string } {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    let substituted = v;
    const varMatch = v.match(/\$\{([^}]+)\}/);
    if (varMatch) {
      const varName = varMatch[1] ?? "";
      const resolved = env[varName];
      if (!resolved) {
        return { ok: false, missingVar: varName };
      }
      substituted = v.replace(/\$\{[^}]+\}/, resolved);
    }
    result[k] = substituted;
  }
  return { ok: true, result };
}

// ── 결과 타입 ────────────────────────────────────────────────────────────────

export type ServerConnectionConfig =
  | (StdioServerConfig & { type: "stdio"; name: string })
  | (HttpServerConfig & { type: "http"; name: string });

export interface LoadMcpConfigResult {
  /** 연결 가능한 서버 목록 */
  servers: ServerConnectionConfig[];
  /** 스킵된 서버 목록 (비활성 또는 환경변수 미설정) */
  skipped: Array<{ name: string; reason: string }>;
}

// ── 주요 함수 ────────────────────────────────────────────────────────────────

/**
 * MCP 설정을 로드하고 환경변수를 치환한다.
 *
 * @param cwd 프로젝트 루트 경로 (프로젝트 mcp.json 탐색 기준)
 * @param kodocConfig 앱 설정 (lawApiKey 등)
 * @param paths 테스트용 경로 오버라이드 { userConfig?, projectConfig? }
 */
export function loadMcpConfig(
  cwd: string,
  kodocConfig: KodocConfig,
  paths?: { userConfig?: string; projectConfig?: string },
): LoadMcpConfigResult {
  const userConfigPath = paths?.userConfig ?? KODOC_PATHS.mcpConfig;
  const projectConfigPath = paths?.projectConfig ?? projectMcpConfigPath(cwd);

  // 1. 사용자 설정 파일 읽기
  const userRaw = readJsonFile(userConfigPath);
  const userParsed = userRaw ? McpConfigSchema.safeParse(userRaw) : null;
  const userConfig: McpConfig | null = userParsed?.success === true ? userParsed.data : null;

  // 사용자 파일이 없으면 기본 번들 사용
  const baseConfig: McpConfig = userConfig ?? DEFAULT_MCP_CONFIG;

  // 2. 프로젝트 설정 파일 읽기 (서버명 단위 덮어씀)
  const projectRaw = readJsonFile(projectConfigPath);
  const projectParsed = projectRaw ? McpConfigSchema.safeParse(projectRaw) : null;
  const projectConfig: McpConfig | null =
    projectParsed?.success === true ? projectParsed.data : null;

  const merged: McpConfig = {
    mcpServers: {
      ...baseConfig.mcpServers,
      ...(projectConfig?.mcpServers ?? {}),
    },
  };

  // 3. 환경변수 조합 (process.env + lawApiKey for LAW_OC)
  const envOverlay: Record<string, string | undefined> = {
    ...process.env,
    // config.lawApiKey를 LAW_OC로 주입 (env에 없는 경우에만)
    ...(kodocConfig.lawApiKey && !process.env[LAW_ENV_VAR]
      ? { [LAW_ENV_VAR]: kodocConfig.lawApiKey }
      : {}),
  };

  // 4. 서버별 처리
  const servers: ServerConnectionConfig[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const [name, rawConfig] of Object.entries(merged.mcpServers)) {
    processServer(name, rawConfig, envOverlay, servers, skipped);
  }

  return { servers, skipped };
}

/** 서버 설정 1개를 처리한다 */
function processServer(
  name: string,
  rawConfig: RawServerConfig,
  envOverlay: Record<string, string | undefined>,
  servers: ServerConnectionConfig[],
  skipped: Array<{ name: string; reason: string }>,
): void {
  // disabled 체크
  if (rawConfig.disabled === true) {
    skipped.push({ name, reason: "서버가 비활성화되어 있습니다 (disabled: true)" });
    return;
  }

  // stdio 타입 — command 필드 존재 여부로 구분
  if (rawConfig.command !== undefined) {
    const parsed = StdioServerSchema.safeParse(rawConfig);
    if (!parsed.success) {
      skipped.push({ name, reason: "설정 파싱 오류" });
      return;
    }
    const cfg = parsed.data;

    const resolved = cfg.env
      ? substituteRecord(cfg.env, envOverlay)
      : { ok: true as const, result: {} as Record<string, string> };

    if (!resolved.ok) {
      skipped.push({
        name,
        reason:
          `환경변수 ${resolved.missingVar} 미설정 — ` +
          "https://open.law.go.kr 에서 무료 발급 후 " +
          "'kodocagent config set law-key <키>' 로 등록하세요",
      });
      return;
    }

    servers.push({
      type: "stdio",
      name,
      command: cfg.command,
      args: cfg.args,
      env: Object.keys(resolved.result).length > 0 ? resolved.result : undefined,
      allowedTools: cfg.allowedTools,
    });
    return;
  }

  // HTTP 타입 — url 필드 존재 여부로 구분
  if (rawConfig.url !== undefined) {
    const parsed = HttpServerSchema.safeParse(rawConfig);
    if (!parsed.success) {
      skipped.push({ name, reason: "설정 파싱 오류 (HTTP)" });
      return;
    }
    const cfg = parsed.data;

    const resolvedHeaders = cfg.headers
      ? substituteRecord(cfg.headers, envOverlay)
      : { ok: true as const, result: {} as Record<string, string> };

    if (!resolvedHeaders.ok) {
      skipped.push({
        name,
        reason: `환경변수 ${resolvedHeaders.missingVar} 미설정`,
      });
      return;
    }

    servers.push({
      type: "http",
      name,
      url: cfg.url,
      headers: Object.keys(resolvedHeaders.result).length > 0 ? resolvedHeaders.result : undefined,
      allowedTools: cfg.allowedTools,
    });
    return;
  }

  // command도 url도 없는 경우
  skipped.push({ name, reason: "command 또는 url 필드가 없습니다" });
}
