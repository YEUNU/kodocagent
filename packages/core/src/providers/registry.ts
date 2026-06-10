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
      const anthropic = createAnthropic({ apiKey });
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
