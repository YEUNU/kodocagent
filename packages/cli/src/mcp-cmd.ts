/**
 * MCP 관련 CLI 서브커맨드
 * docs/SPEC.md §8
 *
 * kodocagent mcp list   — 서버 상태 테이블
 * kodocagent mcp test <server>  — 서버 연결 테스트 + 툴 목록
 */

import { loadConfig, loadMcpConfig, McpManager } from "@kodocagent/core";
import chalk from "chalk";

/**
 * `kodocagent mcp list` — 모든 MCP 서버 상태를 테이블로 출력한다.
 */
export async function mcpList(): Promise<void> {
  const config = await loadConfig();
  const cwd = process.cwd();
  const { servers, skipped } = loadMcpConfig(cwd, config);

  const manager = new McpManager();

  // 스킵된 서버 등록
  for (const s of skipped) {
    manager.addSkipped(s.name, s.reason);
  }

  // 연결 가능한 서버에 연결 시도
  if (servers.length > 0) {
    await manager.connect(servers);
  }

  const statuses = manager.status();

  if (statuses.length === 0) {
    process.stdout.write("등록된 MCP 서버가 없습니다.\n");
    await manager.disconnect();
    return;
  }

  // 테이블 헤더
  process.stdout.write(
    chalk.bold("이름".padEnd(20)) +
      chalk.bold("상태".padEnd(12)) +
      chalk.bold("툴 수".padEnd(8)) +
      chalk.bold("사유") +
      "\n",
  );
  process.stdout.write("─".repeat(70) + "\n");

  for (const s of statuses) {
    const stateStr =
      s.state === "connected"
        ? chalk.green("연결됨")
        : s.state === "failed"
          ? chalk.red("실패")
          : chalk.yellow("스킵");

    const toolCount = s.state === "connected" ? String(s.toolCount) : "—";
    const reason = s.reason ?? "";

    process.stdout.write(
      s.name.padEnd(20) +
        stateStr.padEnd(20) + // chalk adds escape codes so pad more
        toolCount.padEnd(8) +
        chalk.dim(reason.slice(0, 50)) +
        "\n",
    );
  }

  if (manager.warnings.length > 0) {
    process.stdout.write("\n");
    for (const w of manager.warnings) {
      process.stdout.write(chalk.yellow(`경고: ${w}\n`));
    }
  }

  await manager.disconnect();
}

/**
 * `kodocagent mcp test <serverName>` — 특정 서버에 연결해 툴 목록을 출력한다.
 */
export async function mcpTest(serverName: string): Promise<void> {
  const config = await loadConfig();
  const cwd = process.cwd();
  const { servers, skipped } = loadMcpConfig(cwd, config);

  // 스킵된 서버 확인
  const isSkipped = skipped.find((s) => s.name === serverName);
  if (isSkipped) {
    process.stderr.write(
      chalk.yellow(`서버 '${serverName}'이(가) 스킵되었습니다: ${isSkipped.reason}\n`),
    );
    return;
  }

  const serverConfig = servers.find((s) => s.name === serverName);
  if (!serverConfig) {
    process.stderr.write(
      chalk.red(
        `서버 '${serverName}'을(를) 찾을 수 없습니다.\n` +
          "'kodocagent mcp list'로 사용 가능한 서버를 확인하세요.\n",
      ),
    );
    return;
  }

  process.stdout.write(chalk.dim(`서버 '${serverName}' 연결 중...\n`));

  const manager = new McpManager();
  await manager.connect([serverConfig]);

  const statuses = manager.status();
  const status = statuses[0];

  if (!status || status.state !== "connected") {
    process.stderr.write(chalk.red(`연결 실패: ${status?.reason ?? "알 수 없는 오류"}\n`));
    await manager.disconnect();
    return;
  }

  process.stdout.write(chalk.green(`연결 성공! 툴 ${status.toolCount}개\n\n`));

  const defs = manager.getToolDefinitions();
  if (defs.length === 0) {
    process.stdout.write("사용 가능한 툴이 없습니다.\n");
  } else {
    process.stdout.write(chalk.bold("툴 목록:\n"));
    for (const def of defs) {
      process.stdout.write(`  ${chalk.cyan(def.name)}\n    ${chalk.dim(def.description)}\n`);
    }
  }

  await manager.disconnect();
}
