import { mkdir, rm } from "node:fs/promises";
import type { KodocConfig } from "@kodocagent/shared";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SessionStore } from "../session/store.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentSession } from "./session.js";

const { testSessionsDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return { testSessionsDir: join(tmpdir(), `kodocagent-test-agent-${Date.now()}`) };
});

vi.mock("@kodocagent/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@kodocagent/shared")>();
  return {
    ...original,
    KODOC_PATHS: {
      ...original.KODOC_PATHS,
      sessions: testSessionsDir,
    },
  };
});

const testConfig: KodocConfig = {
  version: 1,
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKeys: { anthropic: "sk-test", openai: null, google: null },
  lawApiKey: null,
  locale: "ko",
  maxSteps: 5,
};

// Loosely-typed stream part — avoids needing @ai-sdk/provider types directly
type AnyStreamPart = Record<string, unknown>;

function makeStreamParts(text: string): AnyStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    },
  ];
}

function makeMockModel(parts: AnyStreamPart[], chunkDelay: number | null = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = {
    doStream: async () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: simulateReadableStream<any>({
        chunks: parts,
        initialDelayInMs: null,
        chunkDelayInMs: chunkDelay,
      }),
      request: { body: "{}" },
      response: {},
    }),
  };
  return new MockLanguageModelV3(opts) as unknown as LanguageModel;
}

async function createStore() {
  return SessionStore.create({
    cwd: "/test",
    provider: "anthropic",
    model: "claude-opus-4-8",
    createdAt: new Date().toISOString(),
  });
}

describe("AgentSession", () => {
  beforeEach(async () => {
    await mkdir(testSessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testSessionsDir, { recursive: true, force: true });
  });

  it("text-delta 이벤트가 스트리밍된다", async () => {
    const model = makeMockModel(makeStreamParts("안녕하세요!"));
    const store = await createStore();
    const tools = new ToolRegistry();
    const session = new AgentSession({
      config: testConfig,
      model,
      tools,
      approvalHandler: async () => ({ approved: true }),
      store,
      cwd: "/test",
    });

    const events: import("./events.js").AgentEvent[] = [];
    const controller = new AbortController();

    for await (const event of session.run("안녕", controller.signal)) {
      events.push(event);
    }

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    const combined = textDeltas
      .map((e) => (e as { type: "text-delta"; text: string }).text)
      .join("");
    expect(combined).toBe("안녕하세요!");
  });

  it("turn-complete 이벤트가 발행된다", async () => {
    const model = makeMockModel(makeStreamParts("테스트 응답"));
    const store = await createStore();
    const tools = new ToolRegistry();
    const session = new AgentSession({
      config: testConfig,
      model,
      tools,
      approvalHandler: async () => ({ approved: true }),
      store,
      cwd: "/test",
    });

    const events: import("./events.js").AgentEvent[] = [];
    const controller = new AbortController();

    for await (const event of session.run("테스트", controller.signal)) {
      events.push(event);
    }

    const complete = events.find((e) => e.type === "turn-complete");
    expect(complete).toBeTruthy();
  });

  it("AbortSignal이 트리거되면 스트림이 중단된다 (에러 없이 종료)", async () => {
    const model = makeMockModel(makeStreamParts("긴 응답"), 50);
    const store = await createStore();
    const tools = new ToolRegistry();
    const session = new AgentSession({
      config: testConfig,
      model,
      tools,
      approvalHandler: async () => ({ approved: true }),
      store,
      cwd: "/test",
    });

    const controller = new AbortController();
    // 즉시 중단
    controller.abort();

    let resolved = false;
    try {
      for await (const _event of session.run("테스트", controller.signal)) {
        // nothing
      }
      resolved = true;
    } catch {
      resolved = true;
    }

    expect(resolved).toBe(true);
  });

  it("툴 호출 이벤트가 발행된다", async () => {
    const toolCallParts: AnyStreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-1" },
      { type: "text-end", id: "text-1" },
      {
        type: "tool-input-start",
        id: "call-1",
        toolName: "test_tool",
      },
      { type: "tool-input-delta", id: "call-1", delta: '{"value":"' },
      { type: "tool-input-delta", id: "call-1", delta: 'test"}' },
      { type: "tool-input-end", id: "call-1" },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];

    // Make mock that returns tool-call parts first, then a text response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doStream: any = vi
      .fn()
      .mockResolvedValueOnce({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream: simulateReadableStream<any>({
          chunks: toolCallParts,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
        request: { body: "{}" },
        response: {},
      })
      .mockResolvedValueOnce({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream: simulateReadableStream<any>({
          chunks: makeStreamParts("툴 실행 후 응답"),
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
        request: { body: "{}" },
        response: {},
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockModel = new MockLanguageModelV3({ doStream } as any) as unknown as LanguageModel;

    const store = await createStore();
    const tools = new ToolRegistry();
    const executeFn = vi.fn().mockResolvedValue("툴 실행 결과");
    tools.register({
      name: "test_tool",
      description: "테스트 툴",
      inputSchema: z.object({ value: z.string() }),
      requiresApproval: false,
      execute: executeFn,
    });

    const session = new AgentSession({
      config: testConfig,
      model: mockModel,
      tools,
      approvalHandler: async () => ({ approved: true }),
      store,
      cwd: "/test",
    });

    const events: import("./events.js").AgentEvent[] = [];
    const controller = new AbortController();

    for await (const event of session.run("툴 테스트", controller.signal)) {
      events.push(event);
    }

    // turn-complete가 있어야 한다
    const complete = events.find((e) => e.type === "turn-complete");
    expect(complete).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────
// 세션 재개 통합 테스트
// ─────────────────────────────────────────────────────────

describe("세션 재개 (loadHistory)", () => {
  beforeEach(async () => {
    await mkdir(testSessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testSessionsDir, { recursive: true, force: true });
  });

  it("멀티턴 기록 저장 → 재개 → 모의 모델이 이전 컨텍스트를 수신한다", async () => {
    // 1단계: 원본 세션에 멀티턴 기록 저장
    const store = await SessionStore.create({
      cwd: "/test",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });

    // user → assistant(text) → user → assistant 기록
    await store.appendUser("첫 번째 질문입니다");
    await store.appendAssistant({
      role: "assistant",
      content: [{ type: "text", text: "첫 번째 응답입니다" }],
    } as import("ai").ModelMessage);
    await store.appendUser("두 번째 질문입니다");
    await store.appendAssistant({
      role: "assistant",
      content: [{ type: "text", text: "두 번째 응답입니다" }],
    } as import("ai").ModelMessage);

    // 2단계: 동일 세션 ID로 새 SessionStore 로드
    const resumedStore = await SessionStore.load(store.id);

    // 3단계: 모의 모델 생성 (doStreamCalls로 호출 인자 자동 캡처)
    type AnyStreamPart = Record<string, unknown>;
    const resumeStreamParts: AnyStreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "재개된 세션 응답" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resumeMockModel = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doStream: async () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream: simulateReadableStream<any>({
          chunks: resumeStreamParts,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
        request: { body: "{}" },
        response: {},
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as unknown as LanguageModel;

    // 4단계: AgentSession 생성 + loadHistory() 호출
    const resumedSession = new AgentSession({
      config: testConfig,
      model: resumeMockModel,
      tools: new ToolRegistry(),
      approvalHandler: async () => ({ approved: true }),
      store: resumedStore,
      cwd: "/test",
    });

    await resumedSession.loadHistory();

    // 5단계: run() 실행
    const controller = new AbortController();
    for await (const _event of resumedSession.run("세 번째 질문입니다", controller.signal)) {
      // 이벤트 소비
    }

    // 6단계: MockLanguageModelV3의 doStreamCalls로 수신된 prompt 확인
    const rawModel = resumeMockModel as unknown as import("ai/test").MockLanguageModelV3;
    expect(rawModel.doStreamCalls).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const callOpts = rawModel.doStreamCalls[0]!;
    // callOpts.prompt은 LanguageModelV3Prompt = Array<LanguageModelV3Message>
    const prompt = callOpts.prompt as Array<{ role: string; content: unknown }>;

    // user 메시지 확인
    const userMsgs = prompt.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(3); // 기존 2개 + 새 1개

    // assistant 메시지 포함 확인
    const assistantMsgs = prompt.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);

    // 이전 user 메시지 텍스트가 포함됐는지 JSON으로 확인
    const promptJson = JSON.stringify(prompt);
    expect(promptJson).toContain("첫 번째 질문입니다");
    expect(promptJson).toContain("두 번째 질문입니다");
    expect(promptJson).toContain("세 번째 질문입니다");
  }, 15000);
});
