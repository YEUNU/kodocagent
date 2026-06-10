/**
 * @kodocagent/core — 에이전트 코어
 *
 * 설계: docs/SPEC.md §3(프로바이더), §4(설정), §5(루프/세션), §6(툴 레지스트리), §4(MCP)
 */

export type { AgentEvent } from "./agent/events.js";
export type { SystemPromptContext } from "./agent/prompts.js";
export { buildSystemPrompt } from "./agent/prompts.js";
export type { AgentSessionOptions } from "./agent/session.js";
export { AgentSession } from "./agent/session.js";
export { loadConfig, saveConfig } from "./config/config.js";
export type { LoadMcpConfigResult, McpConfig, ServerConnectionConfig } from "./mcp/config.js";
export { loadMcpConfig } from "./mcp/config.js";
export { McpManager } from "./mcp/manager.js";
export { createModel } from "./providers/registry.js";
export type { SessionMeta, SessionSummary } from "./session/store.js";
export { generateSessionId, latestSession, listSessions, SessionStore } from "./session/store.js";
export type {
  ApprovalEventEmitter,
  ProposeOutcome,
  ToolContext,
  ToolDefinition,
  ToolExecuteOptions,
} from "./tools/registry.js";
export { ToolRegistry } from "./tools/registry.js";
