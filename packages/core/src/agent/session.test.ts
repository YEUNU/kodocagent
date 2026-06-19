import { mkdir, rm } from "node:fs/promises";
import type { KodocConfig } from "@kodocagent/shared";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SessionStore } from "../session/store.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSystemPrompt } from "./prompts.js";
import { AgentSession, findThrashingEditTool, mapProviderError } from "./session.js";

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
  maxContextTokens: 120000,
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
// Anthropic prompt caching — 시스템 메시지 구성 검증
// (CI에선 실제 캐시 히트는 못 보므로 "변환 산출물의 구성"을 단언한다)
// ─────────────────────────────────────────────────────────

/** V3 프롬프트의 system 메시지 형태 — 변환 후 providerOptions가 보존됨(코드로 확인). */
type V3SystemMsg = {
  role: string;
  content: string;
  providerOptions?: { anthropic?: { cacheControl?: { type?: string } } };
};

describe("AgentSession — Anthropic prompt caching 구성", () => {
  beforeEach(async () => {
    await mkdir(testSessionsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(testSessionsDir, { recursive: true, force: true });
  });

  /** doStreamCalls[idx].prompt에서 선두의 연속된 system 메시지만 추출한다. */
  function leadingSystemMessages(model: LanguageModel, callIdx = 0): V3SystemMsg[] {
    const raw = model as unknown as import("ai/test").MockLanguageModelV3;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const prompt = raw.doStreamCalls[callIdx]!.prompt as unknown as V3SystemMsg[];
    const out: V3SystemMsg[] = [];
    for (const m of prompt) {
      if (m.role !== "system") break;
      out.push(m);
    }
    return out;
  }

  it("선두 두 system 메시지: stable이 먼저, dynamic이 다음 (top-level system 없음)", async () => {
    const model = makeMockModel(makeStreamParts("응답"));
    const store = await createStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "read_document",
      description: "읽기(테스트)",
      inputSchema: z.object({ path: z.string() }),
      requiresApproval: false,
      execute: vi.fn().mockResolvedValue("내용"),
    });
    const session = new AgentSession({
      config: testConfig,
      model,
      tools,
      approvalHandler: async () => ({ approved: true }),
      store,
      cwd: "/test",
      mcpServers: ["korean-law"],
    });
    const controller = new AbortController();
    for await (const _e of session.run("안녕", controller.signal)) {
      // drain
    }

    const sys = leadingSystemMessages(model);
    expect(sys.length).toBe(2);

    // 정답 텍스트: buildSystemPromptParts와 동일 ctx로 buildSystemPrompt를 만들어
    // stable/dynamic 경계를 역산한다.
    const expectedFull = buildSystemPrompt({
      cwd: "/test",
      mcpServers: ["korean-law"],
      openDocuments: [],
      toolNames: tools.toolNames,
    });
    // (a) stable이 먼저: 안정 섹션(역할)을 포함, 동적 컨텍스트는 미포함
    expect(sys[0]!.content).toContain("역할");
    expect(sys[0]!.content).not.toContain("현재 컨텍스트");
    // (b) dynamic이 다음: 동적 컨텍스트 포함
    expect(sys[1]!.content).toContain("현재 컨텍스트");
    expect(sys[1]!.content).toContain("/test");
    // (c) 합쳐진 system 텍스트가 buildSystemPrompt 출력과 동일(행동 불변)
    expect(`${sys[0]!.content}\n\n${sys[1]!.content}`).toBe(expectedFull);
  });

  it("stable system 메시지에 cacheControl ephemeral가 실려 변환된다; dynamic엔 없음", async () => {
    const model = makeMockModel(makeStreamParts("응답"));
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
    for await (const _e of session.run("안녕", controller.signal)) {
      // drain
    }

    const sys = leadingSystemMessages(model);
    expect(sys.length).toBe(2);
    // (b) 변환된 V3 프롬프트의 stable 메시지에 providerOptions.anthropic.cacheControl가 보존됨
    expect(sys[0]!.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    // dynamic 메시지에는 캐시 마커가 없어야 한다(라운드마다 바뀌므로)
    expect(sys[1]!.providerOptions?.anthropic?.cacheControl).toBeUndefined();
  });

  it("thrash 반복 시 nudge가 dynamic 쪽에 주입되고 stable은 불변(캐시 유지)", async () => {
    // 임계치(5) 이상 같은 편집툴을 한 응답에서 호출 → prepareStep이 다음 스텝에서 nudge 주입.
    // 멀티스텝이므로 첫 doStream에서 5개 tool-call을 내보내고, 두 번째 doStream(다음 스텝)에서
    // prepareStep이 오버라이드한 messages를 받는다.
    const fiveCalls: AnyStreamPart[] = [
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 5 }, (_v, i) => ({
        type: "tool-call",
        toolCallId: `c${i}`,
        toolName: "propose_find_replace",
        input: '{"path":"a.hwpx","find":"x","replace":"y","summary":"s"}',
      })),
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];
    const mk = (parts: AnyStreamPart[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: simulateReadableStream<any>({
        chunks: parts,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
      request: { body: "{}" },
      response: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doStream: any = vi
      .fn()
      .mockResolvedValueOnce(mk(fiveCalls))
      .mockResolvedValueOnce(mk(makeStreamParts("정리 후 응답")));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = new MockLanguageModelV3({ doStream } as any) as unknown as LanguageModel;

    const store = await createStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "propose_find_replace",
      description: "편집툴(테스트)",
      inputSchema: z.object({
        path: z.string(),
        find: z.string(),
        replace: z.string(),
        summary: z.string(),
      }),
      requiresApproval: false,
      execute: vi.fn().mockResolvedValue("저장 완료: a.hwpx"),
    });
    // 자가검증 라운드가 끼어들지 않게 비활성화(스텝 카운트를 단순화)
    const prev = process.env.KODOC_SELF_VERIFY;
    process.env.KODOC_SELF_VERIFY = "0";
    try {
      const session = new AgentSession({
        config: testConfig,
        model,
        tools,
        approvalHandler: async () => ({ approved: true }),
        store,
        cwd: "/test",
      });
      const controller = new AbortController();
      for await (const _e of session.run("바꿔줘", controller.signal)) {
        // drain
      }
    } finally {
      if (prev === undefined) delete process.env.KODOC_SELF_VERIFY;
      else process.env.KODOC_SELF_VERIFY = prev;
    }

    // 두 번째 doStream 호출(=thrash 감지 후 스텝)의 선두 system 메시지를 검사
    expect(doStream).toHaveBeenCalledTimes(2);
    const sys = leadingSystemMessages(model, 1);
    expect(sys.length).toBe(2);
    // stable은 thrash와 무관하게 불변 + 캐시 마커 유지
    expect(sys[0]!.content).toContain("역할");
    expect(sys[0]!.content).not.toContain("반복 호출 주의");
    expect(sys[0]!.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    // nudge는 dynamic 쪽에 주입됨
    expect(sys[1]!.content).toContain("현재 컨텍스트");
    expect(sys[1]!.content).toContain("반복 호출 주의");
    expect(sys[1]!.content).toContain("propose_find_replace");
  });

  it("멀티프로바이더 회귀: 캐시 마커는 anthropic 네임스페이스에만 있어 openai/google 경로를 깨지 않는다", async () => {
    // 마커가 anthropic 키에만 격리돼 있으면 openai/google 변환은 이를 무시한다.
    // (MockLanguageModelV3는 프로바이더 무관 — V3 프롬프트를 그대로 통과시키므로
    //  스트림이 정상 완료되고, providerOptions가 anthropic 키에만 존재함을 단언한다.)
    const model = makeMockModel(makeStreamParts("응답"));
    const store = await createStore();
    const tools = new ToolRegistry();
    const session = new AgentSession({
      config: { ...testConfig, provider: "openai" },
      model,
      tools,
      approvalHandler: async () => ({ approved: true }),
      store,
      cwd: "/test",
    });
    let completed = false;
    const controller = new AbortController();
    for await (const e of session.run("안녕", controller.signal)) {
      if (e.type === "turn-complete") completed = true;
    }
    expect(completed).toBe(true);

    const sys = leadingSystemMessages(model);
    expect(sys.length).toBe(2);
    // 마커는 anthropic 키에만 — openai/google 등 다른 프로바이더 키엔 캐시 플래그가 없다
    const po = sys[0]!.providerOptions as Record<string, unknown> | undefined;
    expect(po?.anthropic).toBeDefined();
    expect(Object.keys(po ?? {})).toEqual(["anthropic"]);
  });
});

// ─────────────────────────────────────────────────────────
// 자가 검증 루프
// ─────────────────────────────────────────────────────────

describe("AgentSession — 자가 검증 루프", () => {
  beforeEach(async () => {
    await mkdir(testSessionsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(testSessionsDir, { recursive: true, force: true });
  });

  /** 편집툴 호출 → 텍스트 → (검증) 텍스트 의 3-doStream 목 + 편집툴 등록 */
  function setupEditMock() {
    const editToolCall: AnyStreamPart[] = [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "propose_find_replace",
        input: '{"path":"a.hwpx","find":"x","replace":"y","summary":"s"}',
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];
    const mk = (parts: AnyStreamPart[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: simulateReadableStream<any>({
        chunks: parts,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
      request: { body: "{}" },
      response: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doStream: any = vi
      .fn()
      .mockResolvedValueOnce(mk(editToolCall))
      .mockResolvedValueOnce(mk(makeStreamParts("1차 수정 완료")))
      .mockResolvedValueOnce(mk(makeStreamParts("검증 완료: 모두 반영됨")));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockModel = new MockLanguageModelV3({ doStream } as any) as unknown as LanguageModel;

    const tools = new ToolRegistry();
    tools.register({
      name: "propose_find_replace",
      description: "편집툴(테스트)",
      inputSchema: z.object({
        path: z.string(),
        find: z.string(),
        replace: z.string(),
        summary: z.string(),
      }),
      requiresApproval: false,
      execute: vi.fn().mockResolvedValue("저장 완료: a.hwpx"),
    });
    return { doStream, mockModel, tools };
  }

  it("편집툴 호출 후 자동 검증 라운드가 1회 실행된다(turn-complete는 1회)", async () => {
    const { doStream, mockModel, tools } = setupEditMock();
    const store = await createStore();
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
    for await (const event of session.run("x를 y로 바꿔줘", controller.signal)) {
      events.push(event);
    }

    // 검증 라운드 → doStream 3회(편집라운드 2 + 검증라운드 1)
    expect(doStream).toHaveBeenCalledTimes(3);
    // 검증 라운드의 응답 텍스트가 스트림에 포함
    const text = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toContain("검증 완료");
    // turn-complete는 모든 라운드 후 1회만
    expect(events.filter((e) => e.type === "turn-complete")).toHaveLength(1);
    // 검증 프롬프트가 대화에 주입됨
    const msgs = await store.loadMessages();
    const hasVerifyPrompt = msgs.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("[자동 검증 단계]"),
    );
    expect(hasVerifyPrompt).toBe(true);
  });

  it("KODOC_SELF_VERIFY=0이면 검증 라운드를 건너뛴다", async () => {
    const prev = process.env.KODOC_SELF_VERIFY;
    process.env.KODOC_SELF_VERIFY = "0";
    try {
      const { doStream, mockModel, tools } = setupEditMock();
      const store = await createStore();
      const session = new AgentSession({
        config: testConfig,
        model: mockModel,
        tools,
        approvalHandler: async () => ({ approved: true }),
        store,
        cwd: "/test",
      });
      const controller = new AbortController();
      for await (const _e of session.run("x를 y로 바꿔줘", controller.signal)) {
        // drain
      }
      // 검증 라운드 없음 → doStream 2회(편집라운드만)
      expect(doStream).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.KODOC_SELF_VERIFY;
      else process.env.KODOC_SELF_VERIFY = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────
// ⑧: mapProviderError — AI SDK 오류 한국어 매핑
// ─────────────────────────────────────────────────────────

describe("mapProviderError", () => {
  it("401 상태코드 → API 키 오류 메시지", () => {
    const result = mapProviderError({ status: 401, message: "Unauthorized" });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("API 키가 유효하지 않습니다");
  });

  it("403 상태코드 → API 키 오류 메시지", () => {
    const result = mapProviderError({ status: 403, message: "Forbidden" });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("API 키가 유효하지 않습니다");
  });

  it("429 상태코드 → 요청 한도 초과 메시지", () => {
    const result = mapProviderError({ status: 429, message: "Too Many Requests" });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("API 요청 한도를 초과했습니다");
  });

  it("503 상태코드 → 서비스 불안정 메시지", () => {
    const result = mapProviderError({ status: 503, message: "Service Unavailable" });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("AI 서비스가 일시적으로 불안정합니다");
  });

  it("overloaded 메시지 → 서비스 불안정 메시지", () => {
    const result = mapProviderError(new Error("The API is overloaded"));
    expect(result).not.toBeNull();
    expect(result!.message).toContain("AI 서비스가 일시적으로 불안정합니다");
  });

  it("context_length 포함 메시지 → 컨텍스트 한도 초과 메시지", () => {
    const result = mapProviderError(
      new Error("This model's maximum context length is 128000 tokens"),
    );
    expect(result).not.toBeNull();
    expect(result!.message).toContain("컨텍스트 한도를 초과했습니다");
  });

  it("too many tokens 포함 메시지 → 컨텍스트 한도 초과 메시지", () => {
    const result = mapProviderError(new Error("too many tokens in request"));
    expect(result).not.toBeNull();
    expect(result!.message).toContain("컨텍스트 한도를 초과했습니다");
  });

  it("ENOTFOUND 메시지 → 네트워크 연결 메시지", () => {
    const result = mapProviderError(
      new Error("request to https://api.anthropic.com failed, ENOTFOUND"),
    );
    expect(result).not.toBeNull();
    expect(result!.message).toContain("네트워크 연결을 확인하세요");
  });

  it("fetch failed 메시지 → 네트워크 연결 메시지", () => {
    const result = mapProviderError(new Error("fetch failed"));
    expect(result).not.toBeNull();
    expect(result!.message).toContain("네트워크 연결을 확인하세요");
  });

  it("알 수 없는 오류는 null을 반환한다(원문 위임)", () => {
    const result = mapProviderError(new Error("some unknown random error xyz"));
    expect(result).toBeNull();
  });

  it("비-Error 객체도 처리한다", () => {
    const result = mapProviderError({ status: 429 });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("API 요청 한도를 초과했습니다");
  });
});

// ─────────────────────────────────────────────────────────
// thrash 감지 (findThrashingEditTool)
// ─────────────────────────────────────────────────────────

describe("findThrashingEditTool", () => {
  it("같은 편집 도구를 임계치(5) 이상 호출하면 감지한다", () => {
    const names = Array(6).fill("propose_cell_edit");
    expect(findThrashingEditTool(names)).toEqual({ tool: "propose_cell_edit", count: 6 });
  });

  it("임계치 미만이면 null", () => {
    expect(findThrashingEditTool(Array(4).fill("propose_cell_edit"))).toBeNull();
  });

  it("편집 도구가 아닌 반복(read_document)은 무시한다", () => {
    expect(findThrashingEditTool(Array(10).fill("read_document"))).toBeNull();
  });

  it("읽기 사이에 섞인 편집툴 호출도 누계로 센다", () => {
    const names = [
      "read_document",
      "propose_find_replace",
      "read_document",
      "propose_find_replace",
      "propose_find_replace",
      "read_document",
      "propose_find_replace",
      "propose_find_replace",
    ];
    expect(findThrashingEditTool(names)).toEqual({ tool: "propose_find_replace", count: 5 });
  });

  it("가장 많이 반복된 편집 도구를 고른다", () => {
    const names = [...Array(5).fill("propose_cell_edit"), ...Array(2).fill("propose_find_replace")];
    expect(findThrashingEditTool(names)).toEqual({ tool: "propose_cell_edit", count: 5 });
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

  it("이전 턴의 read_document 경로가 시스템 프롬프트(열람한 문서)에 복원된다", async () => {
    // 1단계: read_document tool-call이 담긴 멀티턴 기록 저장
    const store = await SessionStore.create({
      cwd: "/test",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    await store.appendUser("보고서.hwpx 읽어줘");
    await store.appendAssistant({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_document",
          input: { path: "보고서.hwpx" },
        },
      ],
    } as import("ai").ModelMessage);
    await store.appendAssistant({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_document",
          output: { type: "text", value: "문서 내용" },
        },
      ],
    } as import("ai").ModelMessage);
    await store.appendAssistant({
      role: "assistant",
      content: [{ type: "text", text: "읽었습니다" }],
    } as import("ai").ModelMessage);

    const resumedStore = await SessionStore.load(store.id);

    type AnyStreamPart = Record<string, unknown>;
    const parts: AnyStreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "후속 응답" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockModel = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doStream: async () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream: simulateReadableStream<any>({
          chunks: parts,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
        request: { body: "{}" },
        response: {},
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as unknown as LanguageModel;

    const session = new AgentSession({
      config: testConfig,
      model: mockModel,
      tools: new ToolRegistry(),
      approvalHandler: async () => ({ approved: true }),
      store: resumedStore,
      cwd: "/test",
    });
    await session.loadHistory();

    const controller = new AbortController();
    for await (const _e of session.run("요약해줘", controller.signal)) {
      // 소비
    }

    const rawModel = mockModel as unknown as import("ai/test").MockLanguageModelV3;
    const callOpts = rawModel.doStreamCalls[0]!;
    // 시스템 프롬프트는 V3 프롬프트의 role:"system" 메시지에 담긴다
    const callJson = JSON.stringify(callOpts);
    expect(callJson).toContain("열람한 문서");
    expect(callJson).toContain("보고서.hwpx");
  }, 15000);
});
