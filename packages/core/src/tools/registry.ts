/**
 * 툴 레지스트리 — 내장 툴 등록 및 AI SDK v6 툴 포맷 변환
 * docs/SPEC.md §6, §7
 *
 * 두 단계 승인 게이트:
 * - propose 있는 툴: propose() 실행(스테이징+diff) → ApprovalHandler 승인 → commit() 실행
 * - 일반 execute 툴: 승인 없이 직접 실행
 *
 * 불변 원칙: 타겟 파일에 쓰는 코드 경로는 commit() 내부에만 존재하며,
 * approved=true 결과 후에만 호출된다.
 */

import { stat } from "node:fs/promises";
import type { ApprovalHandler, Proposal } from "@kodocagent/shared";
import { detectPii, KodocError, summarizePii } from "@kodocagent/shared";
import type { Schema, ToolSet } from "ai";
import { tool } from "ai";
import type { z } from "zod";

/** 툴 실행 컨텍스트 */
export interface ToolContext {
  cwd: string;
  sessionId: string;
}

/** 툴 실행 옵션 */
export interface ToolExecuteOptions {
  input: unknown;
  signal?: AbortSignal;
  ctx: ToolContext;
}

/** propose 결과: Proposal + commit 함수 */
export interface ProposeOutcome {
  proposal: Proposal;
  /** 백업 + 원자적 쓰기; 한국어 성공 메시지 반환 */
  commit: () => Promise<string>;
}

/** 레지스트리에 등록하는 툴 정의 — execute 또는 propose 중 하나를 가짐 */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  /** zod 스키마 또는 AI SDK jsonSchema() 반환값 모두 허용 */
  inputSchema: z.ZodType<TInput> | Schema<TInput>;
  /** requiresApproval: true ⇔ propose 존재 */
  requiresApproval: boolean;
  /** 일반 툴 실행 함수 (requiresApproval=false인 경우) */
  execute?: (opts: { input: TInput; signal?: AbortSignal; ctx: ToolContext }) => Promise<string>;
  /**
   * 두 단계 승인 게이트용 제안 함수 (requiresApproval=true인 경우).
   * 스테이징과 diff 생성이 여기서 일어난다.
   * string을 반환하면 툴-레벨 오류(승인 불필요).
   */
  propose?: (opts: {
    input: TInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => Promise<ProposeOutcome | string>;
}

/**
 * approval-required 이벤트를 세션에 전달하는 콜백.
 * core는 UI 비종속이므로 콜백을 통해 세션이 이벤트를 발행한다.
 */
export type ApprovalEventEmitter = (proposal: Proposal) => void;

/**
 * 기존 파일을 덮어쓰는 kind 목록.
 * 신규 파일 생성(new-document, new-spreadsheet), 읽기 전용(export), restore는 제외.
 */
const OVERWRITE_KINDS = new Set([
  "edit",
  "cell-edit",
  "find-replace",
  "table-structure",
  "sheet-edit",
  "form-fill",
  "form-object",
  "redact-pii",
]);

/** 열린 파일 경고 문구 */
const OPEN_FILE_WARN =
  "이 문서가 한컴오피스·한글뷰어 등에서 열려 있다면 닫은 뒤 적용하세요. 열린 채로 적용하면 변경 내용이 화면에 바로 보이지 않거나, 프로그램에서 저장할 때 덮어써질 수 있습니다.";

/**
 * 툴 레지스트리 — 툴을 등록하고 AI SDK v6 포맷으로 변환한다.
 *
 * propose 있는 툴:
 *   1. propose() 호출 → ProposeOutcome 획득
 *   2. eventEmitter?.() 호출로 "approval-required" 이벤트 발행
 *   3. approvalHandler() 호출 → 승인/거절
 *   4. 승인 시 commit() 호출 → 성공 메시지 반환
 *   5. 거절 시 "사용자 거절: <reason>" 반환 (staged 파일 유지)
 */
export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition<unknown>> = new Map();
  private approvalHandler?: ApprovalHandler;
  private eventEmitter?: ApprovalEventEmitter;
  private ctx?: ToolContext;

  /** ApprovalHandler 주입 */
  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  /** approval-required 이벤트 발행 콜백 주입 (AgentSession이 설정) */
  setApprovalEventEmitter(emitter: ApprovalEventEmitter): void {
    this.eventEmitter = emitter;
  }

  /** 실행 컨텍스트 주입 */
  setContext(ctx: ToolContext): void {
    this.ctx = ctx;
  }

  /** 툴 등록 — requiresApproval ⇔ propose 정합성을 기계적으로 강제 */
  register<TInput>(def: ToolDefinition<TInput>): void {
    if (def.requiresApproval && !def.propose) {
      throw new Error(
        `툴 정의 오류: '${def.name}'은 requiresApproval=true이지만 propose가 없습니다. ` +
          "승인 툴은 반드시 propose(스테이징)→commit(저장) 2단계로 구현해야 합니다.",
      );
    }
    this.tools.set(def.name, def as ToolDefinition<unknown>);
  }

  /** 등록된 툴 이름 목록 */
  get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * AI SDK v6 ToolSet 포맷으로 변환한다.
   *
   * propose 있는 툴:
   *   propose() → eventEmitter() → approvalHandler() → commit() 또는 거절
   *
   * 일반 execute 툴: 직접 실행
   */
  toAiSdkTools(): ToolSet {
    const result: ToolSet = {};
    for (const [name, def] of this.tools) {
      const getCtx = () => this.ctx;
      const getApprovalHandler = () => this.approvalHandler;
      const getEventEmitter = () => this.eventEmitter;

      result[name] = tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (
          input: unknown,
          options: { abortSignal?: AbortSignal; toolCallId?: string; messages?: unknown[] },
        ) => {
          const ctx = getCtx();
          if (!ctx) {
            return "내부 오류: 툴 컨텍스트가 초기화되지 않았습니다.";
          }

          // 두 단계 승인 게이트: propose 있는 툴
          if (def.requiresApproval && def.propose) {
            const approvalHandler = getApprovalHandler();
            if (!approvalHandler) {
              return "내부 오류: 승인 핸들러가 설정되지 않았습니다.";
            }

            // 1단계: propose() — 스테이징 + diff 생성
            let outcome: ProposeOutcome | string;
            try {
              outcome = await def.propose({
                input: input as Parameters<NonNullable<typeof def.propose>>[0]["input"],
                signal: options.abortSignal,
                ctx,
              });
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return `오류: ${msg}`;
            }

            // propose가 string을 반환 = 툴-레벨 오류
            if (typeof outcome === "string") {
              return outcome;
            }

            const { proposal, commit } = outcome;

            // diff에 PII가 포함된 경우 경고를 proposal.warnings에 추가
            const piiFindings = detectPii(proposal.diff ?? "");
            if (piiFindings.length > 0) {
              proposal.warnings = [
                ...(proposal.warnings ?? []),
                `개인정보 포함: 이번 변경 영역에 ${summarizePii(piiFindings)}이(가) 있습니다. 외부 공유 시 주의하세요.`,
              ];
            }

            // 기존 문서를 덮어쓰는 제안에는 열린 파일 경고를 추가
            if (
              OVERWRITE_KINDS.has(proposal.kind) &&
              !(proposal.warnings ?? []).includes(OPEN_FILE_WARN)
            ) {
              proposal.warnings = [...(proposal.warnings ?? []), OPEN_FILE_WARN];
            }

            // 2단계: approval-required 이벤트 발행 직전 — mtime baseline 캡처
            // per-call 로컬 변수 (모듈 전역 금지 — 동시 호출 레이스 방지)
            let baselineMtimeMs: number | null = null;
            if (proposal.sourcePath) {
              // 도구가 read 시점 mtime을 실어 보냈으면 그것을 우선 사용해
              // propose 내부 read~여기 stat 사이의 lost-update 윈도우를 제거한다.
              if (typeof proposal.sourceMtimeMs === "number") {
                baselineMtimeMs = proposal.sourceMtimeMs;
              } else {
                try {
                  const s = await stat(proposal.sourcePath);
                  baselineMtimeMs = s.mtimeMs;
                } catch {
                  // 파일이 없거나 접근 불가 → null 유지 (검사 스킵)
                }
              }
            }

            // targetPath(출력 경로)를 한 번만 stat 하여 ①·⑪ 두 검사를 함께 처리한다.
            let targetBaselineMtimeMs: number | null = null;
            const hasDistinctTarget =
              proposal.targetPath &&
              proposal.sourcePath &&
              proposal.targetPath !== proposal.sourcePath;
            if (proposal.targetPath) {
              try {
                const ts = await stat(proposal.targetPath);
                // ① 포맷 변환 시 출력 파일의 동시 변경 감지용 베이스라인
                if (hasDistinctTarget) {
                  targetBaselineMtimeMs = ts.mtimeMs;
                }
                // ⑪ 하드링크: nlink > 1이면 rename 후 다른 이름의 파일은 옛 내용을 유지
                const HARDLINK_WARN =
                  "이 파일은 다른 이름과 연결(하드링크)되어 있습니다. " +
                  "저장하면 연결이 끊겨 다른 이름의 파일은 옛 내용을 유지합니다.";
                if (ts.nlink > 1 && !(proposal.warnings ?? []).includes(HARDLINK_WARN)) {
                  proposal.warnings = [...(proposal.warnings ?? []), HARDLINK_WARN];
                }
              } catch {
                // 파일이 없거나 접근 불가 → 베이스라인/경고 생략 (신규 파일 등)
              }
            }

            // approval-required 이벤트 발행 (UI용)
            getEventEmitter()?.(proposal);

            // 3단계: ApprovalHandler 호출
            const approvalResult = await approvalHandler(proposal);
            if (!approvalResult.approved) {
              const reasonPart = approvalResult.reason ? ` (사유: ${approvalResult.reason})` : "";
              return (
                `사용자가 변경을 거절하여 저장하지 않았습니다${reasonPart}. ` +
                "같은 수정안을 자동으로 다시 제안하지 말고, 사용자의 다음 지시를 기다리세요."
              );
            }

            // commit() — 백업 + 원자적 쓰기
            // (mtime 재확인도 이 블록 안에서 수행 — KodocError가 동일한 catch로 노출됨)
            // commit()을 실제로 시도했는지 추적 — 가드 단계(commit 전) 실패엔 백업 안내를 붙이지 않는다.
            let commitAttempted = false;
            try {
              // 4단계: commit() 직전 — mtime 재확인 (lost-update 방지)
              // 이 경로는 commit 전에 중단되므로 파일을 건드리지 않는다(부분쓰기·temp 없음)
              if (baselineMtimeMs !== null && proposal.sourcePath) {
                let currentMtimeMs: number;
                try {
                  const s = await stat(proposal.sourcePath);
                  currentMtimeMs = s.mtimeMs;
                } catch {
                  // 파일 삭제됨 → 저장 중단
                  throw new KodocError(
                    "승인을 기다리는 동안 파일이 변경되어 저장하지 않았습니다.",
                    "read_document로 문서를 다시 읽고 변경을 다시 제안하세요. 다른 프로그램에서 편집 중이면 닫아 주세요.",
                  );
                }
                if (Math.abs(currentMtimeMs - baselineMtimeMs) > 1) {
                  throw new KodocError(
                    "승인을 기다리는 동안 파일이 변경되어 저장하지 않았습니다.",
                    "read_document로 문서를 다시 읽고 변경을 다시 제안하세요. 다른 프로그램에서 편집 중이면 닫아 주세요.",
                  );
                }
              }

              // ① targetPath mtime 재확인 (포맷 변환 시 출력 경로 lost-update 방지)
              if (targetBaselineMtimeMs !== null && hasDistinctTarget) {
                let currentTargetMtimeMs: number;
                try {
                  const s = await stat(proposal.targetPath);
                  currentTargetMtimeMs = s.mtimeMs;
                } catch {
                  // 파일 삭제됨 → 저장 중단
                  throw new KodocError(
                    "출력 파일이 승인을 기다리는 동안 변경되어 저장하지 않았습니다.",
                    "기존 파일을 확인하고 다시 시도하세요.",
                  );
                }
                if (Math.abs(currentTargetMtimeMs - targetBaselineMtimeMs) > 1) {
                  throw new KodocError(
                    "출력 파일이 승인을 기다리는 동안 변경되어 저장하지 않았습니다.",
                    "기존 파일을 확인하고 다시 시도하세요.",
                  );
                }
              }

              commitAttempted = true;
              const commitMsg = await commit();
              // 제안 경고를 결과에 덧붙여 모델이 정직하게 보고하도록 한다
              // (예: find/replace에서 서식 분리로 일부 미치환 시 — "모두 변경" 과장 방지)
              if (proposal.warnings && proposal.warnings.length > 0) {
                return `${commitMsg}\n[경고] ${proposal.warnings.join("\n[경고] ")}`;
              }
              return commitMsg;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              // KodocError는 hint를 포함할 수 있으므로 별도 노출
              const hint = err instanceof KodocError && err.hint ? `\n[해결 방법] ${err.hint}` : "";
              // L6: commit()을 실제로 시도한 뒤 실패한 경우에만 백업 안내(가드 단계 실패는
              // commit 전이라 백업이 생성되지 않았으므로 안내하지 않는다).
              const backupHint = commitAttempted
                ? "\n변경 전 원본이 백업되었을 수 있으니 list_backups로 확인·복원할 수 있습니다."
                : "";
              return `저장 오류: ${msg}${hint}${backupHint}`;
            }
          }

          // 일반 execute 툴 — 승인 필요 툴은 절대 이 경로로 실행되지 않는다
          if (def.execute && !def.requiresApproval) {
            return def.execute({
              input: input as Parameters<NonNullable<typeof def.execute>>[0]["input"],
              signal: options.abortSignal,
              ctx,
            });
          }

          return "내부 오류: 툴에 execute 또는 propose가 없습니다.";
        },
      });
    }
    return result;
  }
}
