/**
 * 프로바이더 레지스트리 — AI SDK v6 LanguageModel 생성
 * docs/SPEC.md §3
 *
 * 중요: temperature/topP/topK 등 샘플링 파라미터 설정 금지
 * Claude Opus 4.7+/Fable 5는 400 에러를 반환한다.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { KodocConfig } from "@kodocagent/shared";
import { KodocError, resolveApiKey, resolveModel } from "@kodocagent/shared";
import type { LanguageModel } from "ai";

/**
 * ANTHROPIC_BASE_URL이 공식 호스트인데 /v1 경로가 빠진 경우(Claude Code/Desktop이 주입하는 값)
 * 만 /v1을 보강해 반환한다. 그 외(미설정·커스텀 프록시·이미 /v1 포함)는 undefined를 반환해
 * SDK 기본 동작(환경변수/기본값)을 그대로 존중한다.
 */
export function normalizeAnthropicBaseUrl(envValue: string | undefined): string | undefined {
  // 미설정 → SDK 기본값(/v1 포함) 사용
  if (!envValue) return undefined;

  let url: URL;
  try {
    url = new URL(envValue);
  } catch {
    // URL 파싱 실패 → 건드리지 않음
    return undefined;
  }

  // 공식 호스트가 아닌 경우 → 커스텀 프록시 존중
  if (url.hostname !== "api.anthropic.com") return undefined;

  // 트레일링 슬래시 제거 후 pathname 확인
  const pathname = url.pathname.replace(/\/+$/, "");

  // pathname이 비었거나 루트만 있는 경우(/v1 누락) → /v1 보강
  if (pathname === "") return "https://api.anthropic.com/v1";

  // 이미 경로가 있는 경우(/v1 등) → 존중
  return undefined;
}

/**
 * 활성 설정 기반으로 AI SDK v6 LanguageModel을 생성한다.
 * API 키가 없으면 KodocError를 던진다.
 */
export function createModel(config: KodocConfig): LanguageModel {
  const { provider } = config;
  const apiKey = resolveApiKey(config, provider);
  const modelId = resolveModel(config);

  if (!apiKey) {
    throw new KodocError(
      `API 키가 없습니다. 프로바이더: ${provider}`,
      `'kodocagent config set api-key.${provider} <키>'로 API 키를 설정하거나, 환경변수를 지정하세요.`,
    );
  }

  switch (provider) {
    case "anthropic": {
      // Claude Code/Desktop 환경에서 ANTHROPIC_BASE_URL에 /v1이 빠진 경우를 보정한다
      const baseURL = normalizeAnthropicBaseUrl(process.env.ANTHROPIC_BASE_URL);
      const anthropic = createAnthropic(baseURL ? { apiKey, baseURL } : { apiKey });
      return anthropic(modelId);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }
    default: {
      // exhaustive check
      const _never: never = provider;
      throw new KodocError(
        `지원하지 않는 프로바이더입니다: ${_never}`,
        "anthropic, openai, google 중 하나를 선택하세요.",
      );
    }
  }
}
