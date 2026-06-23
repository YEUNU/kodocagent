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

export const CURRENT_CONFIG_VERSION = 1;

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
  /** 모델에 보낼 최대 컨텍스트 토큰 수 (초과 시 오래된 tool-result부터 압축) */
  maxContextTokens: z.number().int().min(10000).max(2000000).default(120000),
});

export type KodocConfig = z.infer<typeof KodocConfigSchema>;

/**
 * config:save IPC 핸들러용 zod 런타임 검증 스키마.
 * GUI main process에서 렌더러 입력 검증 시 사용.
 * 알 수 없는 필드는 strip(제거), 타입 불일치는 거부한다.
 */
export const SetupValuesSchema = z.object({
  provider: z.string(),
  apiKeys: z
    .object({
      anthropic: z.string().optional(),
      openai: z.string().optional(),
      google: z.string().optional(),
    })
    .default({}),
  lawApiKey: z.string().optional(),
});

export type SetupValues = z.infer<typeof SetupValuesSchema>;

/**
 * 설정 파일 로드 결과 — 버전 미래값(더 새 버전) 분리 포함
 */
export type ConfigLoadResult =
  | { ok: true; config: KodocConfig }
  | { ok: false; reason: "future-version"; version: number; message: string }
  | { ok: false; reason: "parse-error"; message: string };

/**
 * 알 수 없는 필드 제거(strip) 후 설정 파싱.
 * version > CURRENT_CONFIG_VERSION 이면 "future-version" 오류로 구분한다.
 */
export function parseConfigSafe(raw: unknown): ConfigLoadResult {
  // version 선검사 — 미래 버전이면 일반 손상 오류와 구분
  if (raw !== null && typeof raw === "object" && "version" in raw) {
    const v = (raw as Record<string, unknown>).version;
    if (typeof v === "number" && v > CURRENT_CONFIG_VERSION) {
      return {
        ok: false,
        reason: "future-version",
        version: v,
        message: `설정 파일이 더 새 버전(v${v})입니다. kodocagent를 최신 버전으로 업데이트하거나, 설정 파일을 초기화하세요.`,
      };
    }
  }
  const result = KodocConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      reason: "parse-error",
      message: `설정 파일이 손상되었습니다: ${result.error.issues.map((i) => i.message).join(", ")}`,
    };
  }
  return { ok: true, config: result.data };
}

export function resolveModel(config: KodocConfig, provider: Provider = config.provider): string {
  // 사용자가 명시한 모델(config.model)은 그 모델이 속한 provider(=설정된 provider)일 때만
  // 적용한다. provider 가 자동 전환된 경우(설정 provider 에 키가 없어 다른 provider 사용)엔
  // 그 provider 의 기본 모델을 쓴다 — 다른 provider 에 엉뚱한 모델 ID 를 넘기지 않도록.
  if (config.model && provider === config.provider) return config.model;
  return DEFAULT_MODELS[provider];
}

export function resolveApiKey(config: KodocConfig, provider: Provider): string | null {
  return process.env[PROVIDER_ENV_VARS[provider]] ?? config.apiKeys[provider];
}

/** 키가 하나라도(env 또는 config) 있으면 true. */
export function hasAnyApiKey(config: KodocConfig): boolean {
  return PROVIDERS.some((p) => !!resolveApiKey(config, p));
}

/**
 * 실제로 사용할 프로바이더를 고른다(BYOK — 키가 있는 것을 자동 선택).
 * 설정된 provider 에 키가 있으면 그대로, 없으면 PROVIDERS 우선순위로 키가 있는 첫 프로바이더.
 * 셋 다 키가 없으면 null.
 */
export function resolveActiveProvider(config: KodocConfig): Provider | null {
  if (resolveApiKey(config, config.provider)) return config.provider;
  for (const p of PROVIDERS) {
    if (resolveApiKey(config, p)) return p;
  }
  return null;
}
