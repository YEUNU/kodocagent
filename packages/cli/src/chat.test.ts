/**
 * chat.ts 순수 헬퍼 테스트
 * H6: /model 커스텀 입력의 provider 검증 — 잘못된 provider가 config에 저장되어
 * 다음 기동 시 전체 키가 유실되는 것을 막는다.
 */
import { describe, expect, it } from "vitest";
import { parseCustomModelInput } from "./chat.js";

describe("parseCustomModelInput (H6 provider 검증)", () => {
  it("provider:modelId 형태의 유효한 provider는 통과한다", () => {
    const r = parseCustomModelInput("anthropic:claude-opus-4-8", "anthropic");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("anthropic");
      expect(r.modelId).toBe("claude-opus-4-8");
    }
  });

  it("콜론 없는 입력은 현재 provider를 유지한다", () => {
    const r = parseCustomModelInput("some-model-id", "openai");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("openai");
      expect(r.modelId).toBe("some-model-id");
    }
  });

  it("지원하지 않는 provider(오타)는 거부하고 안내 메시지를 준다", () => {
    const r = parseCustomModelInput("azure:gpt-4", "anthropic");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeDefined();
      expect(r.error).toContain("지원하지 않는");
    }
  });

  it("provider처럼 보이는 오타(claude-3:x)도 거부한다", () => {
    const r = parseCustomModelInput("claude-3:x", "anthropic");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("지원하지 않는");
  });

  it("빈 입력은 조용히 거부(에러 없음)", () => {
    const r = parseCustomModelInput("   ", "anthropic");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeUndefined();
  });

  it("provider만 있고 modelId가 비면 거부", () => {
    const r = parseCustomModelInput("anthropic:", "anthropic");
    expect(r.ok).toBe(false);
  });
});
