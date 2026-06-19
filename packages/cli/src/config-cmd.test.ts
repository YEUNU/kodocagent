/**
 * config-cmd 단위 테스트 — configSet / configShow
 *
 * 격리: vitest.setup.ts가 KODOCAGENT_HOME을 임시 디렉터리로 강제하므로
 * loadConfig/saveConfig가 실제 ~/.kodocagent 대신 임시 홈을 사용한다.
 * 각 테스트 사이 config.json을 비워 상태를 초기화한다.
 *
 * 회귀 방지 대상:
 * - 알 수 없는 키/프로바이더/범위 밖 숫자 → KodocError(친절 hint 포함)
 * - 유효 set은 디스크에 저장되어 다시 로드된다(roundtrip)
 * - configShow는 API 키를 앞 6자+"..."로 마스킹(평문 노출 금지)
 */
import { rm } from "node:fs/promises";
import { loadConfig } from "@kodocagent/core";
import { KODOC_PATHS, type KodocError } from "@kodocagent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSet, configShow } from "./config-cmd.js";

async function resetConfig() {
  await rm(KODOC_PATHS.config, { force: true });
}

beforeEach(resetConfig);
afterEach(resetConfig);

function captureStdout(): { restore: () => void; output: () => string } {
  let buf = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    });
  return { restore: () => spy.mockRestore(), output: () => buf };
}

describe("configSet — 검증", () => {
  it("알 수 없는 키는 KodocError + 사용 가능한 키 목록 hint", async () => {
    const cap = captureStdout();
    try {
      await expect(configSet("nonsense", "x")).rejects.toMatchObject({
        name: "KodocError",
      });
      await configSet("nonsense", "x").catch((e: KodocError) => {
        expect(e.hint).toContain("provider");
      });
    } finally {
      cap.restore();
    }
  });

  it("알 수 없는 프로바이더는 거부한다", async () => {
    await expect(configSet("provider", "azure")).rejects.toThrow(/알 수 없는 프로바이더/);
  });

  it("max-steps 범위 밖(0, 101)은 거부한다", async () => {
    await expect(configSet("max-steps", "0")).rejects.toThrow(/1~100/);
    await expect(configSet("max-steps", "101")).rejects.toThrow(/1~100/);
    await expect(configSet("max-steps", "abc")).rejects.toThrow(/1~100/);
  });

  it("max-context-tokens 범위 밖은 거부한다", async () => {
    await expect(configSet("max-context-tokens", "5000")).rejects.toThrow(/10000~2000000/);
    await expect(configSet("max-context-tokens", "9999999")).rejects.toThrow(/10000~2000000/);
  });
});

describe("configSet — 저장 roundtrip", () => {
  it("provider를 저장하면 디스크에서 다시 읽힌다", async () => {
    const cap = captureStdout();
    try {
      await configSet("provider", "openai");
    } finally {
      cap.restore();
    }
    const cfg = await loadConfig();
    expect(cfg.provider).toBe("openai");
    expect(cap.output()).toContain("저장되었습니다");
  });

  it("api-key.anthropic / law-key / model / max-steps를 저장한다", async () => {
    const cap = captureStdout();
    try {
      await configSet("api-key.anthropic", "sk-ant-secret-123456");
      await configSet("law-key", "law-oc-key");
      await configSet("model", "claude-opus-4-8");
      await configSet("max-steps", "30");
    } finally {
      cap.restore();
    }
    const cfg = await loadConfig();
    expect(cfg.apiKeys.anthropic).toBe("sk-ant-secret-123456");
    expect(cfg.lawApiKey).toBe("law-oc-key");
    expect(cfg.model).toBe("claude-opus-4-8");
    expect(cfg.maxSteps).toBe(30);
  });
});

describe("configShow — 마스킹", () => {
  it("API 키는 앞 6자 + '...'로 마스킹되고 평문 전체는 노출되지 않는다", async () => {
    {
      const cap = captureStdout();
      try {
        await configSet("api-key.anthropic", "sk-ant-supersecretvalue");
      } finally {
        cap.restore();
      }
    }
    const cap = captureStdout();
    try {
      await configShow();
    } finally {
      cap.restore();
    }
    const out = cap.output();
    expect(out).toContain("sk-ant..."); // 앞 6자 + ...
    expect(out).not.toContain("supersecretvalue"); // 평문 미노출
  });

  it("미설정 키는 (미설정)으로 표시한다", async () => {
    const cap = captureStdout();
    try {
      await configShow();
    } finally {
      cap.restore();
    }
    const out = cap.output();
    expect(out).toContain("api-key.openai:");
    expect(out).toContain("(미설정)");
  });
});
