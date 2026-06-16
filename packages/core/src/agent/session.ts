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
import { buildSystemPrompt } from "./prompts.js";

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

    const system = buildSystemPrompt({
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServers ?? [],
      openDocuments: this.openDocuments,
    });

    const aiSdkTools = tools.toAiSdkTools();

    // streamText 호출 전 토큰 예산 내로 컨텍스트 압축 (in-memory만 적용, 영속화 무관)
    this.messages = compactMessages(this.messages, config.maxContextTokens);

    try {
      const result = streamText({
        model,
        system,
        messages: this.messages,
        tools: aiSdkTools,
        // 멀티스텝 정지 조건: maxSteps번 툴콜 후 중단 (AI SDK v6 실제 API)
        stopWhen: stepCountIs(config.maxSteps),
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
        // 실제 승인/거절은 ApprovalHandler가 동기적으로 처리하므로 이미 완료됨
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
            yield {
              type: "turn-complete",
              usage: usage
                ? {
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                  }
                : undefined,
            };
            break;
          }
          case "error": {
            const errPart = part as { type: "error"; error: unknown };
            const message =
              errPart.error instanceof Error ? errPart.error.message : String(errPart.error);
            yield { type: "error", message, recoverable: false };
            break;
          }
          default:
            // 그 외 이벤트는 무시 (reasoning, source 등)
            break;
        }
      }

      // 스텝 완료 후 어시스턴트 메시지를 영속화
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
    } catch (err: unknown) {
      if (signal.aborted) {
        // AbortSignal에 의한 중단 — 정상 종료
        return;
      }
      if (err instanceof KodocError) {
        yield { type: "error", message: err.message, recoverable: false };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "error", message, recoverable: false };
      }
    }
  }
}
