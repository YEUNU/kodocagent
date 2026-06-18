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

/** 좌측 파일 패널 항목 */
export interface FileEntry {
  name: string;
  /** cwd 기준 상대 경로 */
  path: string;
  ext: string;
  kind: "doc" | "sheet" | "other";
  /** v1에서 편집(쓰기) 가능 여부 (.hwpx/.docx/.xlsx 등) */
  writable: boolean;
}

/** 문서 미리보기 결과 — renderHtml HTML 또는 오류 */
export type DocPreviewResult =
  | { ok: true; html: string; markdown: string }
  | { ok: false; error: string };

/** 되돌리기 타임라인 항목 */
export interface BackupEntry {
  filename: string;
  /** 원본 파일명 */
  name: string;
  /** 사람이 읽는 시각 "2026-06-16 23:18:42" */
  time: string;
  mtimeMs: number;
  /** 작업 요약 (백업 사이드카에 있으면) */
  summary?: string;
}

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
  files: {
    /** 현재 작업 폴더의 지원 문서 목록 */
    list: () => Promise<FileEntry[]>;
  };
  doc: {
    /** 문서를 읽어 미리보기 HTML 렌더 (cwd 상대 또는 절대 경로) */
    preview: (path: string) => Promise<DocPreviewResult>;
    /** 드롭된 파일의 절대 경로 추출 (sandbox-safe, preload webUtils) */
    pathForFile: (file: File) => string;
  };
  backups: {
    /** 되돌리기 타임라인 */
    list: () => Promise<BackupEntry[]>;
  };
}

declare global {
  interface Window {
    kodoc: KodocApi;
  }
}

export type { Proposal };
