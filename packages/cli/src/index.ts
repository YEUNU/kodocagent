/**
 * kodocagent CLI 진입점
 * docs/SPEC.md §8
 */

import { isCancel, select } from "@clack/prompts";
import {
  AgentSession,
  createModel,
  listSessions,
  loadConfig,
  loadMcpConfig,
  McpManager,
  SessionStore,
  ToolRegistry,
} from "@kodocagent/core";
import { cleanOldBackups, cleanSessionStaging, createDocTools } from "@kodocagent/doc-tools";
import { acquireInstanceLock, KodocError, releaseInstanceLock } from "@kodocagent/shared";
import chalk from "chalk";
import { Command } from "commander";
import { runChat } from "./chat.js";
import { runClean } from "./clean-cmd.js";
import { configSet, configShow } from "./config-cmd.js";
import { installFatalHandlers, setActiveSessionId } from "./fatal-cleanup.js";
import { mcpList, mcpTest } from "./mcp-cmd.js";
import { needsOnboarding, runOnboarding } from "./onboarding.js";
import { checkForUpdate, runUpdate } from "./update.js";
import { cliVersion } from "./version.js";

// 최상위 미처리 예외 그물 — 인터랙티브 진입 전 가장 이른 시점에 등록.
// (락 해제·스테이징 정리 후 한국어 메시지로 종료; 정상 종료의 finally 정리와 idempotent하게 공존)
installFatalHandlers();

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
  .option("--resume [id]", "세션 재개 (ID 생략 시 목록에서 선택)")
  .action(async (options: { print?: string; continue?: boolean; resume?: string | true }) => {
    try {
      // 온보딩 체크
      if (needsOnboarding()) {
        await runOnboarding();
      }

      // OTA 업데이트 체크 (3s 타임아웃 — 캐시 히트 시 즉시 반환)
      const newVersion = await checkForUpdate(cliVersion()).catch(() => null);
      if (newVersion) {
        process.stdout.write(
          chalk.yellow(`새 버전 v${newVersion} 사용 가능 — 'kodocagent update'로 업데이트하세요\n`),
        );
      }

      // ⑫ 문서 작업 진입 시에만 best-effort 백업 정리(모든 CLI 명령이 아니라 채팅/단발에서만)
      cleanOldBackups(30).catch(() => {});

      if (options.print) {
        // 단발 질의(읽기 전용) — 동시 편집 위험 없음, 인스턴스 락 불필요
        await runSingleTurn(options.print);
        return;
      }

      // ③ 대화형(쓰기 가능) 세션에서만 동시 인스턴스 경고. 종료 시 자기 락 해제.
      const lockWarn = await acquireInstanceLock();
      if (lockWarn) {
        process.stderr.write(chalk.yellow(`⚠ ${lockWarn}\n`));
      }
      try {
        if (options.resume === true) {
          // --resume 만 주어진 경우 — 세션 선택 UI
          const resumeId = await pickSession();
          if (!resumeId) return; // 취소 또는 세션 없음
          await runChat({ resumeId });
        } else {
          await runChat({
            resumeId: typeof options.resume === "string" ? options.resume : undefined,
            continueLatest: options.continue,
          });
        }
      } finally {
        await releaseInstanceLock().catch(() => {});
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
          `${chalk.bold(s.id)}  ${chalk.dim(dateStr)}  ${chalk.cyan(s.meta.provider)}/${s.meta.model ?? "(기본)"}\n`,
        );
        if (s.preview) {
          process.stdout.write(`  ${chalk.italic(`"${s.preview}"`)}`);
          process.stdout.write(`   ${chalk.dim(s.meta.cwd)}\n`);
        } else {
          process.stdout.write(`  ${chalk.dim(s.meta.cwd)}\n`);
        }
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
// mcp 서브커맨드
// ──────────────────────────────────────────────

const mcpCmd = program.command("mcp").description("MCP 서버 관리");

mcpCmd
  .command("list")
  .description("MCP 서버 상태 목록 표시 (이름/상태/툴 수/사유)")
  .action(async () => {
    try {
      await mcpList();
    } catch (err: unknown) {
      handleError(err);
    }
  });

mcpCmd
  .command("test <server>")
  .description("지정한 MCP 서버에 연결해 툴 목록을 출력한다")
  .action(async (server: string) => {
    try {
      await mcpTest(server);
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ──────────────────────────────────────────────
// clean 서브커맨드
// ──────────────────────────────────────────────

program
  .command("clean")
  .description("스테이징 전체 + 오래된 백업(기본: 30일 경과) 정리")
  .option("--all", "날짜 무관 백업 전체 삭제")
  .action(async (opts: { all?: boolean }) => {
    try {
      await runClean(opts);
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ──────────────────────────────────────────────
// update 서브커맨드
// ──────────────────────────────────────────────

program
  .command("update")
  .description("최신 버전으로 업데이트 (npm/pnpm 글로벌 설치)")
  .action(async () => {
    try {
      await runUpdate();
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ──────────────────────────────────────────────
// --resume 선택 UI (TTY 전용)
// ──────────────────────────────────────────────

/**
 * TTY 환경에서 세션 목록을 보여주고 재개할 세션 ID를 반환한다.
 * - 비 TTY: 안내 메시지 후 undefined 반환
 * - 세션 없음: 안내 메시지 후 undefined 반환
 * - 선택 취소(Esc): 조용히 undefined 반환
 */
async function pickSession(): Promise<string | undefined> {
  if (process.stdout.isTTY !== true) {
    process.stdout.write("세션 ID를 지정하세요: kodocagent --resume <id>\n");
    return undefined;
  }

  const sessions = await listSessions();
  if (sessions.length === 0) {
    process.stdout.write(chalk.dim("재개할 세션이 없습니다.\n"));
    return undefined;
  }

  const options = sessions.map((s) => {
    const dateStr = s.mtime.toLocaleString("ko-KR");
    const previewPart = s.preview ? `"${s.preview}"` : "(미리보기 없음)";
    return {
      value: s.id,
      label: `${s.id}  ${dateStr}`,
      hint: previewPart,
    };
  });

  const result = await select({
    message: "재개할 세션을 선택하세요:",
    options,
  });

  if (isCancel(result)) return undefined;
  return String(result);
}

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
  const config = await loadConfig();
  const model = createModel(config);
  const cwd = process.cwd();

  // MCP 초기화 (단발 질의 — 읽기 툴 + MCP)
  const mcpManager = new McpManager();
  {
    const { servers, skipped } = loadMcpConfig(cwd, config);
    for (const s of skipped) {
      mcpManager.addSkipped(s.name, s.reason);
    }
    if (servers.length > 0) {
      await mcpManager.connect(servers);
    }
    // MCP 툴 수 폭증 경고
    for (const w of mcpManager.warnings) {
      process.stdout.write(chalk.yellow(`⚠ ${w}\n`));
    }
  }

  const store = await SessionStore.create({
    cwd,
    provider: config.provider,
    model: config.model ?? "(기본값)",
    createdAt: new Date().toISOString(),
  });
  // 미처리 예외 그물이 이 세션의 스테이징을 정리할 수 있도록 등록
  setActiveSessionId(store.id);

  const tools = new ToolRegistry();
  // 단발 질의(--print)는 읽기 전용 — 승인이 필요한 쓰기(propose_*/write_new_*) 툴은 등록하지 않는다
  for (const tool of createDocTools({ cwd })) {
    const t = tool as import("@kodocagent/core").ToolDefinition<unknown>;
    if (t.requiresApproval) continue;
    tools.register(t);
  }
  // MCP 툴 등록
  for (const mcpTool of mcpManager.getToolDefinitions()) {
    tools.register(mcpTool);
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
    mcpServers: mcpManager.connectedServerNames,
  });

  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    mcpManager.disconnect().catch(() => {});
  });

  for await (const event of session.run(prompt, controller.signal)) {
    if (event.type === "text-delta") {
      process.stdout.write(event.text);
    } else if (event.type === "error") {
      process.stderr.write(chalk.red(`\n오류: ${event.message}\n`));
    }
  }
  process.stdout.write("\n");
  await mcpManager.disconnect();
  // 단발 질의 종료 시 세션 스테이징 정리 (실패는 무시)
  cleanSessionStaging(store.id).catch(() => {});
  setActiveSessionId(null); // 정상 정리 완료 — 그물의 중복 정리 방지
}

program.parse();
