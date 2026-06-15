import { z } from "zod";

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** 프로바이더별 기본 모델 (Anthropic은 비용·속도 균형으로 Sonnet, docs/SPEC.md §3) */
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  google: "gemini-3.5-flash",
};

/** /model 선택 UI에 노출되는 검증된 모델 목록. 미등재 ID도 BYOK 특성상 통과 허용 */
export const KNOWN_MODELS: Record<Provider, string[]> = {
  anthropic: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5"],
  google: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
};

/** 프로바이더 API 키 환경변수 — config.json보다 우선 */
export const PROVIDER_ENV_VARS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/** 국가법령정보센터 Open API 키 환경변수 (korean-law-mcp가 읽는 이름) */
export const LAW_ENV_VAR = "LAW_OC";

export const KodocConfigSchema = z.object({
  version: z.literal(1).default(1),
  provider: z.enum(PROVIDERS).default("anthropic"),
  /** null이면 프로바이더 기본 모델(DEFAULT_MODELS) 사용 */
  model: z.string().nullable().default(null),
  apiKeys: z
    .object({
      anthropic: z.string().nullable().default(null),
      openai: z.string().nullable().default(null),
      google: z.string().nullable().default(null),
    })
    .default({ anthropic: null, openai: null, google: null }),
  lawApiKey: z.string().nullable().default(null),
  locale: z.literal("ko").default("ko"),
  maxSteps: z.number().int().min(1).max(100).default(24),
});

export type KodocConfig = z.infer<typeof KodocConfigSchema>;

export function resolveModel(config: KodocConfig): string {
  return config.model ?? DEFAULT_MODELS[config.provider];
}

export function resolveApiKey(config: KodocConfig, provider: Provider): string | null {
  return process.env[PROVIDER_ENV_VARS[provider]] ?? config.apiKeys[provider];
}
