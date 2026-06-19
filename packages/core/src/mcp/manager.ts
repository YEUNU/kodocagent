/**
 * MCP 클라이언트 매니저
 * docs/SPEC.md §4
 *
 * 연결 관리, 툴 목록 수집, 툴 실행을 담당한다.
 * 불변 원칙: console.* 사용 금지, 한국어 에러 메시지
 */

import { PROVIDER_ENV_VARS } from "@kodocagent/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema } from "ai";
import type { ToolDefinition } from "../tools/registry.js";
import type { ServerConnectionConfig } from "./config.js";

// ── 상태 타입 ────────────────────────────────────────────────────────────────

type ServerState = "connected" | "failed" | "skipped";

interface CachedTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

interface ServerEntry {
  name: string;
  state: ServerState;
  reason?: string;
  toolCount: number;
  client?: Client;
  tools?: CachedTool[];
}

// ── 상수 ────────────────────────────────────────────────────────────────────

/** stdio 기본 타임아웃: npx 최초 다운로드 허용 (60초) */
const STDIO_CONNECT_TIMEOUT_MS = 60_000;
/** HTTP 기본 타임아웃 (15초) */
const HTTP_CONNECT_TIMEOUT_MS = 15_000;
const MAX_MCP_TOOLS_WARN = 40;

/** callTool 실행 타임아웃(30초) — 연결 성공 후 응답이 없으면 에이전트가 영영 멈추는 것을 방지 */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** 결과 텍스트 최대 길이(100,000자) — 초과 시 잘라내고 안내 추가 */
export const MCP_RESULT_MAX_CHARS = 100_000;

/**
 * callTool 결과 텍스트에 길이 상한을 적용한다(M3).
 * 초과 시 앞부분만 남기고 "(결과가 너무 길어 일부만 표시)" 안내를 덧붙인다.
 */
export function truncateMcpResult(text: string, maxChars: number = MCP_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n(결과가 너무 길어 일부만 표시)";
}

// ── 환경변수 필터 ─────────────────────────────────────────────────────────────

/** LLM 제공자 API 키 환경변수 이름 집합 */
const LLM_KEY_NAMES = new Set(Object.values(PROVIDER_ENV_VARS));

/**
 * stdio 자식 프로세스에 전달할 환경변수를 구성한다.
 *
 * process.env에서 LLM 제공자 키(ANTHROPIC_API_KEY 등)를 제거하고,
 * 서버 설정에 명시된 env를 오버레이한다.
 * PATH·HOME 등 일반 환경변수와 LAW_OC는 그대로 보존된다.
 *
 * @param serverEnv  서버 설정에 명시된 env (선택)
 * @returns          자식에 전달할 env 레코드
 */
export function buildChildEnv(serverEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !LLM_KEY_NAMES.has(k)) {
      env[k] = v;
    }
  }
  if (serverEnv) {
    Object.assign(env, serverEnv);
  }
  return env;
}

// ── McpManager 옵션 ──────────────────────────────────────────────────────────

export interface McpManagerOptions {
  /** stdio 서버 연결 타임아웃(ms). 기본값: 60000 */
  stdioConnectTimeoutMs?: number;
  /** HTTP 서버 연결 타임아웃(ms). 기본값: 15000 */
  httpConnectTimeoutMs?: number;
}

// ── McpManager ───────────────────────────────────────────────────────────────

/**
 * MCP 서버 연결·툴 수집·툴 실행을 관리한다.
 *
 * 모든 연결 오류는 격리된다 — connect()는 절대 throw하지 않는다.
 */
export class McpManager {
  private readonly entries = new Map<string, ServerEntry>();
  readonly warnings: string[] = [];
  private readonly stdioConnectTimeoutMs: number;
  private readonly httpConnectTimeoutMs: number;

  constructor(opts: McpManagerOptions = {}) {
    this.stdioConnectTimeoutMs = opts.stdioConnectTimeoutMs ?? STDIO_CONNECT_TIMEOUT_MS;
    this.httpConnectTimeoutMs = opts.httpConnectTimeoutMs ?? HTTP_CONNECT_TIMEOUT_MS;
  }

  /**
   * 주어진 서버 설정 목록으로 모두 연결을 시도한다.
   * 개별 서버 연결 실패는 failed로 기록되고, 전체는 계속 진행된다.
   */
  async connect(configs: ServerConnectionConfig[]): Promise<void> {
    for (const config of configs) {
      await this._connectOne(config);
    }

    // 총 MCP 툴 수 경고
    const totalTools = [...this.entries.values()].reduce((sum, e) => sum + e.toolCount, 0);
    if (totalTools > MAX_MCP_TOOLS_WARN) {
      this.warnings.push(
        `MCP 툴이 ${totalTools}개로 권장 한도(${MAX_MCP_TOOLS_WARN}개)를 초과합니다. ` +
          "불필요한 서버를 비활성화하거나 allowedTools로 제한하세요.",
      );
    }
  }

  private async _connectOne(config: ServerConnectionConfig): Promise<void> {
    const { name } = config;
    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;

    try {
      const client = new Client({ name: "kodocagent", version: "0.1.0" });

      if (config.type === "stdio") {
        // process.env 병합 + 서버별 env 오버라이드.
        // LLM 제공자 키(ANTHROPIC_API_KEY 등)는 자식에 전달하지 않는다 (H3 보안).
        // StdioClientTransport는 env가 주어지면 PATH 등이 사라지므로 명시 병합.
        const mergedEnv = buildChildEnv(config.env);

        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: mergedEnv,
          stderr: "pipe",
        });
      } else {
        // HTTP 타입
        const url = new URL(config.url);
        const opts = config.headers
          ? { requestInit: { headers: config.headers as Record<string, string> } }
          : undefined;
        transport = new StreamableHTTPClientTransport(url, opts);
      }

      // 트랜스포트 타입별 타임아웃으로 연결
      const timeoutMs =
        config.type === "stdio" ? this.stdioConnectTimeoutMs : this.httpConnectTimeoutMs;
      const timeoutSec = Math.round(timeoutMs / 1000);
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `연결 타임아웃 (${timeoutSec}초) — 서버가 응답하지 않습니다. ` +
                    "최초 실행 시 서버 다운로드로 지연될 수 있으니 잠시 후 다시 시도해 보세요.",
                ),
              ),
            timeoutMs,
          ),
        ),
      ]);

      // 툴 목록 조회
      const toolsResult = await client.listTools();
      const allTools = toolsResult.tools as CachedTool[];

      // allowedTools 필터링
      const allowedTools = config.allowedTools ?? null;
      const filteredTools: CachedTool[] =
        allowedTools != null ? allTools.filter((t) => allowedTools.includes(t.name)) : allTools;

      this.entries.set(name, {
        name,
        state: "connected",
        toolCount: filteredTools.length,
        client,
        tools: filteredTools,
      });
    } catch (err: unknown) {
      // 타임아웃/실패 시 스폰된 프로세스·연결이 남지 않도록 transport 정리
      await transport?.close().catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      this.entries.set(name, {
        name,
        state: "failed",
        reason: `연결 실패: ${reason}`,
        toolCount: 0,
      });
    }
  }

  /**
   * 연결된 모든 서버의 툴을 ToolDefinition 형태로 반환한다.
   * 이름 네임스페이스: mcp__<server>__<tool>
   * 설명 접두사: [<server>] <원래 설명>
   */
  getToolDefinitions(): ToolDefinition<unknown>[] {
    const defs: ToolDefinition<unknown>[] = [];

    for (const entry of this.entries.values()) {
      if (entry.state !== "connected" || !entry.client || !entry.tools) continue;

      for (const mcpTool of entry.tools) {
        const toolName = `mcp__${entry.name}__${mcpTool.name}`;
        const description = `[${entry.name}] ${mcpTool.description ?? mcpTool.name}`;

        // AI SDK jsonSchema()로 MCP inputSchema를 FlexibleSchema로 변환
        // 이렇게 하면 모델에 실제 스키마가 전달된다
        const inputSch = jsonSchema<unknown>(
          mcpTool.inputSchema as Parameters<typeof jsonSchema>[0],
        );

        const client = entry.client;
        const mcpToolName = mcpTool.name;
        const entryName = entry.name;

        defs.push({
          name: toolName,
          description,
          inputSchema: inputSch,
          requiresApproval: false,
          execute: async ({ input }) => {
            // M3: 타임아웃 타이머 핸들 — 성공·실패 모두 finally에서 정리(이벤트 루프 유지·
            // 사후 미처리 거부 방지).
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
              // M3: callTool에 실행 타임아웃 적용 — 응답이 없으면 에이전트가 영영 멈추는 것을 방지
              const callPromise = client.callTool({
                name: mcpToolName,
                arguments: input as Record<string, unknown>,
              });
              const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(
                  () => reject(new Error("MCP_CALL_TIMEOUT")),
                  MCP_CALL_TIMEOUT_MS,
                );
              });
              const result = await Promise.race([callPromise, timeoutPromise]);
              // content 배열의 텍스트 파트를 합친다
              if ("content" in result && Array.isArray(result.content)) {
                const textParts = (result.content as Array<{ type: string; text?: string }>)
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "");
                const joined = textParts.join("\n") || JSON.stringify(result.content);
                // M3: 결과 길이 상한 적용
                return truncateMcpResult(joined);
              }
              return truncateMcpResult(JSON.stringify(result));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg === "MCP_CALL_TIMEOUT") {
                return `MCP 툴 응답 시간 초과 [${entryName}/${mcpToolName}]: 서버가 ${MCP_CALL_TIMEOUT_MS / 1000}초 내에 응답하지 않았습니다.`;
              }
              return `MCP 툴 오류 [${entryName}/${mcpToolName}]: ${msg}`;
            } finally {
              if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            }
          },
        });
      }
    }

    return defs;
  }

  /** 연결된 서버 이름 목록 */
  get connectedServerNames(): string[] {
    return [...this.entries.values()].filter((e) => e.state === "connected").map((e) => e.name);
  }

  /** 각 서버의 상태 정보 반환 */
  status(): Array<{ name: string; state: ServerState; toolCount: number; reason?: string }> {
    return [...this.entries.values()].map((e) => ({
      name: e.name,
      state: e.state,
      toolCount: e.toolCount,
      reason: e.reason,
    }));
  }

  /**
   * 스킵된 서버를 상태에 기록한다.
   * loadMcpConfig()에서 이미 스킵된 서버를 UI에 표시하기 위해 사용한다.
   */
  addSkipped(name: string, reason: string): void {
    this.entries.set(name, { name, state: "skipped", reason, toolCount: 0 });
  }

  /** 모든 클라이언트를 정상 종료한다 */
  async disconnect(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.client) {
        closePromises.push(
          entry.client.close().catch(() => {
            // 종료 실패는 무시
          }),
        );
      }
    }
    await Promise.all(closePromises);
  }
}
