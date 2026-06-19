/**
 * AgentSession — AI SDK v6 streamText 기반 에이전트 루프
 * docs/SPEC.md §5
 *
 * 중요: temperature/topP/topK 등 샘플링 파라미터 설정 금지
 * Claude Opus 4.7+/Fable 5는 400 에러를 반환한다.
 */

import type { ApprovalHandler, KodocConfig } from "@kodocagent/shared";
import { KodocError } from "@kodocagent/shared";
import type { LanguageModel, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import type { SessionStore } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { compactMessages } from "./context.js";
import type { AgentEvent } from "./events.js";
import { buildSystemPrompt, buildThrashNudge, SELF_VERIFY_PROMPT } from "./prompts.js";

/**
 * 문서를 실제로 변경하는(승인 후 커밋되는) 편집 도구 집합.
 * 이 도구가 호출된 턴 끝에는 자가 검증 라운드를 1회 강제해 완결성·정확성을 보정한다.
 */
const EDITING_TOOLS = new Set<string>([
  "propose_edit",
  "propose_find_replace",
  "propose_cell_edit",
  "propose_redact_pii",
  "propose_form_fill",
  "propose_table_structure",
  "propose_form_object",
  "propose_sheet_edit",
  "write_new_document",
  "write_new_spreadsheet",
  "restore_backup",
]);

/** 자가 검증 라운드 최대 횟수(무한 루프 방지). 1회면 대부분의 완결성 누락을 잡는다. */
const MAX_SELF_VERIFY_ROUNDS = 1;

/**
 * 같은 편집 도구를 이 횟수 이상 호출하면 thrash로 보고 전략 전환 nudge를 주입한다.
 * nudge는 조언일 뿐 막지 않으므로(오탐도 무해), 정상적인 다중 편집을 방해하지 않는다.
 */
const THRASH_THRESHOLD = 5;

/**
 * 호출된 도구 이름 목록에서 임계치 이상 반복된 편집 도구를 찾는다(가장 많이 호출된 것).
 * thrash 감지용 — 임계치 미만이면 null.
 */
export function findThrashingEditTool(
  toolNames: string[],
  threshold: number = THRASH_THRESHOLD,
): { tool: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    if (EDITING_TOOLS.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let worstTool = "";
  let worstCount = 0;
  for (const [t, c] of counts) {
    if (c > worstCount) {
      worstTool = t;
      worstCount = c;
    }
  }
  return worstCount >= threshold ? { tool: worstTool, count: worstCount } : null;
}

// ─────────────────────────────────────────────────────────
// AI SDK 오류 한국어 매핑 (⑧)
// ─────────────────────────────────────────────────────────

/**
 * AI SDK / 제공자 오류를 상태코드·메시지 패턴으로 분류해 한국어 메시지와 힌트를 반환한다.
 * 매칭되지 않으면 null을 반환해 기존 동작(원문)을 유지한다.
 */
export function mapProviderError(err: unknown): { message: string; hint?: string } | null {
  const status =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  const name = (err as { name?: unknown }).name;
  const message = err instanceof Error ? err.message : String(err);
  const lowerMsg = message.toLowerCase();

  // 인증 오류 (401/403)
  if (status === 401 || status === 403 || name === "AuthenticationError") {
    return {
      message: "API 키가 유효하지 않습니다.",
      hint: "kodocagent config set api-key.<provider> <키> 로 올바른 키를 설정하세요.",
    };
  }

  // 요청 한도 초과 (429)
  if (status === 429 || name === "RateLimitError") {
    return {
      message: "API 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.",
    };
  }

  // 서버 오류 (5xx / overloaded)
  if (
    (typeof status === "number" && status >= 500 && status < 600) ||
    name === "InternalServerError" ||
    lowerMsg.includes("overloaded") ||
    lowerMsg.includes("service unavailable")
  ) {
    return {
      message: "AI 서비스가 일시적으로 불안정합니다.",
      hint: "잠시 후 다시 시도하세요.",
    };
  }

  // 컨텍스트 길이 초과
  if (
    lowerMsg.includes("context_length") ||
    lowerMsg.includes("too many tokens") ||
    lowerMsg.includes("maximum context") ||
    lowerMsg.includes("context window") ||
    lowerMsg.includes("prompt is too long") ||
    name === "ContextLengthExceededError"
  ) {
    return {
      message: "대화가 너무 길어 컨텍스트 한도를 초과했습니다.",
      hint: "새 세션(/new 또는 새 대화)을 시작하세요.",
    };
  }

  // 네트워크 오류
  if (
    lowerMsg.includes("enotfound") ||
    lowerMsg.includes("econnrefused") ||
    lowerMsg.includes("fetch failed") ||
    lowerMsg.includes("network") ||
    name === "NetworkError"
  ) {
    return {
      message: "네트워크 연결을 확인하세요.",
    };
  }

  return null;
}

/**
 * 오류를 사용자용 한국어 메시지로 변환한다(힌트를 메시지에 접어 넣음).
 * AgentEvent.error에 hint 필드가 없으므로 message 한 줄로 합친다.
 * KodocError → message(+hint), AI SDK 오류 → mapProviderError, 그 외 → 원문.
 */
function formatAgentError(err: unknown): string {
  if (err instanceof KodocError) {
    return err.hint ? `${err.message} ${err.hint}` : err.message;
  }
  const mapped = mapProviderError(err);
  if (mapped) return mapped.hint ? `${mapped.message} ${mapped.hint}` : mapped.message;
  return err instanceof Error ? err.message : String(err);
}

export interface AgentSessionOptions {
  config: KodocConfig;
  model: LanguageModel;
  tools: ToolRegistry;
  approvalHandler: ApprovalHandler;
  store: SessionStore;
  cwd: string;
  mcpServers?: string[];
}

/**
 * 에이전트 세션 — 단일 사용자 메시지에 대한 멀티스텝 응답 스트림을 생성한다.
 *
 * run()은 AsyncIterable<AgentEvent>를 반환한다.
 * - text-delta: 텍스트 델타
 * - tool-call: 툴 호출
 * - tool-result: 툴 결과
 * - turn-complete: 턴 완료 (토큰 사용량 포함)
 * - error: 에러 (recoverable 여부 포함)
 */
export class AgentSession {
  private messages: ModelMessage[] = [];
  private readonly openDocuments: string[] = [];

  /** 열람한 문서 경로를 중복 없이 기록한다 (방어적: 비문자열/오류는 무시). */
  private recordOpenDocument(p: unknown): void {
    if (typeof p !== "string" || p.trim() === "") return;
    if (!this.openDocuments.includes(p)) {
      this.openDocuments.push(p);
    }
  }

  /**
   * 저장된 메시지(어시스턴트 tool-call 파트)에서 열람·작성한 문서 경로를 도출해 기록한다.
   * 세션이 턴마다 재생성되므로, 시스템 프롬프트("열람한 문서")가 이전 턴의 열람 기록을
   * 반영하려면 히스토리에서 다시 복원해야 한다.
   */
  private recordOpenDocumentsFromMessage(msg: ModelMessage): void {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; toolName?: string; input?: Record<string, unknown> };
      if (p.type !== "tool-call" || !p.input) continue;
      if (
        p.toolName === "read_document" ||
        p.toolName === "write_new_document" ||
        p.toolName === "write_new_spreadsheet"
      ) {
        this.recordOpenDocument(p.input.path);
      } else if (p.toolName === "compare_documents") {
        this.recordOpenDocument(p.input.pathA);
        this.recordOpenDocument(p.input.pathB);
      }
    }
  }

  /** approval-required 이벤트를 run() 스트림에 전달하기 위한 큐 */
  private pendingApprovalEvents: import("@kodocagent/shared").Proposal[] = [];

  constructor(private readonly opts: AgentSessionOptions) {
    opts.tools.setApprovalHandler(opts.approvalHandler);
    opts.tools.setContext({ cwd: opts.cwd, sessionId: opts.store.id });
    // approval-required 이벤트를 캡처해 run() 스트림으로 전달
    opts.tools.setApprovalEventEmitter((proposal) => {
      this.pendingApprovalEvents.push(proposal);
    });
  }

  /**
   * 이미 저장된 메시지들로 초기화한다 (세션 재개 시 사용).
   */
  async loadHistory(): Promise<void> {
    const msgs = await this.opts.store.loadMessages();
    this.messages.push(...msgs);
    // 이전 턴에서 열람·작성한 문서 경로를 복원 (openDocuments → 시스템 프롬프트)
    for (const msg of msgs) {
      this.recordOpenDocumentsFromMessage(msg);
    }
  }

  /**
   * 사용자 메시지를 처리하고 에이전트 이벤트를 스트리밍한다.
   */
  async *run(userMessage: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const { config, model, tools, store } = this.opts;

    // 사용자 메시지 영속화
    await store.appendUser(userMessage);

    // 메시지 배열에 사용자 메시지 추가
    const userMsg: ModelMessage = { role: "user", content: userMessage };
    this.messages.push(userMsg);

    const aiSdkTools = tools.toAiSdkTools();

    // 자가 검증 루프 — 편집을 수행한 라운드 끝에 검증 라운드를 1회 강제한다.
    // 약한 모델이 일부만 처리하고 조기 종료하는 것을 구조적으로 보정(완결성·정확성).
    // 환경변수 KODOC_SELF_VERIFY=0 으로 비활성화(평가 대조용).
    const selfVerifyEnabled = process.env.KODOC_SELF_VERIFY !== "0";
    let verifyRounds = 0;
    // turn-complete 는 모든 라운드 종료 후 1회만 방출(누적 토큰).
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let sawFinish = false;

    try {
      while (true) {
        // 시스템 프롬프트는 라운드마다 재생성(openDocuments 변동 반영) + 캐시 친화 안정 prefix
        const system = buildSystemPrompt({
          cwd: this.opts.cwd,
          mcpServers: this.opts.mcpServers ?? [],
          openDocuments: this.openDocuments,
          toolNames: tools.toolNames,
        });
        // 토큰 예산 내로 컨텍스트 압축 (in-memory만 적용)
        this.messages = compactMessages(this.messages, config.maxContextTokens);

        let editedThisRound = false;

        const result = streamText({
          model,
          system,
          messages: this.messages,
          tools: aiSdkTools,
          // 멀티스텝 정지 조건: maxSteps번 툴콜 후 중단 (AI SDK v6 실제 API)
          stopWhen: stepCountIs(config.maxSteps),
          // thrash 감지 — 같은 편집 도구를 반복 호출하면 그 스텝 system에 전략 전환 nudge 주입
          prepareStep: ({ steps }) => {
            const names = steps.flatMap((s) => (s.toolCalls ?? []).map((tc) => tc.toolName));
            const thrash = findThrashingEditTool(names);
            if (thrash) {
              return { system: `${system}\n\n${buildThrashNudge(thrash.tool, thrash.count)}` };
            }
            return {};
          },
          abortSignal: signal,
          // 샘플링 파라미터 미설정 (SPEC §3, §5 불변 원칙)
          onError: () => {
            // 오류는 fullStream의 error 파트와 아래 catch에서 이미 깔끔히 처리됨.
            // AI SDK 기본 onError(console.error 원시 덤프)를 비활성화한다.
          },
        });

        // fullStream으로 모든 이벤트를 구독한다
        for await (const part of result.fullStream) {
          if (signal.aborted) break;

          // approval-required 이벤트를 방출 (UI가 렌더링할 수 있도록)
          while (this.pendingApprovalEvents.length > 0) {
            const proposal = this.pendingApprovalEvents.shift()!;
            yield { type: "approval-required", proposal };
          }

          switch (part.type) {
            case "text-delta": {
              yield { type: "text-delta", text: part.text };
              break;
            }
            case "tool-call": {
              yield {
                type: "tool-call",
                toolName: part.toolName,
                args: part.input,
                callId: part.toolCallId,
              };
              if (EDITING_TOOLS.has(part.toolName)) editedThisRound = true;
              // 열람한 문서 경로를 기록한다 (openDocuments → 시스템 프롬프트)
              try {
                const inp = part.input as Record<string, unknown>;
                if (part.toolName === "read_document") {
                  this.recordOpenDocument(inp.path);
                } else if (part.toolName === "compare_documents") {
                  this.recordOpenDocument(inp.pathA);
                  this.recordOpenDocument(inp.pathB);
                } else if (
                  part.toolName === "write_new_document" ||
                  part.toolName === "write_new_spreadsheet"
                ) {
                  this.recordOpenDocument(inp.path);
                }
              } catch {
                // 방어적: 입력 접근 오류는 무시
              }
              break;
            }
            case "tool-result": {
              const isError = false; // tool-result는 성공
              yield {
                type: "tool-result",
                callId: part.toolCallId,
                result: part.output,
                isError,
              };
              await store.appendToolResult(part.toolCallId, part.output, isError);
              break;
            }
            case "tool-error": {
              yield {
                type: "tool-result",
                callId: part.toolCallId,
                result: String(part.error),
                isError: true,
              };
              await store.appendToolResult(part.toolCallId, String(part.error), true);
              break;
            }
            case "finish": {
              const usage = part.totalUsage;
              if (usage) {
                totalInputTokens += usage.inputTokens ?? 0;
                totalOutputTokens += usage.outputTokens ?? 0;
              }
              sawFinish = true;
              break;
            }
            case "error": {
              // 스트리밍 중 발생하는 제공자 오류는 이 파트로 도착한다(⑧ 주 경로).
              // mapProviderError로 한국어화하고 힌트를 메시지에 접어 노출한다.
              const errPart = part as { type: "error"; error: unknown };
              yield {
                type: "error",
                message: formatAgentError(errPart.error),
                recoverable: false,
              };
              break;
            }
            default:
              // 그 외 이벤트는 무시 (reasoning, source 등)
              break;
          }
        }

        // 라운드 완료 후 어시스턴트 메시지를 영속화(+ in-memory 누적)
        try {
          const response = await result.response;
          for (const msg of response.messages) {
            const modelMsg = msg as ModelMessage;
            this.messages.push(modelMsg);
            await store.appendAssistant(modelMsg);
          }
        } catch {
          // 응답 메시지 영속화 실패는 무시 (스트림은 이미 완료)
        }

        // 검증 라운드 트리거: 이번 라운드에 편집 도구 호출이 있었고, 한도 내이며, 중단 안 됨.
        if (
          selfVerifyEnabled &&
          editedThisRound &&
          verifyRounds < MAX_SELF_VERIFY_ROUNDS &&
          !signal.aborted
        ) {
          verifyRounds++;
          const verifyMsg: ModelMessage = { role: "user", content: SELF_VERIFY_PROMPT };
          this.messages.push(verifyMsg);
          await store.appendUser(SELF_VERIFY_PROMPT);
          continue; // 다음 반복 = 검증 라운드
        }
        break;
      }

      // 모든 라운드 종료 — turn-complete 1회 방출(누적 토큰)
      yield {
        type: "turn-complete",
        usage: sawFinish
          ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
          : undefined,
      };
    } catch (err: unknown) {
      if (signal.aborted) {
        // AbortSignal에 의한 중단 — 정상 종료
        return;
      }
      // KodocError·AI SDK 오류 모두 한국어 메시지(+힌트)로 변환 (⑧)
      yield { type: "error", message: formatAgentError(err), recoverable: false };
    }
  }
}
