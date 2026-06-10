/**
 * kodocagent CLI 진입점
 * docs/SPEC.md §8
 */

import { listSessions } from "@kodocagent/core";
import { KodocError } from "@kodocagent/shared";
import chalk from "chalk";
import { Command } from "commander";
import { runChat } from "./chat.js";
import { configSet, configShow } from "./config-cmd.js";
import { needsOnboarding, runOnboarding } from "./onboarding.js";
import { cliVersion } from "./version.js";

// Windows: stdout UTF-8 강제
if (process.platform === "win32") {
  try {
    (process.stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding("utf8");
    (process.stderr as unknown as { setEncoding: (enc: string) => void }).setEncoding("utf8");
  } catch {
    // ignore
  }
}

const program = new Command();

program
  .name("kodocagent")
  .description("한국어 특화 문서 AI 에이전트 — HWP/HWPX/DOCX/XLSX 읽기·수정, 한국 법령 기반 검토")
  .version(cliVersion(), "-v, --version", "버전 출력");

// ──────────────────────────────────────────────
// 기본 동작: 채팅 시작 (온보딩 포함)
// ──────────────────────────────────────────────

program
  .option("-p, --print <prompt>", "단발 질의 (비대화형, 쓰기 툴 비활성)")
  .option("--continue", "가장 최근 세션 재개")
  .option("--resume <id>", "지정한 세션 ID 재개")
  .action(async (options: { print?: string; continue?: boolean; resume?: string }) => {
    try {
      // 온보딩 체크
      if (needsOnboarding()) {
        await runOnboarding();
      }

      if (options.print) {
        // 단발 질의
        await runSingleTurn(options.print);
      } else {
        await runChat({
          resumeId: options.resume,
          continueLatest: options.continue,
        });
      }
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ──────────────────────────────────────────────
// sessions 서브커맨드
// ──────────────────────────────────────────────

program
  .command("sessions")
  .description("세션 목록 표시")
  .action(async () => {
    try {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        process.stdout.write("저장된 세션이 없습니다.\n");
        return;
      }
      for (const s of sessions) {
        const dateStr = s.mtime.toLocaleString("ko-KR");
        process.stdout.write(
          `${chalk.bold(s.id)}  ${chalk.dim(dateStr)}  ${chalk.cyan(s.meta.provider)}/${s.meta.model ?? "(기본)"}  ${s.meta.cwd}\n`,
        );
      }
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ──────────────────────────────────────────────
// config 서브커맨드
// ──────────────────────────────────────────────

const configCmd = program.command("config").description("설정 관리");

configCmd
  .command("set <key> <value>")
  .description(
    "설정값 저장 (key: provider, model, api-key.anthropic|openai|google, law-key, max-steps)",
  )
  .action(async (key: string, value: string) => {
    try {
      await configSet(key, value);
    } catch (err: unknown) {
      handleError(err);
    }
  });

configCmd
  .command("show")
  .description("현재 설정 표시 (API 키는 마스킹)")
  .action(async () => {
    try {
      await configShow();
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ──────────────────────────────────────────────
// 에러 핸들러
// ──────────────────────────────────────────────

function handleError(err: unknown): void {
  if (err instanceof KodocError) {
    process.stderr.write(chalk.red(`오류: ${err.message}\n`));
    if (err.hint) {
      process.stderr.write(chalk.yellow(`  → ${err.hint}\n`));
    }
  } else if (err instanceof Error) {
    process.stderr.write(chalk.red(`오류: ${err.message}\n`));
  } else {
    process.stderr.write(chalk.red(`알 수 없는 오류: ${String(err)}\n`));
  }
  process.exit(1);
}

// ──────────────────────────────────────────────
// 단발 질의 (--print)
// ──────────────────────────────────────────────

async function runSingleTurn(prompt: string): Promise<void> {
  const { loadConfig, createModel, ToolRegistry, AgentSession, SessionStore } = await import(
    "@kodocagent/core"
  );

  const config = await loadConfig();
  const model = createModel(config);
  const cwd = process.cwd();

  const store = await SessionStore.create({
    cwd,
    provider: config.provider,
    model: config.model ?? "(기본값)",
    createdAt: new Date().toISOString(),
  });

  const tools = new ToolRegistry();
  // 단발 질의는 읽기 툴만 활성
  const { createDocTools } = await import("@kodocagent/doc-tools");
  for (const tool of createDocTools({ cwd })) {
    tools.register(tool as import("@kodocagent/core").ToolDefinition<unknown>);
  }

  const session = new AgentSession({
    config,
    model,
    tools,
    approvalHandler: async () => ({
      approved: false,
      reason: "비대화형 모드에서는 파일 수정이 허용되지 않습니다.",
    }),
    store,
    cwd,
  });

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  for await (const event of session.run(prompt, controller.signal)) {
    if (event.type === "text-delta") {
      process.stdout.write(event.text);
    } else if (event.type === "error") {
      process.stderr.write(chalk.red(`\n오류: ${event.message}\n`));
    }
  }
  process.stdout.write("\n");
}

program.parse();
