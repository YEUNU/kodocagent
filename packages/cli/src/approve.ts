/**
 * CLI 승인 UI — 변경 제안을 diff와 함께 렌더하고 사용자 선택을 받는다.
 * docs/SPEC.md §7, §8
 *
 * - 비 TTY: 자동 거절 ("대화형 터미널에서 실행하세요")
 * - TTY: clack select로 승인 / 거절 / 거절(사유 입력)
 * - diff 렌더: + 초록, - 빨강, @@ 시안, 헤더 dim; 최대 400줄
 */

import { isCancel, select } from "@clack/prompts";
import type { ApprovalHandler, ApprovalResult, Proposal } from "@kodocagent/shared";
import chalk from "chalk";

const MAX_DIFF_LINES = 400;

/**
 * diff 텍스트를 터미널 컬러로 렌더링한다.
 */
function renderColoredDiff(diff: string): string {
  const lines = diff.split("\n");
  const displayLines = lines.slice(0, MAX_DIFF_LINES);
  const truncated = lines.length > MAX_DIFF_LINES;

  const rendered = displayLines
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return chalk.dim(line);
      }
      if (line.startsWith("@@")) {
        return chalk.cyan(line);
      }
      if (line.startsWith("+")) {
        return chalk.green(line);
      }
      if (line.startsWith("-")) {
        return chalk.red(line);
      }
      return line;
    })
    .join("\n");

  if (truncated) {
    return `${rendered}\n${chalk.dim(`...이하 생략 (총 ${lines.length}줄 중 ${MAX_DIFF_LINES}줄 표시)`)}`;
  }
  return rendered;
}

/**
 * Proposal을 터미널에 렌더링한다 (diff, 경고, 포맷 변환 안내 포함).
 */
function renderProposal(proposal: Proposal): void {
  process.stdout.write("\n");

  // 박스 헤더
  process.stdout.write(chalk.bold.blue("┌─ 변경 승인 요청 ─────────────────────────────────\n"));
  process.stdout.write(chalk.bold(`│ 요약: ${proposal.summary}\n`));
  process.stdout.write(chalk.dim(`│ 타겟: ${proposal.targetPath}\n`));

  // 포맷 변환 경고 (노랑)
  if (proposal.willConvertFormat) {
    process.stdout.write(chalk.yellow(`│ ⚠ 포맷 변환: ${proposal.willConvertFormat}\n`));
  }

  // 경고 목록 (노랑)
  for (const warning of proposal.warnings) {
    process.stdout.write(chalk.yellow(`│ ⚠ ${warning}\n`));
  }

  process.stdout.write(chalk.bold.blue("└──────────────────────────────────────────────────\n"));
  process.stdout.write("\n");

  // diff 렌더
  if (proposal.diff) {
    process.stdout.write(renderColoredDiff(proposal.diff));
    process.stdout.write("\n\n");
  }
}

/**
 * CLI 승인 핸들러를 생성한다.
 *
 * 비 TTY 환경에서는 자동 거절.
 * TTY 환경에서는 diff 렌더 → clack select로 승인/거절.
 */
export function createCliApprovalHandler(): ApprovalHandler {
  return async (proposal: Proposal): Promise<ApprovalResult> => {
    // 비 TTY: 자동 거절
    if (!process.stdout.isTTY) {
      return {
        approved: false,
        reason: "대화형 터미널에서 실행하세요",
      };
    }

    // Proposal 렌더
    renderProposal(proposal);

    // clack select: 승인 / 거절 — 단일 단계 (별도 사유 입력 없음)
    // 변경을 원하면 거절 후 채팅으로 다시 지시하면 된다.
    type SelectValue = "approve" | "reject";

    const choice = await select<SelectValue>({
      message: "변경 사항을 저장할까요?",
      options: [
        { value: "approve", label: "✅ 승인 — 파일을 저장합니다" },
        { value: "reject", label: "❌ 거절 — 저장하지 않고 취소합니다" },
      ],
    });

    // 거절 또는 취소(Esc) → 저장하지 않음
    if (isCancel(choice) || choice === "reject") {
      return { approved: false };
    }

    return { approved: true };
  };
}
