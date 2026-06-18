/**
 * AgentBridge — core 소비 계층
 *
 * CLI의 chat.ts 패턴을 Electron main process에서 재현한다.
 * IPC를 통해 렌더러에 AgentEvent 스트림을 전달하고,
 * ApprovalHandler를 Promise+Map으로 구현해 렌더러 다이얼로그와 연동한다.
 *
 * 보안 원칙: API 키·키 파일 내용을 렌더러/IPC로 전달 금지 (boolean만).
 */

import { readdir } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { AgentEvent, AgentSessionOptions } from "@kodocagent/core";
import {
  AgentSession,
  createModel,
  loadConfig,
  loadMcpConfig,
  McpManager,
  SessionStore,
  ToolRegistry,
} from "@kodocagent/core";
import {
  createDocTools,
  parse,
  renderHtml,
  resolveSafePath,
  SUPPORTED_READ_EXTENSIONS,
  SUPPORTED_WRITE_EXTENSIONS,
} from "@kodocagent/doc-tools";
import type { KodocConfig, Proposal } from "@kodocagent/shared";
import { resolveApiKey } from "@kodocagent/shared";

/** IPC로 전달 가능한 직렬화된 AgentEvent */
export type SerializedAgentEvent = AgentEvent;

/** config.get() 응답 — 키 값은 절대 포함하지 않음 */
export interface ConfigSnapshot {
  provider: string;
  model: string | null;
  hasKeys: Record<string, boolean>;
}

/** 좌측 파일 패널 항목 (IPC 직렬화) */
export interface FileEntry {
  name: string;
  /** cwd 기준 상대 경로 */
  path: string;
  ext: string;
  kind: "doc" | "sheet" | "other";
  /** v1에서 편집(쓰기) 가능 여부 */
  writable: boolean;
}

/** 문서 미리보기 결과 — renderHtml HTML 또는 오류 */
export type DocPreviewResult =
  | { ok: true; html: string; markdown: string }
  | { ok: false; error: string };

const READ_EXTS: readonly string[] = SUPPORTED_READ_EXTENSIONS;
const WRITE_EXTS: readonly string[] = SUPPORTED_WRITE_EXTENSIONS;

type ApprovalResolver = (result: { approved: boolean; reason?: string }) => void;

/**
 * AgentBridge는 Electron main process에서 1개 인스턴스로 동작한다.
 * - 현재 실행 중인 AgentSession + AbortController를 관리
 * - approval pending map으로 렌더러 다이얼로그와 연동
 * - cwd 변경 시 세션을 재초기화
 */
export class AgentBridge {
  /** 현재 작업 디렉터리 */
  private cwd: string;

  /** 현재 활성 세션 */
  private session: AgentSession | null = null;

  /** 현재 턴 AbortController */
  private controller: AbortController | null = null;

  /** 승인 대기 중인 Proposal resolver 맵 */
  private pendingApprovals = new Map<string, ApprovalResolver>();

  /** MCP 관리자 (before-quit 정리용으로 main/index.ts에서 접근) */
  mcpManager: McpManager | null = null;

  /** 세션 스토어 */
  private store: SessionStore | null = null;

  /** 현재 설정 캐시 */
  private config: KodocConfig | null = null;

  /** 렌더러로 이벤트를 보내는 콜백 (main/index.ts에서 주입) */
  onEvent: ((ev: SerializedAgentEvent) => void) | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * 초기화: config 로드 → MCP 연결 → 세션 스토어 생성
   * cwd 변경 시에도 재호출된다.
   */
  async init(): Promise<void> {
    // 기존 MCP 연결 정리
    if (this.mcpManager) {
      await this.mcpManager.disconnect().catch(() => {});
    }

    this.config = await loadConfig();
    this.mcpManager = new McpManager();

    const { servers, skipped } = loadMcpConfig(this.cwd, this.config);
    for (const s of skipped) {
      this.mcpManager.addSkipped(s.name, s.reason);
    }
    if (servers.length > 0) {
      await this.mcpManager.connect(servers);
    }

    // MCP 실패/스킵 안내를 이벤트로 전달
    for (const s of this.mcpManager.status()) {
      if (s.state === "failed" || s.state === "skipped") {
        const msg = `MCP [${s.name}] ${s.state === "failed" ? "연결 실패" : "스킵"}: ${s.reason ?? ""}`;
        this.emitEvent({ type: "error", message: msg, recoverable: true });
      }
    }

    await this.resetSession();
  }

  /**
   * 새 세션 생성 (session.new() IPC 호출 시)
   */
  async resetSession(): Promise<void> {
    if (!this.config) {
      this.config = await loadConfig();
    }
    this.store = await SessionStore.create({
      cwd: this.cwd,
      provider: this.config.provider,
      model: this.config.model ?? "(기본값)",
      createdAt: new Date().toISOString(),
    });
    this.session = null;
  }

  /**
   * cwd 변경
   */
  async setCwd(newCwd: string): Promise<void> {
    this.cwd = newCwd;
    await this.init();
  }

  getCwd(): string {
    return this.cwd;
  }

  /**
   * 현재 작업 폴더의 지원 문서 목록 (좌측 파일 패널).
   * 읽기 가능한 확장자만, 한국어 정렬.
   */
  async listFiles(): Promise<FileEntry[]> {
    try {
      const entries = await readdir(this.cwd, { withFileTypes: true });
      const out: FileEntry[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = extname(e.name).toLowerCase();
        if (!READ_EXTS.includes(ext)) continue;
        const kind: FileEntry["kind"] =
          ext === ".xlsx" || ext === ".xls"
            ? "sheet"
            : ext === ".md" || ext === ".txt"
              ? "other"
              : "doc";
        // .hwp 는 편집 시 .hwpx 로 변환되므로 쓰기 가능으로 본다
        const writable = WRITE_EXTS.includes(ext) || ext === ".hwp";
        out.push({ name: e.name, path: e.name, ext, kind, writable });
      }
      out.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 문서를 읽어 미리보기 HTML 렌더 (kordoc parse → renderHtml).
   * cwd 상대 경로는 resolveSafePath 경계 검사, 절대 경로(드롭 파일)는 읽기 전용 허용.
   * 원본은 절대 변경하지 않는다.
   */
  async previewDocument(p: string): Promise<DocPreviewResult> {
    try {
      const safePath = isAbsolute(p) ? p : await resolveSafePath(this.cwd, p);
      const result = await parse(safePath);
      if (!result.success || typeof result.markdown !== "string") {
        return { ok: false, error: "문서를 읽을 수 없습니다 (지원하지 않는 형식이거나 손상됨)." };
      }
      return { ok: true, html: renderHtml(result.markdown), markdown: result.markdown };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 사용자 메시지 전송 → AgentSession.run() 실행
   */
  async sendMessage(text: string): Promise<void> {
    if (!this.store || !this.config) {
      this.emitEvent({
        type: "error",
        message: "세션이 초기화되지 않았습니다. 앱을 재시작하세요.",
        recoverable: false,
      });
      return;
    }

    // 설정 최신화
    this.config = await loadConfig();
    let model: ReturnType<typeof createModel>;
    try {
      model = createModel(this.config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent({ type: "error", message: msg, recoverable: false });
      return;
    }

    const tools = new ToolRegistry();
    for (const tool of createDocTools({ cwd: this.cwd })) {
      tools.register(tool as import("@kodocagent/core").ToolDefinition<unknown>);
    }
    if (this.mcpManager) {
      for (const mcpTool of this.mcpManager.getToolDefinitions()) {
        tools.register(mcpTool);
      }
    }

    const approvalHandler = this.makeApprovalHandler();

    const opts: AgentSessionOptions = {
      config: this.config,
      model,
      tools,
      approvalHandler,
      store: this.store,
      cwd: this.cwd,
      mcpServers: this.mcpManager?.connectedServerNames ?? [],
    };

    this.session = new AgentSession(opts);
    await this.session.loadHistory();

    this.controller = new AbortController();

    try {
      for await (const event of this.session.run(text, this.controller.signal)) {
        this.emitEvent(event);
      }
    } catch {
      // AbortSignal에 의한 중단은 정상 처리
    } finally {
      this.controller = null;
    }
  }

  /**
   * 현재 턴 중단
   */
  abort(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * 승인 응답 처리 — 렌더러에서 approval.respond() 호출 시
   */
  respondToApproval(proposalId: string, approved: boolean, reason?: string): void {
    const resolver = this.pendingApprovals.get(proposalId);
    if (!resolver) {
      // 미지의 id는 무시
      console.warn(`[AgentBridge] 알 수 없는 proposalId 무시: ${proposalId}`);
      return;
    }
    this.pendingApprovals.delete(proposalId);
    resolver({ approved, reason });
  }

  /**
   * config.get() — API 키 값은 boolean으로만 전달
   */
  async getConfigSnapshot(): Promise<ConfigSnapshot> {
    const config = await loadConfig();
    const hasKeys: Record<string, boolean> = {};
    for (const provider of ["anthropic", "openai", "google"] as const) {
      hasKeys[provider] = !!resolveApiKey(config, provider);
    }
    return {
      provider: config.provider,
      model: config.model,
      hasKeys,
    };
  }

  /**
   * ApprovalHandler: Promise를 만들고 proposalId로 pending map에 보관.
   * 렌더러에 approval-required 이벤트를 보내고, approval.respond가 resolve할 때까지 대기.
   */
  private makeApprovalHandler() {
    return async (proposal: Proposal): Promise<{ approved: boolean; reason?: string }> => {
      return new Promise((resolve) => {
        this.pendingApprovals.set(proposal.id, resolve);
        // approval-required 이벤트는 AgentSession이 방출하므로
        // 여기서 별도 emit 불필요 — session.run()의 이벤트 스트림으로 전달됨
      });
    };
  }

  private emitEvent(ev: SerializedAgentEvent): void {
    if (this.onEvent) {
      this.onEvent(ev);
    }
  }
}

/**
 * structuredClone 가능성 검증 유틸리티 (테스트용)
 */
export function isStructuredCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}
