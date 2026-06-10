/**
 * 온보딩 — 최초 실행 시 프로바이더/키 설정
 * docs/SPEC.md §8
 *
 * clack prompts 사용: intro, select, password, text, outro
 */

import { existsSync } from "node:fs";
import { intro, isCancel, note, outro, password, select, text } from "@clack/prompts";
import { loadConfig, saveConfig } from "@kodocagent/core";
import type { Provider } from "@kodocagent/shared";
import { KODOC_PATHS, PROVIDERS } from "@kodocagent/shared";

/**
 * 설정 파일이 없으면 true를 반환한다 (온보딩 필요 여부 판단).
 */
export function needsOnboarding(): boolean {
  return !existsSync(KODOC_PATHS.config);
}

/**
 * 온보딩 시퀀스를 실행한다.
 * clack prompts를 사용하므로 TTY 환경에서만 동작한다.
 */
export async function runOnboarding(): Promise<void> {
  intro("kodocagent 초기 설정에 오신 것을 환영합니다!");

  // 1. 프로바이더 선택
  const providerResult = await select<Provider>({
    message: "사용할 AI 프로바이더를 선택하세요:",
    options: [
      { value: "anthropic", label: "Anthropic (Claude)", hint: "claude-opus-4-8 기본" },
      { value: "openai", label: "OpenAI (GPT)", hint: "gpt-5.5 기본" },
      { value: "google", label: "Google (Gemini)", hint: "gemini-3.5-flash 기본" },
    ],
  });

  if (isCancel(providerResult)) {
    process.stdout.write("설정이 취소되었습니다.\n");
    process.exit(0);
  }

  const provider = providerResult as Provider;

  // 2. API 키 입력 (마스킹)
  const apiKeyEnvVars: Record<Provider, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
  };

  const apiKeyResult = await password({
    message: `${provider} API 키를 입력하세요 (환경변수 ${apiKeyEnvVars[provider]}):`,
    validate: (v) => {
      if (!v || v.trim().length === 0) return "API 키를 입력해주세요.";
      return undefined;
    },
  });

  if (isCancel(apiKeyResult)) {
    process.stdout.write("설정이 취소되었습니다.\n");
    process.exit(0);
  }

  const apiKey = String(apiKeyResult);

  // 3. LAW_OC 키 입력 (선택)
  note(
    "국가법령정보센터 Open API 키(LAW_OC)를 등록하면 법령 검색 기능을 사용할 수 있습니다.\n" +
      "발급: https://open.law.go.kr  →  오픈 API 신청",
    "법령 기능 안내",
  );

  const lawKeyResult = await text({
    message: "LAW_OC 키를 입력하세요 (Enter로 건너뛸 수 있습니다):",
    placeholder: "(선택사항 — 나중에 kodocagent config set law-key <키> 로 설정 가능)",
    defaultValue: "",
  });

  if (isCancel(lawKeyResult)) {
    process.stdout.write("설정이 취소되었습니다.\n");
    process.exit(0);
  }

  const lawKey = String(lawKeyResult).trim() || null;

  // 4. 설정 저장
  const config = await loadConfig();
  config.provider = provider;
  config.apiKeys[provider] = apiKey;
  if (lawKey) config.lawApiKey = lawKey;

  await saveConfig(config);

  if (!PROVIDERS.includes(provider)) {
    // exhaustive guard
  }

  outro(
    `설정이 저장되었습니다! (${KODOC_PATHS.config})\n` +
      `이제 '${provider}' 프로바이더로 채팅을 시작합니다.`,
  );
}
