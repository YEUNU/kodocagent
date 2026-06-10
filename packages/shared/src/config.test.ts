import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  KNOWN_MODELS,
  KodocConfigSchema,
  type Provider,
  resolveModel,
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
