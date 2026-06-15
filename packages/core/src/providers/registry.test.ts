import { describe, expect, it } from "vitest";
import { normalizeAnthropicBaseUrl } from "./registry.js";

describe("normalizeAnthropicBaseUrl", () => {
  it.each([
    // [입력, 기대 출력]
    [undefined, undefined],
    ["https://api.anthropic.com", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/v1", undefined],
    ["https://api.anthropic.com/v1/", undefined],
    ["https://my-proxy.example.com", undefined],
    ["https://my-proxy.example.com/anthropic", undefined],
    ["not-a-url", undefined],
  ])("normalizeAnthropicBaseUrl(%s) === %s", (input, expected) => {
    expect(normalizeAnthropicBaseUrl(input)).toBe(expected);
  });
});
