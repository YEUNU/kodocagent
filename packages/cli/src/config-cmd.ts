/**
 * config 서브커맨드 — kodocagent config set <key> <value> / config show
 * docs/SPEC.md §8
 */
import { loadConfig, saveConfig } from "@kodocagent/core";
import { KodocError, PROVIDERS } from "@kodocagent/shared";

/** 설정 가능한 키 */
const SETTABLE_KEYS = [
  "provider",
  "model",
  "api-key.anthropic",
  "api-key.openai",
  "api-key.google",
  "law-key",
  "max-steps",
  "max-context-tokens",
] as const;

type SettableKey = (typeof SETTABLE_KEYS)[number];

/**
 * config set <key> <value> 실행
 */
export async function configSet(key: string, value: string): Promise<void> {
  if (!SETTABLE_KEYS.includes(key as SettableKey)) {
    throw new KodocError(
      `알 수 없는 설정 키: '${key}'`,
      `사용 가능한 키: ${SETTABLE_KEYS.join(", ")}`,
    );
  }

  const config = await loadConfig();

  switch (key as SettableKey) {
    case "provider": {
      if (!PROVIDERS.includes(value as (typeof PROVIDERS)[number])) {
        throw new KodocError(
          `알 수 없는 프로바이더: '${value}'`,
          `사용 가능한 프로바이더: ${PROVIDERS.join(", ")}`,
        );
      }
      config.provider = value as (typeof PROVIDERS)[number];
      break;
    }
    case "model": {
      config.model = value;
      break;
    }
    case "api-key.anthropic": {
      config.apiKeys.anthropic = value;
      break;
    }
    case "api-key.openai": {
      config.apiKeys.openai = value;
      break;
    }
    case "api-key.google": {
      config.apiKeys.google = value;
      break;
    }
    case "law-key": {
      config.lawApiKey = value;
      break;
    }
    case "max-steps": {
      const steps = parseInt(value, 10);
      if (isNaN(steps) || steps < 1 || steps > 100) {
        throw new KodocError(
          `max-steps는 1~100 사이의 정수여야 합니다: '${value}'`,
          "예: kodocagent config set max-steps 24",
        );
      }
      config.maxSteps = steps;
      break;
    }
    case "max-context-tokens": {
      const tokens = parseInt(value, 10);
      if (isNaN(tokens) || tokens < 10000 || tokens > 2000000) {
        throw new KodocError(
          `max-context-tokens는 10000~2000000 사이의 정수여야 합니다: '${value}'`,
          "예: kodocagent config set max-context-tokens 120000",
        );
      }
      config.maxContextTokens = tokens;
      break;
    }
  }

  await saveConfig(config);
  process.stdout.write(`✓ ${key} 설정이 저장되었습니다.\n`);
}

/**
 * config show 실행 — API 키는 앞 6자 + "..." 마스킹
 */
export async function configShow(): Promise<void> {
  const config = await loadConfig();

  function maskKey(key: string | null | undefined): string {
    if (!key) return "(미설정)";
    if (key.length <= 6) return "***";
    return `${key.slice(0, 6)}...`;
  }

  const lines = [
    `provider:           ${config.provider}`,
    `model:              ${config.model ?? "(프로바이더 기본값)"}`,
    `api-key.anthropic:  ${maskKey(config.apiKeys.anthropic)}`,
    `api-key.openai:     ${maskKey(config.apiKeys.openai)}`,
    `api-key.google:     ${maskKey(config.apiKeys.google)}`,
    `law-key:            ${maskKey(config.lawApiKey)}`,
    `max-steps:          ${config.maxSteps}`,
    `max-context-tokens: ${config.maxContextTokens}`,
  ];

  process.stdout.write(lines.join("\n") + "\n");
}
