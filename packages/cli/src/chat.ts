/**
 * 대화형 채팅 REPL
 * docs/SPEC.md §8
 *
 * - node:readline로 입력 읽기
 * - AgentSession.run()으로 스트리밍 처리
 * - text-delta를 stdout에 직접 출력
 * - 툴콜은 dim 1줄 표시
 * - /model, /clear, /help, /exit 슬래시 명령
 * - Ctrl+C: 현재 턴 중단 / 두 번째 Ctrl+C: 종료
 */
import * as readline from "node:readline/promises";
import { isCancel, select } from "@clack/prompts";
import {
  AgentSession,
  createModel,
  listSessions,
  loadConfig,
  SessionStore,
  ToolRegistry,
} from "@kodocagent/core";
import { createDocTools } from "@kodocagent/doc-tools";
import type { KodocConfig } from "@kodocagent/shared";
import { KNOWN_MODELS, resolveApiKey } from "@kodocagent/shared";
import chalk from "chalk";
import { createCliApprovalHandler } from "./approve.js";

/** 슬래시 커맨드 도움말 */
const HELP_TEXT = `
슬래시 명령:
  /model   — 프로바이더/모델 전환
  /clear   — 새 세션 시작
  /help    — 이 도움말 표시
  /exit    — 종료

단축키:
  Ctrl+C   — 현재 턴 중단 (채팅 유지)
  Ctrl+C×2 — 종료
`.trim();

/**
 * 채팅 REPL 진입점
 */
export async function runChat(opts: {
  resumeId?: string;
  continueLatest?: boolean;
}): Promise<void> {
  // Windows UTF-8 설정
  if (process.platform === "win32") {
    try {
      (process.stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding("utf8");
    } catch {
      // ignore
    }
  }

  let config = await loadConfig();
  const cwd = process.cwd();

  // 세션 로드 또는 신규 생성
  let store: SessionStore;
  if (opts.resumeId) {
    store = await SessionStore.load(opts.resumeId);
    process.stdout.write(chalk.dim(`세션 재개: ${opts.resumeId}\n`));
  } else if (opts.continueLatest) {
    const sessions = await listSessions();
    const latest = sessions[0];
    if (!latest) {
      process.stdout.write(chalk.dim("이전 세션이 없습니다. 새 세션을 시작합니다.\n"));
      store = await createNewStore(config, cwd);
    } else {
      store = await SessionStore.load(latest.id);
      process.stdout.write(chalk.dim(`이전 세션 재개: ${latest.id}\n`));
    }
  } else {
    store = await createNewStore(config, cwd);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let ctrlCCount = 0;
  let currentController: AbortController | null = null;

  // Ctrl+C 핸들러
  rl.on("SIGINT", () => {
    if (currentController) {
      // 현재 턴 중단
      currentController.abort();
      currentController = null;
      process.stdout.write(chalk.yellow("\n현재 응답이 중단되었습니다.\n"));
      ctrlCCount = 0;
    } else {
      ctrlCCount++;
      if (ctrlCCount >= 2) {
        process.stdout.write(chalk.yellow("\n종료합니다.\n"));
        rl.close();
        process.exit(0);
      } else {
        process.stdout.write(chalk.dim("\n(한 번 더 Ctrl+C를 누르면 종료됩니다)\n"));
      }
    }
  });

  process.stdout.write(chalk.bold(`kodocagent 채팅 시작 (/help로 도움말)\n`));
  process.stdout.write(
    chalk.dim(`프로바이더: ${config.provider}, 모델: ${config.model ?? "(기본값)"}\n\n`),
  );

  while (true) {
    let userInput: string;
    try {
      userInput = await rl.question(chalk.green("You: "));
    } catch {
      // readline 종료 (Ctrl+D 등)
      break;
    }

    ctrlCCount = 0;
    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // 슬래시 명령 처리
    if (trimmed.startsWith("/")) {
      const handled = await handleSlashCommand(trimmed, config, store, cwd, rl);
      if (handled === "exit") break;
      if (handled === "new-session") {
        store = await createNewStore(config, cwd);
        process.stdout.write(chalk.dim("새 세션이 시작되었습니다.\n"));
      } else if (handled && typeof handled === "object" && "config" in handled) {
        config = (handled as { config: KodocConfig }).config;
        process.stdout.write(
          chalk.dim(`모델 전환: ${config.provider} / ${config.model ?? "(기본값)"}\n`),
        );
      }
      continue;
    }

    // 에이전트 실행
    config = await loadConfig(); // 최신 설정 반영
    let model: ReturnType<typeof createModel>;
    try {
      model = createModel(config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(chalk.red(`오류: ${msg}\n`));
      continue;
    }

    const tools = new ToolRegistry();
    for (const tool of createDocTools({ cwd })) {
      tools.register(tool as import("@kodocagent/core").ToolDefinition<unknown>);
    }

    const session = new AgentSession({
      config,
      model,
      tools,
      approvalHandler: createCliApprovalHandler(),
      store,
      cwd,
    });

    // 이전 메시지 로드 (재개 시)
    await session.loadHistory();

    currentController = new AbortController();
    process.stdout.write(chalk.bold("Assistant: "));

    try {
      let hasOutput = false;
      for await (const event of session.run(trimmed, currentController.signal)) {
        if (event.type === "text-delta") {
          process.stdout.write(event.text);
          hasOutput = true;
        } else if (event.type === "tool-call") {
          // 툴콜은 dim 1줄 표시
          const argsPreview = JSON.stringify(event.args).slice(0, 60);
          process.stdout.write(chalk.dim(`\n⚙ ${event.toolName}(${argsPreview})\n`));
        } else if (event.type === "tool-result") {
          // 툴 결과는 생략 (모델에게 전달됨)
        } else if (event.type === "approval-required") {
          // 렌더링은 createCliApprovalHandler가 이미 처리함 (이벤트 수신 로그용)
        } else if (event.type === "turn-complete") {
          if (event.usage) {
            process.stdout.write(
              chalk.dim(
                `\n[입력 ${event.usage.inputTokens} 토큰 / 출력 ${event.usage.outputTokens} 토큰]\n`,
              ),
            );
          }
        } else if (event.type === "error") {
          process.stderr.write(chalk.red(`\n오류: ${event.message}\n`));
        }
      }
      if (hasOutput) {
        process.stdout.write("\n");
      }
    } finally {
      currentController = null;
    }
  }

  rl.close();
}

/** 새 세션 스토어 생성 */
async function createNewStore(config: KodocConfig, cwd: string): Promise<SessionStore> {
  return SessionStore.create({
    cwd,
    provider: config.provider,
    model: config.model ?? "(기본값)",
    createdAt: new Date().toISOString(),
  });
}

/** 슬래시 명령 처리 — 반환값으로 후속 동작 전달 */
async function handleSlashCommand(
  cmd: string,
  config: KodocConfig,
  _store: SessionStore,
  _cwd: string,
  rl: readline.Interface,
): Promise<"exit" | "new-session" | { config: KodocConfig } | null> {
  const parts = cmd.split(/\s+/);
  const command = parts[0]?.toLowerCase();

  switch (command) {
    case "/exit":
    case "/quit":
      process.stdout.write(chalk.yellow("종료합니다.\n"));
      rl.close();
      return "exit";

    case "/help":
      process.stdout.write(HELP_TEXT + "\n\n");
      return null;

    case "/clear":
      return "new-session";

    case "/model":
      return handleModelSwitch(config);

    default:
      process.stdout.write(chalk.yellow(`알 수 없는 명령: ${cmd}. /help로 도움말을 확인하세요.\n`));
      return null;
  }
}

/** /model 명령 처리 */
async function handleModelSwitch(config: KodocConfig): Promise<{ config: KodocConfig } | null> {
  // API 키가 있는 프로바이더만 표시
  type ProviderOption = { value: string; label: string; hint?: string };
  const options: ProviderOption[] = [];
  const loadedConfig = await loadConfig();

  for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
    const hasKey = !!resolveApiKey(loadedConfig, provider as import("@kodocagent/shared").Provider);
    if (!hasKey) continue;

    for (const modelId of models) {
      options.push({
        value: `${provider}:${modelId}`,
        label: `${provider} / ${modelId}`,
        hint: provider,
      });
    }
  }

  // 커스텀 입력 옵션
  options.push({ value: "__custom__", label: "직접 입력..." });

  if (options.length <= 1) {
    process.stdout.write(
      chalk.yellow("API 키가 설정된 프로바이더가 없습니다. 먼저 키를 설정하세요.\n"),
    );
    return null;
  }

  const result = await select({
    message: "프로바이더 / 모델을 선택하세요:",
    options,
  });

  if (isCancel(result)) return null;

  const selected = String(result);
  if (selected === "__custom__") {
    // TODO: readline으로 커스텀 입력 받기 — M1에서는 간단히 처리
    process.stdout.write(chalk.dim("커스텀 모델 입력은 config set 명령을 사용하세요.\n"));
    return null;
  }

  const [provider, modelId] = selected.split(":");
  if (!provider || !modelId) return null;

  const newConfig = { ...loadedConfig };
  newConfig.provider = provider as KodocConfig["provider"];
  newConfig.model = modelId;
  await saveConfig(newConfig);

  return { config: newConfig };
}

// saveConfig import (config-cmd에서 재사용)
async function saveConfig(config: KodocConfig): Promise<void> {
  const { saveConfig: sc } = await import("@kodocagent/core");
  await sc(config);
}
