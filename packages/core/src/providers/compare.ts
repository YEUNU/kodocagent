/**
 * 멀티 프로바이더 비교 — 같은 질의를 키가 있는 여러 프로바이더에 **읽기전용**(generateText, 도구 없음)
 * 으로 병렬 전송하고 결과를 모아 반환한다. 문서를 바꾸지 않고 텍스트 응답만 비교한다(편집 에이전트를
 * N개 돌리면 서로 충돌하므로 비교는 읽기전용으로 한정한다).
 */
import type { KodocConfig, Provider } from "@kodocagent/shared";
import { PROVIDERS, resolveApiKey, resolveModel } from "@kodocagent/shared";
import { generateText } from "ai";
import { createModelForProvider } from "./registry.js";

export interface ProviderComparisonResult {
  provider: Provider;
  model: string;
  ok: boolean;
  text?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 응답까지 걸린 시간(ms) */
  ms: number;
}

export interface CompareOptions {
  /** 프롬프트 앞에 붙일 문서/맥락 텍스트(선택) */
  documentText?: string;
  /** 시스템 프롬프트(선택, 미지정 시 기본값) */
  system?: string;
  /** 비교할 프로바이더를 명시(미지정 시 키가 있는 모든 프로바이더) */
  providers?: Provider[];
}

const DEFAULT_SYSTEM =
  "당신은 한국어 문서 작업을 돕는 어시스턴트입니다. 주어진 문서와 질문에 정확하고 간결하게 한국어로 답하세요. 문서를 임의로 바꾸지 말고 질문에만 답하세요.";

/** 키가 있는(env 또는 config) 프로바이더 목록. */
export function keyedProviders(config: KodocConfig): Provider[] {
  return PROVIDERS.filter((p) => !!resolveApiKey(config, p));
}

/**
 * 키가 있는(또는 명시된) 프로바이더들에 같은 질의를 병렬 전송하고 결과 배열을 반환한다.
 * 개별 프로바이더 실패는 결과에 `ok:false`로 담기며 전체를 중단시키지 않는다.
 */
export async function compareProviders(
  config: KodocConfig,
  prompt: string,
  opts: CompareOptions = {},
): Promise<ProviderComparisonResult[]> {
  const targets = (opts.providers ?? keyedProviders(config)).filter(
    (p) => !!resolveApiKey(config, p),
  );
  const fullPrompt = opts.documentText
    ? `다음은 작업 중인 문서입니다:\n\n${opts.documentText}\n\n---\n\n${prompt}`
    : prompt;

  return Promise.all(
    targets.map(async (provider): Promise<ProviderComparisonResult> => {
      const model = resolveModel(config, provider);
      const start = Date.now();
      try {
        const result = await generateText({
          model: createModelForProvider(config, provider),
          system: opts.system ?? DEFAULT_SYSTEM,
          prompt: fullPrompt,
        });
        return {
          provider,
          model,
          ok: true,
          text: result.text,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          ms: Date.now() - start,
        };
      } catch (err) {
        return {
          provider,
          model,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ms: Date.now() - start,
        };
      }
    }),
  );
}
