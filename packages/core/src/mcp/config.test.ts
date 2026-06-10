/**
 * MCP 설정 로드 단위 테스트
 * docs/SPEC.md §11
 *
 * 검증 항목:
 * - 사용자 파일 없으면 기본 번들(korean-law) 적용
 * - 프로젝트 설정이 사용자 설정을 서버명 단위로 덮어씀
 * - ${VAR} 치환: process.env 우선, lawApiKey 폴백
 * - 미설정 변수 → skipped 목록
 * - disabled=true → skipped
 * - allowedTools 필터링 로직
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KodocConfig } from "@kodocagent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "./config.js";

// 기본 빈 KodocConfig
function makeConfig(overrides: Partial<KodocConfig> = {}): KodocConfig {
  return {
    version: 1,
    provider: "anthropic",
    model: null,
    apiKeys: { anthropic: null, openai: null, google: null },
    lawApiKey: null,
    locale: "ko",
    maxSteps: 24,
    ...overrides,
  };
}

let tmpDir: string;
let userConfigPath: string;
let projectConfigPath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  tmpDir = join(tmpdir(), `kodocagent-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  userConfigPath = join(tmpDir, "user-mcp.json");
  projectConfigPath = join(tmpDir, "project-mcp.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // 환경변수 복원
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

describe("기본 번들 — 사용자 파일 없을 때", () => {
  it("LAW_OC가 없으면 korean-law가 skipped 목록에 포함된다", () => {
    delete process.env.LAW_OC;
    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });
    expect(result.servers).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("korean-law");
    expect(result.skipped[0]?.reason).toMatch(/LAW_OC/);
  });

  it("LAW_OC 환경변수가 있으면 korean-law가 servers에 포함된다", () => {
    process.env.LAW_OC = "test-key-env";
    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("korean-law");
    expect(result.servers[0]?.type).toBe("stdio");
    expect(result.skipped).toHaveLength(0);
  });

  it("config.lawApiKey로 LAW_OC를 해소한다", () => {
    delete process.env.LAW_OC;
    const result = loadMcpConfig(tmpDir, makeConfig({ lawApiKey: "cfg-law-key" }), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("korean-law");
    if (result.servers[0]?.type === "stdio") {
      expect(result.servers[0].env?.LAW_OC).toBe("cfg-law-key");
    }
  });

  it("LAW_OC 환경변수가 config.lawApiKey보다 우선한다", () => {
    process.env.LAW_OC = "env-wins";
    const result = loadMcpConfig(tmpDir, makeConfig({ lawApiKey: "config-loses" }), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });
    expect(result.servers[0]?.type === "stdio" && result.servers[0].env?.LAW_OC).toBe("env-wins");
  });
});

describe("사용자 + 프로젝트 파일 병합", () => {
  it("프로젝트 설정이 사용자 설정을 서버명 단위로 덮어쓴다", () => {
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          "server-a": { command: "cmd-a" },
          "server-b": { command: "cmd-b" },
        },
      }),
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          "server-b": { command: "cmd-b-overridden" },
          "server-c": { command: "cmd-c" },
        },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });

    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["server-a", "server-b", "server-c"]);
    const serverB = result.servers.find((s) => s.name === "server-b");
    expect(serverB?.type === "stdio" && serverB.command).toBe("cmd-b-overridden");
  });

  it("프로젝트 파일이 없으면 사용자 파일만 사용된다", () => {
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: { "only-user": { command: "some-cmd" } },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath, // 존재하지 않음
    });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("only-user");
  });
});

describe("${VAR} 치환", () => {
  it("env 값의 ${VAR}를 process.env에서 치환한다", () => {
    process.env.MY_TOKEN = "tok-123";
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          "my-server": { command: "cmd", env: { TOKEN: "${MY_TOKEN}" } },
        },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });

    expect(result.servers).toHaveLength(1);
    const srv = result.servers[0];
    expect(srv?.type === "stdio" && srv.env?.TOKEN).toBe("tok-123");
  });

  it("해석 불가 변수 → 해당 서버 skipped", () => {
    delete process.env.MISSING_VAR;
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          "missing-var-server": {
            command: "cmd",
            env: { SOME_KEY: "${MISSING_VAR}" },
          },
          "fine-server": { command: "cmd2" },
        },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });

    expect(result.servers.map((s) => s.name)).toEqual(["fine-server"]);
    expect(result.skipped[0]?.name).toBe("missing-var-server");
    expect(result.skipped[0]?.reason).toMatch(/MISSING_VAR/);
  });

  it("HTTP 서버 headers의 ${VAR}도 치환한다", () => {
    process.env.API_KEY = "http-key";
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          "http-server": {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${API_KEY}" },
          },
        },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });

    expect(result.servers).toHaveLength(1);
    const srv = result.servers[0];
    expect(srv?.type === "http" && srv.headers?.Authorization).toBe("Bearer http-key");
  });
});

describe("disabled + allowedTools", () => {
  it("disabled=true 서버는 skipped된다", () => {
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          "off-server": { command: "cmd", disabled: true },
          "on-server": { command: "cmd2" },
        },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });

    expect(result.servers.map((s) => s.name)).toEqual(["on-server"]);
    expect(result.skipped.find((s) => s.name === "off-server")).toBeTruthy();
  });

  it("allowedTools 목록이 servers에 전달된다", () => {
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          "filtered-server": {
            command: "cmd",
            allowedTools: ["tool1", "tool2"],
          },
        },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });

    expect(result.servers[0]?.allowedTools).toEqual(["tool1", "tool2"]);
  });

  it("allowedTools=null은 전체 허용을 의미한다", () => {
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          "all-tools": { command: "cmd", allowedTools: null },
        },
      }),
    );

    const result = loadMcpConfig(tmpDir, makeConfig(), {
      userConfig: userConfigPath,
      projectConfig: projectConfigPath,
    });

    expect(result.servers[0]?.allowedTools).toBeNull();
  });
});
