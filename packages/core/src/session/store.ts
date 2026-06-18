/**
 * 세션 JSONL 스토어 — ~/.kodocagent/sessions/<id>.jsonl
 * docs/SPEC.md §5
 *
 * 한 줄 = { "v": 1, "ts": "<ISO8601>", "type": "...", "data": {...} }
 */
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { KODOC_PATHS } from "@kodocagent/shared";
import type { ModelMessage } from "ai";

const SESSIONS_DIR = KODOC_PATHS.sessions;

/** 세션 메타 레코드 */
export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  createdAt: string;
}

/** JSONL 레코드 공통 구조 */
interface JournalRecord {
  v: 1;
  ts: string;
  type: "meta" | "user" | "assistant" | "tool-result" | "approval";
  data: unknown;
}

/** 세션 요약 (list() 반환값) */
export interface SessionSummary {
  id: string;
  meta: SessionMeta;
  mtime: Date;
  path: string;
  /** 첫 user 메시지 미리보기 (최대 60자, 개행→공백) */
  preview?: string;
}

/**
 * 시간 정렬 가능한 세션 ID 생성 (ISO 타임스탬프 기반)
 * 형식: <yyyyMMdd>-<HHmmss>-<random6>
 */
export function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${datePart}-${timePart}-${rand}`;
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

function now(): string {
  return new Date().toISOString();
}

function writeLine(record: JournalRecord): string {
  return JSON.stringify(record) + "\n";
}

/**
 * AgentSession — JSONL 기반 세션 저장소
 */
export class SessionStore {
  constructor(
    public readonly id: string,
    public readonly meta: SessionMeta,
  ) {}

  /** 세션 파일 경로 */
  get path(): string {
    return sessionPath(this.id);
  }

  /**
   * 새 세션을 생성하고 meta 레코드를 기록한다.
   */
  static async create(meta: Omit<SessionMeta, "id">): Promise<SessionStore> {
    await ensureSessionsDir();
    const id = generateSessionId();
    const fullMeta: SessionMeta = { ...meta, id };
    const store = new SessionStore(id, fullMeta);
    await store._appendRecord({ type: "meta", data: fullMeta });
    return store;
  }

  /**
   * 기존 세션을 로드한다.
   */
  static async load(id: string): Promise<SessionStore> {
    const path = sessionPath(id);
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) {
      throw new Error(`세션 파일이 비어 있습니다: ${path}`);
    }
    const firstLine = JSON.parse(lines[0]!) as JournalRecord;
    if (firstLine.type !== "meta") {
      throw new Error(`세션 파일 첫 줄이 meta 레코드가 아닙니다: ${path}`);
    }
    const meta = firstLine.data as SessionMeta;
    return new SessionStore(id, meta);
  }

  /**
   * 세션의 모든 메시지를 AI SDK ModelMessage 배열로 재구성한다.
   */
  async loadMessages(): Promise<ModelMessage[]> {
    const content = await readFile(this.path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const messages: ModelMessage[] = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as JournalRecord;
        if (record.type === "user" || record.type === "assistant") {
          messages.push(record.data as ModelMessage);
        }
        // tool-result는 assistant 메시지에 포함되므로 별도 처리하지 않음
      } catch {
        // 절단·손상된 줄 무시 (전원차단·SIGKILL 등) — listSessions와 동일 패턴
      }
    }
    return messages;
  }

  /** 사용자 메시지 기록 */
  async appendUser(content: string): Promise<void> {
    const message: ModelMessage = { role: "user", content };
    await this._appendRecord({ type: "user", data: message });
  }

  /** 어시스턴트 메시지 기록 (툴콜 블록 포함, AI SDK 포맷 그대로) */
  async appendAssistant(message: ModelMessage): Promise<void> {
    await this._appendRecord({ type: "assistant", data: message });
  }

  /** 툴 결과 기록 */
  async appendToolResult(callId: string, result: unknown, isError: boolean): Promise<void> {
    await this._appendRecord({ type: "tool-result", data: { callId, result, isError } });
  }

  /** 승인 결과 기록 */
  async appendApproval(proposalId: string, approved: boolean, reason?: string): Promise<void> {
    await this._appendRecord({ type: "approval", data: { proposalId, approved, reason } });
  }

  private async _appendRecord(partial: Omit<JournalRecord, "v" | "ts">): Promise<void> {
    await ensureSessionsDir();
    const record: JournalRecord = { v: 1, ts: now(), ...partial };
    await appendFile(this.path, writeLine(record), { encoding: "utf-8", mode: 0o600 });
  }
}

/**
 * JSONL 내용에서 첫 user 메시지 텍스트를 추출해 미리보기 문자열(최대 60자)로 반환한다.
 * 레코드가 없거나 파싱 실패 시 undefined를 반환한다.
 */
function extractPreview(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as JournalRecord;
      if (record.type === "user") {
        const data = record.data as { role?: string; content?: unknown };
        let text: string | undefined;
        if (typeof data.content === "string") {
          text = data.content;
        } else if (Array.isArray(data.content)) {
          // content가 배열이면 text 타입 파트에서 첫 번째 텍스트 추출
          for (const part of data.content as Array<{ type?: string; text?: string }>) {
            if (part.type === "text" && typeof part.text === "string") {
              text = part.text;
              break;
            }
          }
        }
        if (text) {
          const normalized = text.replace(/\n/g, " ").trim();
          return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
        }
        return undefined;
      }
    } catch {
      // 파싱 실패 줄 무시
    }
  }
  return undefined;
}

/**
 * 세션 목록을 mtime 역순으로 반환한다.
 */
export async function listSessions(): Promise<SessionSummary[]> {
  await ensureSessionsDir();
  let files: string[];
  try {
    files = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const id = file.slice(0, -6); // remove .jsonl
    const path = sessionPath(id);
    try {
      const info = await stat(path);
      // 파일을 1회만 읽어 meta와 preview 모두 추출
      const content = await readFile(path, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      if (lines.length === 0) continue;
      const firstLine = JSON.parse(lines[0]!) as JournalRecord;
      if (firstLine.type !== "meta") continue;
      const meta = firstLine.data as SessionMeta;
      const preview = extractPreview(content);
      summaries.push({
        id,
        meta,
        mtime: info.mtime,
        path,
        ...(preview !== undefined ? { preview } : {}),
      });
    } catch {
      // 손상된 세션 파일은 무시
    }
  }

  // mtime 역순 (최신 먼저)
  summaries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return summaries;
}

/**
 * 가장 최근 세션을 반환한다.
 */
export async function latestSession(): Promise<SessionSummary | null> {
  const sessions = await listSessions();
  return sessions[0] ?? null;
}
