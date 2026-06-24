/**
 * AgentBridge — core 소비 계층
 *
 * CLI의 chat.ts 패턴을 Electron main process에서 재현한다.
 * IPC를 통해 렌더러에 AgentEvent 스트림을 전달하고,
 * ApprovalHandler를 Promise+Map으로 구현해 렌더러 다이얼로그와 연동한다.
 *
 * 보안 원칙: API 키·키 파일 내용을 렌더러/IPC로 전달 금지 (boolean만).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { AgentEvent, AgentSessionOptions, ProviderComparisonResult } from "@kodocagent/core";
import {
  AgentSession,
  compareProviders,
  createModel,
  keyedProviders,
  loadConfig,
  loadMcpConfig,
  McpManager,
  SessionStore,
  saveConfig,
  ToolRegistry,
} from "@kodocagent/core";
import {
  cleanOldBackups,
  createDocTools,
  inlineImagesAsDataUri,
  type ParsedImage,
  parse,
  renderHtml,
  resolveSafePath,
  SUPPORTED_READ_EXTENSIONS,
  SUPPORTED_WRITE_EXTENSIONS,
} from "@kodocagent/doc-tools";
import type { KodocConfig, Proposal, Provider, SetupValues } from "@kodocagent/shared";
import {
  acquireInstanceLock,
  KODOC_PATHS,
  logger,
  PROVIDERS,
  resolveActiveProvider,
  resolveApiKey,
  resolveModel,
  SetupValuesSchema,
} from "@kodocagent/shared";

/** IPC로 전달 가능한 직렬화된 AgentEvent */
export type SerializedAgentEvent = AgentEvent;

/** 멀티 프로바이더 비교 1건 결과 (IPC 직렬화용 — core 타입 재노출) */
export type { ProviderComparisonResult };

/** chat.compare 결과 — 성공이면 results, 실패(키 부족 등)면 error */
export type CompareResponse =
  | { ok: true; results: ProviderComparisonResult[] }
  | { ok: false; error: string };

/** config.get() 응답 — 키 값은 절대 포함하지 않음 */
export interface ConfigSnapshot {
  provider: string;
  model: string | null;
  hasKeys: Record<string, boolean>;
}

// SetupValues 타입과 SetupValuesSchema는 @kodocagent/shared에서 가져온다
export type { SetupValues };

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

/** 되돌리기 타임라인 항목 (IPC 직렬화) */
export interface BackupEntry {
  filename: string;
  /** 원본 파일명 */
  name: string;
  /** 사람이 읽는 시각 "2026-06-16 23:18:42" */
  time: string;
  mtimeMs: number;
  /** 작업 요약 (백업 사이드카에 기록돼 있으면) */
  summary?: string;
}

const BACKUP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/;
function formatBackupTime(tsToken: string): string {
  const restored = tsToken.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z",
  );
  const d = new Date(restored);
  if (Number.isNaN(d.getTime())) return tsToken;
  // 사용자 로컬 시간(Asia/Seoul) 표시 — 정렬용 mtime/tsToken은 그대로 UTC
  return d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

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

  /** 전송 진행 중 플래그 — 첫 await 이전에 동기 설정해 동시 전송 레이스를 차단 */
  private busy = false;

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
    // ⑫ best-effort 비동기 정리 — 실패해도 기동을 막지 않는다
    cleanOldBackups(30).catch(() => {});

    // ③ 동시 인스턴스 경고 — 차단하지 않고 recoverable 이벤트로 1회 알림
    acquireInstanceLock()
      .then((warn) => {
        if (warn) {
          this.emitEvent({ type: "error", message: warn, recoverable: true });
        }
      })
      .catch(() => {});

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
    // 기존 pending approvals 정리
    this.drainPendingApprovals();
    if (!this.config) {
      this.config = await loadConfig();
    }
    const activeProvider = resolveActiveProvider(this.config) ?? this.config.provider;
    this.store = await SessionStore.create({
      cwd: this.cwd,
      provider: activeProvider,
      model: resolveModel(this.config, activeProvider),
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
   * 미리보기는 사용자가 직접 선택/드롭한 파일을 "읽기 전용"으로 렌더하며 결과는 iframe에만
   * 표시된다(에이전트/모델 컨텍스트로 가지 않음). 드래그드롭 파일은 작업 폴더 밖일 수 있으므로
   * 절대 경로는 그대로 허용하고, 상대 경로만 cwd 경계를 검사한다.
   * (에이전트의 실제 편집은 read_document/propose_*가 resolveSafePath로 cwd를 강제한다.)
   * 원본은 절대 변경하지 않는다.
   */
  async previewDocument(p: string): Promise<DocPreviewResult> {
    try {
      const safePath = isAbsolute(p) ? p : await resolveSafePath(this.cwd, p);
      const result = await parse(safePath);
      if (!result.success || typeof result.markdown !== "string") {
        return { ok: false, error: "문서를 읽을 수 없습니다 (지원하지 않는 형식이거나 손상됨)." };
      }
      // 문서에 박힌 그림을 data URI 로 인라인 — 안 하면 <img src="image_001.png"> 가
      // 미리보기 iframe 에서 깨져 alt("image")만 보인다(parse 가 그림 바이트를 result.images 로 추출).
      const images = (result as { images?: ParsedImage[] }).images;
      const html = inlineImagesAsDataUri(renderHtml(result.markdown), images);
      return { ok: true, html, markdown: result.markdown };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 멀티 프로바이더 비교: 같은 질문을 키가 있는 여러 프로바이더에 읽기전용(도구·편집 없음)으로
   * 병렬 전송한다. documentPath 가 주어지면 그 문서 본문(markdown)을 맥락으로 함께 보낸다.
   * 키가 2개 미만이면 비교 의미가 없으므로 error 를 반환한다. 원본은 절대 변경하지 않는다.
   */
  async compareProviders(prompt: string, documentPath?: string): Promise<CompareResponse> {
    if (!this.config) this.config = await loadConfig();
    if (keyedProviders(this.config).length < 2) {
      return {
        ok: false,
        error: "비교하려면 API 키가 2개 이상 필요합니다 (Claude·OpenAI·Gemini 중 둘 이상).",
      };
    }
    let documentText: string | undefined;
    if (documentPath) {
      try {
        const preview = await this.previewDocument(documentPath);
        if (preview.ok) documentText = preview.markdown;
      } catch {
        // 문서 읽기 실패 시 문서 없이 질문만 비교한다.
      }
    }
    const results = await compareProviders(this.config, prompt, { documentText });
    return { ok: true, results };
  }

  /**
   * 되돌리기 타임라인: **현재 작업 폴더(cwd)**의 백업만 (최신순, 최대 20).
   *
   * 백업은 전역 디렉터리(~/.kodocagent/backups)에 쌓이므로, 필터 없이 보여주면 다른 폴더·
   * 과거 작업의 백업까지 전부 노출돼 "아무것도 안 했는데 타임라인이 가득 찬" 노이즈가 된다.
   * 사이드카(.meta.json)의 sourcePath(원본 절대 경로)가 현재 cwd 폴더에 속한 것만 추린다.
   * sourcePath가 없는 구버전 백업은 폴더를 알 수 없으므로 제외(현재 폴더 작업과 무관).
   */
  async listBackups(): Promise<BackupEntry[]> {
    try {
      const dir = KODOC_PATHS.backups;
      const names = await readdir(dir);
      const cwdResolved = resolve(this.cwd);
      const out: BackupEntry[] = [];
      for (const filename of names) {
        const m = filename.match(BACKUP_RE);
        if (!m) continue;
        // 사이드카에서 원본 경로·요약을 읽는다. 현재 폴더 백업이 아니면 일찍 건너뛴다.
        let sourcePath: string | undefined;
        let summary: string | undefined;
        try {
          const parsed: unknown = JSON.parse(
            await readFile(join(dir, `.${filename}.meta.json`), "utf-8"),
          );
          const sp = (parsed as { sourcePath?: unknown } | null)?.sourcePath;
          if (typeof sp === "string") sourcePath = sp;
          const s = (parsed as { summary?: unknown } | null)?.summary;
          if (typeof s === "string") summary = s;
        } catch {
          // 사이드카 없음(구버전 백업) → 폴더를 알 수 없으므로 제외
        }
        if (!sourcePath || resolve(dirname(sourcePath)) !== cwdResolved) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = (await stat(join(dir, filename))).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        out.push({
          filename,
          name: m[2] ?? filename,
          time: formatBackupTime(m[1] ?? ""),
          mtimeMs,
          summary,
        });
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return out.slice(0, 20);
    } catch {
      return [];
    }
  }

  /**
   * 사용자 메시지 전송 → AgentSession.run() 실행
   * 이미 처리 중이면(controller 활성) 새 전송을 무시하고 안내 이벤트를 방출한다.
   */
  async sendMessage(text: string): Promise<void> {
    // 동시 전송 가드 — busy는 첫 await 이전에 동기로 설정되므로(아래) 빠른 연속 전송도 차단된다.
    // (이전엔 controller로 검사했으나 controller가 두 await 뒤에 할당돼 레이스가 있었다.)
    if (this.busy) {
      this.emitEvent({
        type: "error",
        message: "처리 중입니다. 완료 후 다시 입력해 주세요.",
        recoverable: true,
      });
      return;
    }
    this.busy = true;

    try {
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

      const controller = new AbortController();
      this.controller = controller;

      try {
        for await (const event of this.session.run(text, controller.signal)) {
          this.emitEvent(event);
        }
      } catch (err: unknown) {
        // AbortSignal에 의한 중단은 정상 종료. 그 외 예기치 않은 throw 는 반드시 사용자에게
        // 알린다 — 과거엔 조용히 삼켜 turn-complete/error 가 안 와 UI 가 무한 "작업 중"에 갇혔다.
        if (!controller.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          this.emitEvent({
            type: "error",
            message: `예기치 않은 오류로 작업을 끝내지 못했습니다: ${msg}`,
            recoverable: false,
          });
        }
      } finally {
        this.controller = null;
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * 현재 턴 중단
   */
  abort(): void {
    this.controller?.abort();
    this.controller = null;
    this.drainPendingApprovals();
  }

  /**
   * 대기 중인 모든 approval Promise를 "세션 중단"으로 resolve하고 Map을 비운다.
   * abort/resetSession/before-quit 시 호출.
   */
  private drainPendingApprovals(): void {
    for (const resolver of this.pendingApprovals.values()) {
      resolver({ approved: false, reason: "세션 중단" });
    }
    this.pendingApprovals.clear();
  }

  /**
   * 승인 응답 처리 — 렌더러에서 approval.respond() 호출 시
   */
  respondToApproval(proposalId: string, approved: boolean, reason?: string): void {
    const resolver = this.pendingApprovals.get(proposalId);
    if (!resolver) {
      // 미지의 id는 무시
      logger.warn("알 수 없는 proposalId 무시", { component: "AgentBridge", proposalId });
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
    // 실제 사용될 provider(키 있는 것 자동 선택)와 그 기본 모델을 표시한다.
    const active = resolveActiveProvider(config);
    return {
      provider: active ?? config.provider,
      model: active ? resolveModel(config, active) : config.model,
      hasKeys,
    };
  }

  /**
   * 온보딩 마법사: 사용자가 입력한 API 키/프로바이더를 config.json에 저장하고 재초기화한다.
   * 키 값은 저장만 하며 렌더러로 되돌리지 않는다(스냅샷은 boolean만).
   * IPC 입력은 zod 스키마로 런타임 검증 — 알 수 없는 필드 제거, 타입 불일치 거부.
   */
  async saveSetup(rawValues: unknown): Promise<ConfigSnapshot> {
    const parsed = SetupValuesSchema.safeParse(rawValues);
    if (!parsed.success) {
      throw new Error(
        `설정 값이 올바르지 않습니다: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const values = parsed.data;
    const config = await loadConfig();
    if ((PROVIDERS as readonly string[]).includes(values.provider)) {
      config.provider = values.provider as Provider;
    }
    for (const p of PROVIDERS) {
      const k = values.apiKeys[p];
      if (typeof k === "string" && k.trim()) {
        config.apiKeys[p] = k.trim();
      }
    }
    // 선택한 provider 에 키가 없으면 키가 있는 provider 로 자동 보정한다(셋 중 하나면 충분).
    config.provider = resolveActiveProvider(config) ?? config.provider;
    if (typeof values.lawApiKey === "string" && values.lawApiKey.trim()) {
      config.lawApiKey = values.lawApiKey.trim();
    }
    await saveConfig(config);
    this.config = config;
    await this.init();
    return this.getConfigSnapshot();
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
