import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  hasAnyApiKey,
  KNOWN_MODELS,
  KodocConfigSchema,
  type Provider,
  parseConfigSafe,
  resolveActiveProvider,
  resolveModel,
  SetupValuesSchema,
} from "./config.js";

describe("KodocConfigSchema", () => {
  it("빈 객체를 기본값으로 파싱한다", () => {
    const cfg = KodocConfigSchema.parse({});
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.maxSteps).toBe(24);
    expect(cfg.model).toBeNull();
    expect(cfg.apiKeys.anthropic).toBeNull();
  });

  it("잘못된 프로바이더를 거부한다", () => {
    expect(() => KodocConfigSchema.parse({ provider: "mistral" })).toThrow();
  });

  it("프로바이더별 기본 모델이 알려진 모델 목록에 존재한다", () => {
    for (const [provider, model] of Object.entries(DEFAULT_MODELS)) {
      expect(KNOWN_MODELS[provider as Provider]).toContain(model);
    }
  });

  it("model 미지정 시 프로바이더 기본 모델로 해석한다", () => {
    const cfg = KodocConfigSchema.parse({ provider: "google" });
    expect(resolveModel(cfg)).toBe(DEFAULT_MODELS.google);
  });
});

describe("parseConfigSafe", () => {
  it("정상 설정을 ok:true로 파싱한다", () => {
    const result = parseConfigSafe({ provider: "anthropic" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.provider).toBe("anthropic");
  });

  it("미래 버전(version:2)은 future-version 이유로 구분한다", () => {
    const result = parseConfigSafe({ version: 2, provider: "anthropic" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("future-version");
      expect(result.message).toContain("v2");
    }
  });

  it("잘못된 형식(provider 오타)은 parse-error 이유로 구분한다", () => {
    const result = parseConfigSafe({ provider: "unknown-provider" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parse-error");
  });

  it("빈 객체는 기본값으로 파싱된다", () => {
    const result = parseConfigSafe({});
    expect(result.ok).toBe(true);
  });
});

describe("SetupValuesSchema", () => {
  it("유효한 입력을 파싱한다", () => {
    const result = SetupValuesSchema.safeParse({
      provider: "anthropic",
      apiKeys: { anthropic: "sk-ant-xxx" },
    });
    expect(result.success).toBe(true);
  });

  it("알 수 없는 필드를 제거(strip)한다", () => {
    const result = SetupValuesSchema.safeParse({
      provider: "anthropic",
      apiKeys: {},
      unknownField: "should-be-removed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("unknownField" in result.data).toBe(false);
    }
  });

  it("provider 필드가 없으면 거부한다", () => {
    const result = SetupValuesSchema.safeParse({ apiKeys: {} });
    expect(result.success).toBe(false);
  });
});

describe("resolveActiveProvider / hasAnyApiKey (셋 중 하나 자동 선택)", () => {
  const ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
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

  it("키가 하나도 없으면 null, hasAnyApiKey=false", () => {
    const cfg = KodocConfigSchema.parse({});
    expect(resolveActiveProvider(cfg)).toBeNull();
    expect(hasAnyApiKey(cfg)).toBe(false);
  });

  it("설정된 provider 에 키가 있으면 그대로 사용한다", () => {
    const cfg = KodocConfigSchema.parse({
      provider: "anthropic",
      apiKeys: { anthropic: "k", openai: null, google: null },
    });
    expect(resolveActiveProvider(cfg)).toBe("anthropic");
    expect(hasAnyApiKey(cfg)).toBe(true);
  });

  it("설정된 provider 에 키가 없고 다른 provider 에 있으면 자동 전환한다", () => {
    const cfg = KodocConfigSchema.parse({
      provider: "anthropic",
      apiKeys: { anthropic: null, openai: "k", google: null },
    });
    expect(resolveActiveProvider(cfg)).toBe("openai");
  });

  it("env 변수 키도 인식한다", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "envk";
    const cfg = KodocConfigSchema.parse({ provider: "anthropic" });
    expect(resolveActiveProvider(cfg)).toBe("google");
    expect(hasAnyApiKey(cfg)).toBe(true);
  });

  it("자동 전환 시 사용자 model 은 무시하고 전환된 provider 기본 모델을 쓴다", () => {
    const cfg = KodocConfigSchema.parse({
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKeys: { anthropic: null, openai: "k", google: null },
    });
    const active = resolveActiveProvider(cfg);
    expect(active).toBe("openai");
    expect(resolveModel(cfg, active ?? "anthropic")).toBe(DEFAULT_MODELS.openai);
  });
});
