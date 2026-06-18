/**
 * API 토큰 사용량·추정 비용 표시 유틸
 *
 * 모델 토큰 단가는 공개 정가 기준 **추정치**다(변동 가능). 단가가 등록되지 않은
 * 모델은 토큰만 표시하고 비용은 생략한다(잘못된 추정 방지).
 */

import type { KodocConfig } from "@kodocagent/shared";
import chalk from "chalk";

/** 토큰 단가 — USD per 1,000,000 tokens. */
interface TokenPrice {
  input: number;
  output: number;
}

/**
 * 모델별 단가(USD/1M 토큰). 접두 매칭하므로 버전 접미사 변형을 함께 커버한다
 * (예: "claude-opus-4-8" → "claude-opus-4"). 공개 정가 기준 추정치 — 갱신 필요 시 여기만 수정.
 */
const MODEL_PRICING: Array<{ prefix: string; price: TokenPrice }> = [
  // Anthropic Claude (USD per 1M tokens)
  { prefix: "claude-opus-4", price: { input: 15, output: 75 } },
  { prefix: "claude-sonnet-4", price: { input: 3, output: 15 } },
  { prefix: "claude-haiku-4", price: { input: 1, output: 5 } },
  // OpenAI·Google: 정가 미확정 → 미등록(토큰만 표시)
];

/** provider 기본 모델(config.model 미설정 시 비용 추정용). */
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-opus-4-8",
};

/** 비용 추정에 쓸 실제 모델 id(미설정이면 provider 기본). */
export function effectiveModelId(config: Pick<KodocConfig, "provider" | "model">): string {
  return config.model ?? PROVIDER_DEFAULT_MODEL[config.provider] ?? "";
}

/** 모델 id의 단가를 찾는다(접두 매칭). 없으면 null. */
function resolveTokenPrice(model: string): TokenPrice | null {
  for (const { prefix, price } of MODEL_PRICING) {
    if (model.startsWith(prefix)) return price;
  }
  return null;
}

/** 입력·출력 토큰의 추정 비용(USD). 단가 미등록이면 null. */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = resolveTokenPrice(model);
  if (!p) return null;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** USD 비용을 자릿수 보정해 표기($0.0001 미만은 더 정밀하게). */
function fmtUsd(cost: number): string {
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(4)}`;
}

/** 누적 사용량 한 줄 — 토큰 + 추정 비용(단가 미등록 모델은 토큰만, dim). */
export function formatCumulativeUsage(
  config: Pick<KodocConfig, "provider" | "model">,
  inputTokens: number,
  outputTokens: number,
): string {
  const cost = estimateCostUsd(effectiveModelId(config), inputTokens, outputTokens);
  const costStr = cost !== null ? ` · 추정 누적 비용 ${fmtUsd(cost)}` : " · (단가 미등록 — 토큰만)";
  return chalk.dim(
    `누적 API 사용: 입력 ${fmtTok(inputTokens)} · 출력 ${fmtTok(outputTokens)} 토큰${costStr}`,
  );
}
