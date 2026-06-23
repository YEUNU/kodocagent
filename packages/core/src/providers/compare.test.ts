import { KodocConfigSchema } from "@kodocagent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AI SDK generateText 와 provider별 모델 생성을 mock 한다(네트워크 없이 오케스트레이션만 검증).
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("./registry.js", () => ({
  createModelForProvider: (_config: unknown, provider: string) => ({ __provider: provider }),
}));

import { compareProviders, keyedProviders } from "./compare.js";

const ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  generateTextMock.mockReset();
  for (const v of ENV_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of ENV_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("keyedProviders", () => {
  it("키가 있는 프로바이더만 반환한다", () => {
    const cfg = KodocConfigSchema.parse({
      apiKeys: { anthropic: "a", openai: null, google: "g" },
    });
    expect(keyedProviders(cfg)).toEqual(["anthropic", "google"]);
  });

  it("키가 없으면 빈 배열", () => {
    expect(keyedProviders(KodocConfigSchema.parse({}))).toEqual([]);
  });
});

describe("compareProviders", () => {
  it("키가 있는 각 프로바이더에 병렬 전송하고 결과를 모은다(개별 실패 격리)", async () => {
    generateTextMock.mockImplementation(async (args: { model: { __provider: string } }) => {
      if (args.model.__provider === "openai") throw new Error("rate limit");
      return {
        text: `[${args.model.__provider}] 응답`,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const cfg = KodocConfigSchema.parse({
      apiKeys: { anthropic: "a", openai: "o", google: "g" },
    });

    const results = await compareProviders(cfg, "요약해줘");
    expect(results).toHaveLength(3);
    const byProv = Object.fromEntries(results.map((r) => [r.provider, r]));
    expect(byProv.anthropic.ok).toBe(true);
    expect(byProv.anthropic.text).toContain("anthropic");
    expect(byProv.anthropic.outputTokens).toBe(5);
    expect(byProv.google.ok).toBe(true);
    expect(byProv.openai.ok).toBe(false);
    expect(byProv.openai.error).toContain("rate limit");
  });

  it("documentText 를 프롬프트 앞에 붙인다", async () => {
    generateTextMock.mockResolvedValue({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } });
    const cfg = KodocConfigSchema.parse({
      apiKeys: { anthropic: "a", openai: null, google: null },
    });

    await compareProviders(cfg, "이 문서 요약해줘", { documentText: "예산안 본문…" });
    const call = generateTextMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("예산안 본문…");
    expect(call.prompt).toContain("이 문서 요약해줘");
  });

  it("키가 없으면 빈 결과", async () => {
    const cfg = KodocConfigSchema.parse({});
    expect(await compareProviders(cfg, "x")).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
