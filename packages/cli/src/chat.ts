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
import { isCancel, select, text } from "@clack/prompts";
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
import { cleanSessionStaging, createDocTools } from "@kodocagent/doc-tools";
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

  // MCP 초기화 (chat 시작 시 1회)
  const mcpManager = new McpManager();
  {
    const { servers, skipped } = loadMcpConfig(cwd, config);
    for (const s of skipped) {
      mcpManager.addSkipped(s.name, s.reason);
    }
    if (servers.length > 0) {
      await mcpManager.connect(servers);
    }
    // 실패/스킵 서버 1줄 고지 (CLI prints, core는 출력 안 함)
    for (const s of mcpManager.status()) {
      if (s.state === "failed") {
        process.stdout.write(chalk.dim(`MCP [${s.name}] 연결 실패: ${s.reason ?? ""}\n`));
      } else if (s.state === "skipped") {
        process.stdout.write(chalk.dim(`MCP [${s.name}] 스킵: ${s.reason ?? ""}\n`));
      }
    }
  }

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
        // SIGINT 경로: best-effort 스테이징 정리
        cleanSessionStaging(store.id).catch(() => {});
        mcpManager.disconnect().finally(() => process.exit(0));
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
    // MCP 툴 등록
    for (const mcpTool of mcpManager.getToolDefinitions()) {
      tools.register(mcpTool);
    }

    const session = new AgentSession({
      config,
      model,
      tools,
      approvalHandler: createCliApprovalHandler(),
      store,
      cwd,
      mcpServers: mcpManager.connectedServerNames,
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
          // 툴콜은 핵심 인자 포함 dim 1줄 표시
          process.stdout.write(chalk.dim(`\n⚙ ${formatToolCall(event.toolName, event.args)}\n`));
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
  // 정상 종료 (/exit, EOF): 세션 스테이징 정리 (실패는 무시)
  cleanSessionStaging(store.id).catch(() => {});
  await mcpManager.disconnect();
}

/**
 * 툴콜 표시 문자열 생성.
 * - mcp__ 툴: "서버명__툴명" 형태로 압축
 * - 나머지: path/dir/pathA 등 첫 번째 path류 인자 또는 첫 string 값을 괄호 안에 표시
 * - 50자 초과 시 말줄임 처리
 */
function formatToolCall(toolName: string, args: unknown): string {
  const MAX_LEN = 50;

  // mcp__ 툴: "mcp__서버__툴" → 서버/툴명만 표시
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const display = parts.slice(1).join("__"); // 서버__툴명
    return display.length > MAX_LEN ? `${display.slice(0, MAX_LEN)}…` : display;
  }

  // 인자에서 핵심 값 추출
  let keyArg = "";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const argsObj = args as Record<string, unknown>;
    // path류 키 우선 탐색
    const pathKeys = ["path", "dir", "pathA", "pathB", "filePath", "target"];
    for (const key of pathKeys) {
      const val = argsObj[key];
      if (typeof val === "string" && val) {
        // 긴 경로면 basename만 사용
        const short =
          val.includes("/") || val.includes("\\") ? (val.split(/[/\\]/).pop() ?? val) : val;
        keyArg = short;
        break;
      }
    }
    // path류 없으면 첫 번째 string 값
    if (!keyArg) {
      for (const val of Object.values(argsObj)) {
        if (typeof val === "string" && val) {
          keyArg = val;
          break;
        }
      }
    }
  }

  const argPart = keyArg ? `(${keyArg})` : "";
  const full = `${toolName}${argPart}`;
  return full.length > MAX_LEN ? `${full.slice(0, MAX_LEN)}…` : full;
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
async function handleModelSwitch(_config: KodocConfig): Promise<{ config: KodocConfig } | null> {
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
    const customInput = await text({
      message: "모델 ID를 입력하세요 (예: anthropic/claude-opus-4-8 또는 프로바이더:모델ID):",
      placeholder: "provider:model-id",
      validate(value) {
        if (!value?.trim()) return "모델 ID를 입력해야 합니다.";
        return undefined;
      },
    });

    if (isCancel(customInput) || !customInput) return null;

    const modelInput = String(customInput).trim();
    if (!modelInput) return null;

    // "provider:modelId" 형태이면 분리, 아니면 현재 provider 유지
    let provider = loadedConfig.provider as KodocConfig["provider"];
    let modelId: string;

    if (modelInput.includes(":")) {
      const colonIdx = modelInput.indexOf(":");
      provider = modelInput.slice(0, colonIdx) as KodocConfig["provider"];
      modelId = modelInput.slice(colonIdx + 1);
    } else {
      modelId = modelInput;
    }

    if (!modelId) return null;

    // KNOWN_MODELS에 없는 경우 안내
    const knownForProvider = KNOWN_MODELS[provider as keyof typeof KNOWN_MODELS] ?? [];
    const isKnown = (knownForProvider as readonly string[]).includes(modelId);
    if (!isKnown) {
      process.stdout.write(
        chalk.dim("등록되지 않은 모델 ID입니다 — 프로바이더가 지원하는지 확인하세요\n"),
      );
    }

    const newConfig = { ...loadedConfig };
    newConfig.provider = provider;
    newConfig.model = modelId;
    await saveConfig(newConfig);

    return { config: newConfig };
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
