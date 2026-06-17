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
import { isCancel, select, spinner, text } from "@clack/prompts";
import {
  AgentSession,
  createModel,
  listSessions,
  loadConfig,
  loadMcpConfig,
  McpManager,
  SessionStore,
  saveConfig as saveConfigCore,
  ToolRegistry,
} from "@kodocagent/core";
import { cleanSessionStaging, createDocTools } from "@kodocagent/doc-tools";
import type { KodocConfig } from "@kodocagent/shared";
import { KNOWN_MODELS, resolveApiKey } from "@kodocagent/shared";
import chalk from "chalk";
import { createCliApprovalHandler } from "./approve.js";

/** 슬래시 커맨드 도움말 */
const HELP_TEXT = `
할 수 있는 일:
  • 문서 읽기·요약·검토 — .hwp/.hwpx/.docx/.xlsx/.pdf (예: "이 보도자료 요약해줘")
  • 표·양식 수정 — 셀 값, 양식 빈칸, 행·열 추가/삭제 (예: "이 표의 금액을 30000으로 고쳐줘")
  • 문서 전체 찾기·바꾸기 (예: "'국민주권'을 '국민중심'으로 다 바꿔줘")
  • 되돌리기 — 직전 변경을 백업으로 복원 (예: "방금 수정 되돌려줘")
  • 한국 법령 기반 검토 (예: "이 취업규칙이 근로기준법에 맞는지 봐줘")
  ※ .hwp는 한글에서 .hwpx로 저장한 후 수정할 수 있습니다.

슬래시 명령:
  /model   — 프로바이더/모델 전환
  /context — 현재 컨텍스트 사용량 표시
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
      const connectMsg = "MCP 서버 연결 중… (최초 실행 시 서버 다운로드로 시간이 걸릴 수 있습니다)";
      // TTY에서만 clack 스피너 사용 — 비 TTY(파이프/리디렉션)에서는 raw-mode 진입이
      // stdin(readline 입력)을 가로채고 이스케이프 코드를 도배하므로 평문 메시지로 대체.
      if (process.stdout.isTTY === true) {
        const s = spinner();
        s.start(connectMsg);
        await mcpManager.connect(servers);
        const okCount = mcpManager.connectedServerNames.length;
        s.stop(okCount > 0 ? `MCP 서버 ${okCount}개 연결됨` : "MCP 연결 완료");
      } else {
        process.stdout.write(chalk.dim(`${connectMsg}\n`));
        await mcpManager.connect(servers);
        const okCount = mcpManager.connectedServerNames.length;
        process.stdout.write(
          chalk.dim(`${okCount > 0 ? `MCP 서버 ${okCount}개 연결됨` : "MCP 연결 완료"}\n`),
        );
      }
    }
    // 실패/스킵 서버 1줄 고지 (CLI prints, core는 출력 안 함)
    for (const s of mcpManager.status()) {
      if (s.state === "failed") {
        process.stdout.write(chalk.dim(`MCP [${s.name}] 연결 실패: ${s.reason ?? ""}\n`));
      } else if (s.state === "skipped") {
        process.stdout.write(chalk.dim(`MCP [${s.name}] 스킵: ${s.reason ?? ""}\n`));
      }
    }
    // MCP 툴 수 폭증 경고 (isTTY 분기와 무관하게 연결 완료 후 1회 출력)
    for (const w of mcpManager.warnings) {
      process.stdout.write(chalk.yellow(`⚠ ${w}\n`));
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
  // 마지막 턴의 실제 입력(컨텍스트) 토큰 — 푸터 및 /context 표시용
  let lastContextTokens = 0;
  // 턴 루프 바깥에서도 스피너 정리가 가능하도록 레퍼런스 유지
  let sharedActiveInterval: ReturnType<typeof setInterval> | null = null;

  function clearSharedSpinner(): void {
    if (!sharedActiveInterval) return;
    clearInterval(sharedActiveInterval);
    sharedActiveInterval = null;
    if (process.stdout.isTTY) {
      // 80열 공백으로 덮어쓰기
      process.stdout.write(`\r${" ".repeat(80)}\r`);
    }
  }

  // Ctrl+C 핸들러
  rl.on("SIGINT", () => {
    if (currentController) {
      // 현재 턴 중단 — 스피너도 함께 정리
      clearSharedSpinner();
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
  process.stdout.write(
    chalk.dim(
      "문서를 읽고 표·양식 수정, 찾기·바꾸기, 되돌리기까지 자연어로 요청하세요. " +
        '예: "이 표의 합계를 다시 계산해줘", "방금 수정 되돌려줘". 자세히: /help\n',
    ),
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
      if (trimmed.toLowerCase() === "/context") {
        printContextUsage(lastContextTokens, config.maxContextTokens);
        continue;
      }
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

    // 툴 인터벌 스피너 상태 (턴 단위)
    const isTTY = process.stdout.isTTY === true;
    const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let activeToolLabel = "";
    let activeToolStartMs = 0;
    let spinnerFrameIdx = 0;
    // 스피너가 마지막으로 쓴 라인의 가시 문자 수(라인 클리어용)
    let lastSpinnerWidth = 0;

    /** 현재 활성 인터벌 스피너를 정지하고 라인을 클리어한다 */
    function clearActiveSpinner(): void {
      if (!sharedActiveInterval) return;
      clearInterval(sharedActiveInterval);
      sharedActiveInterval = null;
      if (isTTY) {
        // 스피너 줄 전체 지우기 (lastSpinnerWidth 또는 안전하게 80)
        const clearLen = lastSpinnerWidth > 0 ? lastSpinnerWidth : 80;
        process.stdout.write(`\r${" ".repeat(clearLen)}\r`);
      }
      lastSpinnerWidth = 0;
    }

    try {
      let hasOutput = false;
      for await (const event of session.run(trimmed, currentController.signal)) {
        if (event.type === "text-delta") {
          // text-delta 전에 혹시 스피너가 살아있으면 정리
          clearActiveSpinner();
          process.stdout.write(event.text);
          hasOutput = true;
        } else if (event.type === "tool-call") {
          // 툴콜은 핵심 인자 포함 dim 1줄 표시
          process.stdout.write(chalk.dim(`\n⚙ ${formatToolCall(event.toolName, event.args)}\n`));

          if (isTTY) {
            // 이전 스피너 정리 후 새 스피너 시작
            clearActiveSpinner();
            activeToolLabel = formatToolCall(event.toolName, event.args);
            activeToolStartMs = Date.now();
            spinnerFrameIdx = 0;

            sharedActiveInterval = setInterval(() => {
              const frame = SPINNER_FRAMES[spinnerFrameIdx % SPINNER_FRAMES.length] ?? "⠋";
              spinnerFrameIdx++;
              const plainText = `${frame} ${activeToolLabel} 실행 중…`;
              process.stdout.write(`\r${chalk.dim(plainText)}`);
              // 가시 문자 너비는 평문 기준 (+1 은 \r 포함)
              lastSpinnerWidth = plainText.length + 1;
            }, 80);
          }
        } else if (event.type === "tool-result") {
          // 스피너 정지 후 완료/실패 한 줄 표시
          const elapsedMs = Date.now() - activeToolStartMs;
          const elapsedSec = (elapsedMs / 1000).toFixed(1);
          clearActiveSpinner();

          const statusLabel = event.isError ? "실패" : "완료";
          process.stdout.write(
            chalk.dim(`  └ ${activeToolLabel} ${statusLabel} (${elapsedSec}s)\n`),
          );
        } else if (event.type === "approval-required") {
          // 렌더링은 createCliApprovalHandler가 이미 처리함 (이벤트 수신 로그용)
        } else if (event.type === "turn-complete") {
          if (event.usage) {
            // 실제 입력 토큰 = 그 턴에 모델로 간 전체 컨텍스트 (가장 정확한 사용량)
            lastContextTokens = event.usage.inputTokens;
            process.stdout.write(
              `\n${formatContextUsage(event.usage.inputTokens, config.maxContextTokens)}  ${chalk.dim(
                `출력 ${event.usage.outputTokens} 토큰`,
              )}\n`,
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
      // 턴 종료 시 잔여 스피너 반드시 정리
      clearActiveSpinner();
      currentController = null;
    }
  }

  rl.close();
  // 정상 종료 (/exit, EOF): 세션 스테이징 정리 후 연결 종료
  await cleanSessionStaging(store.id).catch(() => {});
  await mcpManager.disconnect();
  // stdio MCP 서버(npx 자식 프로세스)가 이벤트 루프를 붙잡아 종료가 지연되는 경우가 있어
  // 정리 완료 후 명시적으로 프로세스를 종료한다 (SIGINT 경로와 동일 정책).
  process.exit(0);
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

/** 컨텍스트 사용량을 "컨텍스트: 45.2k / 120k 토큰 (38%)" 형태로 색상 포함 렌더한다. */
function formatContextUsage(used: number, budget: number): string {
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
  const text = `컨텍스트: ${fmt(used)} / ${fmt(budget)} 토큰 (${pct}%)`;
  // 예산 근접 시 색으로 경고 (90%+ 빨강, 70%+ 노랑, 그 외 dim)
  if (pct >= 90) return chalk.red(text);
  if (pct >= 70) return chalk.yellow(text);
  return chalk.dim(text);
}

/** /context 명령 — 현재 컨텍스트 사용량을 출력한다. */
function printContextUsage(used: number, budget: number): void {
  if (used <= 0) {
    process.stdout.write(
      chalk.dim("아직 측정된 컨텍스트가 없습니다 — 대화를 시작하면 표시됩니다.\n"),
    );
    return;
  }
  process.stdout.write(`${formatContextUsage(used, budget)}\n`);
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
      message: "모델 ID를 입력하세요 (예: anthropic/claude-sonnet-4-6 또는 프로바이더:모델ID):",
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
  await saveConfigCore(config);
}
