/**
 * API 토큰 사용량 표시 유틸 — 사용한 입력·출력 토큰만 표시한다(비용 미표시).
 */

import chalk from "chalk";

const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 누적 사용량 한 줄 — 입력·출력 토큰(dim). */
export function formatCumulativeUsage(inputTokens: number, outputTokens: number): string {
  return chalk.dim(
    `누적 API 사용: 입력 ${fmtTok(inputTokens)} · 출력 ${fmtTok(outputTokens)} 토큰`,
  );
}
