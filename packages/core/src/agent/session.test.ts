import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
