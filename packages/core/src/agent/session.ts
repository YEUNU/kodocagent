/**
 * AgentSession — AI SDK v6 streamText 기반 에이전트 루프
 * docs/SPEC.md §5
 *
 * 중요: temperature/topP/topK 등 샘플링 파라미터 설정 금지
 * Claude Opus 4.7+/Fable 5는 400 에러를 반환한다.
 */

import type { ApprovalHandler, KodocConfig } from "@kodocagent/shared";
import { KodocError, logger } from "@kodocagent/shared";
import type { LanguageModel, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import type { SessionStore } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { compactMessages } from "./context.js";
import type { AgentEvent } from "./events.js";
import {
  buildSystemPromptParts,
  buildThrashNudge,
  INTAKE_PROMPT,
  SELF_VERIFY_PROMPT,
} from "./prompts.js";

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

  /** approval-required 이벤트를 run() 스트림에 전달하기 위한 큐 (단일 진실 소스) */
  private pendingApprovalEvents: import("@kodocagent/shared").Proposal[] = [];

  /**
   * "승인 이벤트가 큐에 들어왔다"를 run() 루프에 즉시 알리는 신호.
   * run() 루프는 다음 스트림 파트 대기와 이 신호를 race 한다 → 승인 이벤트가 들어오면
   * 다음 파트(tool-result)를 기다리지 않고 깨어나 방출한다. (교착 방지 — 아래 run() 주석 참조)
   */
  private approvalWake: Promise<void> | null = null;
  private approvalWakeResolve: (() => void) | null = null;

  /** 승인 깨우기 신호를 새로 무장한다(매 race 직전 armed 상태 보장). */
  private armApprovalWake(): void {
    this.approvalWake = new Promise<void>((resolve) => {
      this.approvalWakeResolve = resolve;
    });
  }

  constructor(private readonly opts: AgentSessionOptions) {
    opts.tools.setApprovalHandler(opts.approvalHandler);
    opts.tools.setContext({ cwd: opts.cwd, sessionId: opts.store.id });
    // approval-required 이벤트를 캡처해 run() 스트림으로 전달하고, run() 루프를 즉시 깨운다.
    opts.tools.setApprovalEventEmitter((proposal) => {
      this.pendingApprovalEvents.push(proposal);
      this.approvalWakeResolve?.();
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

    // 사용자 메시지 영속화 (원본 그대로 — 인테이크 지시는 히스토리에 저장하지 않는다)
    await store.appendUser(userMessage);

    // 요청 분해 인테이크 — 매 턴, 사용자 메시지에 "수정·작성이면 능력-단위로 분해 후 진행"
    // 지시를 함께 실어 LLM 호출에 보낸다(별도 플래너 호출 없음). 프롬프트 첫 문장이 스스로
    // 게이팅해 단순 질문·읽기 턴에는 분해를 건너뛴다. 첫 턴만이 아니라 수정·작성을 요청하는
    // 모든 턴에서 동작한다(사용자 의도). 약한 모델이 엉뚱한 도구를 쓰거나 산만해지는 것을
    // 구조적으로 보정한다. KODOC_INTAKE=0 으로 비활성(평가 대조).
    const intakeEnabled = process.env.KODOC_INTAKE !== "0";
    const modelContent = intakeEnabled
      ? `${INTAKE_PROMPT}\n\n[사용자 요청]\n${userMessage}`
      : userMessage;

    // 메시지 배열에 사용자 메시지 추가(모델에 보낼 내용)
    const userMsg: ModelMessage = { role: "user", content: modelContent };
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

    try {
      while (true) {
        // 시스템 프롬프트는 라운드마다 재생성(openDocuments 변동 반영) + 캐시 친화 안정 prefix.
        // stable(역할·규칙·능력)과 dynamic(cwd·MCP·열람 문서)을 분리해
        // stable에만 Anthropic prompt caching 브레이크포인트를 붙인다.
        const { stable, dynamic } = buildSystemPromptParts({
          cwd: this.opts.cwd,
          mcpServers: this.opts.mcpServers ?? [],
          openDocuments: this.openDocuments,
          toolNames: tools.toolNames,
        });
        // 안정 system 메시지에만 ephemeral 캐시 마커를 부착한다.
        // Anthropic 렌더 순서는 tools→system→messages이므로, 안정 system 메시지에 마커를 달면
        // tools까지 함께 캐시된다(헤드룸 대안의 비용 절감 핵심). providerOptions.anthropic는
        // openai/google 프로바이더에서 무시되므로 항상 부착해도 안전하다(게이팅 불필요).
        const stableSysMsg: ModelMessage = {
          role: "system",
          content: stable,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        };
        // 동적 system 메시지에는 마커를 붙이지 않는다(라운드마다 바뀌어 캐시 무효화 유발).
        const dynamicSysMsg: ModelMessage = { role: "system", content: dynamic };
        // 토큰 예산 내로 컨텍스트 압축 (in-memory만 적용)
        this.messages = compactMessages(this.messages, config.maxContextTokens);

        let editedThisRound = false;

        const result = streamText({
          model,
          // top-level system 제거 — system 메시지를 messages 앞에 직접 둔다.
          // 합쳐진 system 텍스트(stable + dynamic)와 순서는 기존 buildSystemPrompt와 동일(행동 불변).
          messages: [stableSysMsg, dynamicSysMsg, ...this.messages],
          // messages 배열 내 system 메시지를 명시적으로 허용(미설정 시 SDK가 경고 로그 출력 → stdout 오염).
          allowSystemInMessages: true,
          tools: aiSdkTools,
          // 멀티스텝 정지 조건: maxSteps번 툴콜 후 중단 (AI SDK v6 실제 API)
          stopWhen: stepCountIs(config.maxSteps),
          // thrash 감지 — 같은 편집 도구를 반복 호출하면 그 스텝의 messages를 오버라이드해
          // 동적 system 메시지(dynamicSysMsg)에 전략 전환 nudge를 주입한다.
          // 안정 prefix(stableSysMsg)는 절대 건드리지 않아 캐시가 유지된다.
          prepareStep: ({ steps }) => {
            const names = steps.flatMap((s) => (s.toolCalls ?? []).map((tc) => tc.toolName));
            const thrash = findThrashingEditTool(names);
            if (thrash) {
              const nudgedDynamicSysMsg: ModelMessage = {
                ...dynamicSysMsg,
                content: `${dynamic}\n\n${buildThrashNudge(thrash.tool, thrash.count)}`,
              };
              return { messages: [stableSysMsg, nudgedDynamicSysMsg, ...this.messages] };
            }
            return {};
          },
          abortSignal: signal,
          // 샘플링 파라미터 미설정 (SPEC §3, §5 불변 원칙)
          onError: ({ error }: { error: unknown }) => {
            // 오류는 fullStream의 error 파트와 아래 catch에서 이미 깔끔히 처리됨.
            // AI SDK 기본 onError(console.error 원시 덤프)는 stdout/stderr를 오염시키므로
            // 비활성화하고, 진단이 필요한 경우를 위해 KODOC_DEBUG 시에만 stderr로 남긴다.
            logger.debug("streamText onError", {
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });

        // fullStream을 수동 이터레이터로 소비한다.
        //
        // ⚠️ 교착 주의: 단순 for-await 는 "다음 파트"가 도착해야 루프 본문이 돌아
        // pendingApprovalEvents 를 비울 수 있다. 그런데 승인이 필요한 편집 툴(propose_*)은
        // execute 안에서 propose()(parse/patch/compare 수십~수백 ms) 뒤에 승인 이벤트를
        // 큐에 넣고 approvalHandler 를 await 로 "블록"한다. 다음 파트(tool-result)는 승인이
        // 끝나야 오므로, 승인 이벤트가 큐에 갇혀 영영 방출되지 않는다 → GUI 처럼 승인이
        // 지연되는(다이얼로그→사용자 클릭) 소비자에서 교착(다이얼로그 안 뜸 → 승인 불가 →
        // tool-result 없음 → 무한 "작업 중"). CLI 는 핸들러가 인라인 렌더, 자동승인 테스트는
        // 즉시 resolve 라 둘 다 못 잡던 결함이다.
        // 해결: "다음 파트 대기" 와 "승인 이벤트 도착 신호(approvalWake)" 를 race 해, 승인
        // 이벤트가 들어오면 다음 파트를 기다리지 않고 즉시 방출한다. 큐가 단일 진실 소스이고
        // 매 반복 상단에서 비우므로 신호 누락/스퓨리어스 깨움 모두 무해하다.
        const iterator = result.fullStream[Symbol.asyncIterator]();
        let pendingNext = iterator.next();
        this.armApprovalWake();
        try {
          while (true) {
            if (signal.aborted) break;

            // 큐에 쌓인 approval-required 를 즉시 방출 (다음 스트림 파트를 기다리지 않음)
            while (this.pendingApprovalEvents.length > 0) {
              const proposal = this.pendingApprovalEvents.shift()!;
              yield { type: "approval-required", proposal };
            }

            // 다음 파트 도착 vs 승인 이벤트 도착 신호를 race
            const outcome = await Promise.race([
              pendingNext.then((res) => ({ kind: "part" as const, res })),
              (this.approvalWake ?? Promise.resolve()).then(() => ({ kind: "wake" as const })),
            ]);
            if (outcome.kind === "wake") {
              // 승인 이벤트 도착 — 신호 재무장 후 루프 상단에서 큐를 비운다.
              this.armApprovalWake();
              continue;
            }
            const { value: part, done } = outcome.res;
            if (done) break;
            pendingNext = iterator.next(); // 스트림 전진

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
        } finally {
          // 조기 종료(중단/done) 시 미소비 pendingNext 의 늦은 거부를 흡수(unhandledRejection 방지)
          // + 하위 스트림 정리(중단 시 모델 호출 해제, best-effort).
          pendingNext.catch(() => {});
          void iterator.return?.();
        }

        // 라운드 완료 후 어시스턴트 메시지를 영속화(+ in-memory 누적)
        try {
          const response = await result.response;
          for (const msg of response.messages) {
            const modelMsg = msg as ModelMessage;
            this.messages.push(modelMsg);
            await store.appendAssistant(modelMsg);
          }
        } catch (err: unknown) {
          // 응답 메시지 영속화 실패는 무시 (스트림은 이미 완료) — 진단만 남긴다
          logger.debug("응답 메시지 영속화 실패(무시)", {
            error: err instanceof Error ? err.message : String(err),
          });
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
          // 자동 주입 지시이므로 store에 영속화하지 않는다 — 재개 시 히스토리에 오염 방지.
          // (인테이크 프롬프트와 동일한 패턴 — session.ts ~line 267 참조)
          continue; // 다음 반복 = 검증 라운드
        }
        break;
      }

      // 모든 라운드 종료 — turn-complete 1회 방출(누적 토큰).
      // 스트림 오류로 finish 이벤트를 못 받아도 usage를 항상 정의된 객체로 방출한다.
      // (오류 경로에서도 GUI 토큰 카운터가 undefined를 받지 않도록 0 이상의 값 보장)
      yield {
        type: "turn-complete",
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
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
