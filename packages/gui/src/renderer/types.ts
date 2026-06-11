/**
 * 렌더러에서 사용하는 타입 정의
 * preload에서 contextBridge로 노출된 window.kodoc API 타입
 */

import type { AgentEvent } from "@kodocagent/core";
import type { Proposal } from "@kodocagent/shared";

/** IPC로 직렬화된 AgentEvent (structuredClone 가능 타입만) */
export type SerializedAgentEvent = AgentEvent;

/** UI에서 렌더링하는 채팅 메시지 */
export type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; parts: AssistantPart[]; complete: boolean }
  | { id: string; role: "error"; message: string };

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string; argSummary: string; callId: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

/** 툴콜 인자에서 핵심 경로 인자를 추출해 요약 문자열 생성 */
export function formatToolCallSummary(toolName: string, args: unknown): string {
  const MAX_LEN = 50;

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const display = parts.slice(1).join("__");
    return display.length > MAX_LEN ? `${display.slice(0, MAX_LEN)}…` : display;
  }

  let keyArg = "";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const argsObj = args as Record<string, unknown>;
    const pathKeys = ["path", "dir", "pathA", "pathB", "filePath", "target"];
    for (const key of pathKeys) {
      const val = argsObj[key];
      if (typeof val === "string" && val) {
        const short =
          val.includes("/") || val.includes("\\") ? (val.split(/[/\\]/).pop() ?? val) : val;
        keyArg = short;
        break;
      }
    }
    if (!keyArg) {
      for (const val of Object.values(argsObj)) {
        if (typeof val === "string" && val) {
          keyArg = val;
          break;
        }
      }
    }
  }

  const argPart = keyArg ? `(${keyArg})` : "";
  const full = `${toolName}${argPart}`;
  return full.length > MAX_LEN ? `${full.slice(0, MAX_LEN)}…` : full;
}

/** window.kodoc API 타입 (preload와 일치) */
export interface KodocApi {
  chat: {
    send: (text: string) => void;
    onEvent: (cb: (ev: SerializedAgentEvent) => void) => () => void;
    abort: () => void;
  };
  approval: {
    respond: (proposalId: string, approved: boolean, reason?: string) => void;
  };
  config: {
    get: () => Promise<{
      provider: string;
      model: string | null;
      hasKeys: Record<string, boolean>;
    }>;
  };
  session: {
    new: () => void;
  };
  cwd: {
    select: () => Promise<string | null>;
    onChange: (cb: (cwd: string) => void) => () => void;
  };
}

declare global {
  interface Window {
    kodoc: KodocApi;
  }
}

export type { Proposal };
