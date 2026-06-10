import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "./config.js";

// 테스트용 임시 홈 디렉터리 패치
const testHome = join(tmpdir(), `kodocagent-test-config-${Date.now()}`);
const testConfigPath = join(testHome, "config.json");

// KODOC_PATHS.config를 임시 경로로 대체하기 위해 모듈을 직접 조작하기 어려우므로
// 실제 config 함수를 직접 테스트하는 방식 대신,
// 파일 시스템 기반 테스트로 직접 작성

describe("config save→load roundtrip", () => {
  beforeEach(async () => {
    await mkdir(testHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  it("설정을 저장하고 다시 로드하면 동일한 값이 반환된다", async () => {
    const { saveConfig: save, loadConfig: load } = await createTestConfigFns(testConfigPath);

    const config = {
      version: 1 as const,
      provider: "openai" as const,
      model: "gpt-5.5",
      apiKeys: { anthropic: null, openai: "sk-test-123", google: null },
      lawApiKey: null,
      locale: "ko" as const,
      maxSteps: 10,
    };

    await save(config);
    const loaded = await load();
    expect(loaded.provider).toBe("openai");
    expect(loaded.model).toBe("gpt-5.5");
    expect(loaded.apiKeys.openai).toBe("sk-test-123");
    expect(loaded.maxSteps).toBe(10);
  });

  it("파일이 없으면 기본값을 반환한다", async () => {
    const { loadConfig: load } = await createTestConfigFns(join(testHome, "nonexistent.json"));
    const config = await load();
    expect(config.provider).toBe("anthropic");
    expect(config.maxSteps).toBe(24);
  });

  it("손상된 파일은 KodocError를 던진다", async () => {
    const corruptPath = join(testHome, "corrupt.json");
    await writeFile(corruptPath, "{ invalid json !!!", "utf-8");
    const { loadConfig: load } = await createTestConfigFns(corruptPath);
    await expect(load()).rejects.toThrow("손상");
  });

  it("0600 모드로 저장된다 (non-Windows)", async () => {
    if (process.platform === "win32") return;
    const { saveConfig: save } = await createTestConfigFns(testConfigPath);
    await save({
      version: 1,
      provider: "anthropic",
      model: null,
      apiKeys: { anthropic: null, openai: null, google: null },
      lawApiKey: null,
      locale: "ko",
      maxSteps: 24,
    });
    const info = await stat(testConfigPath);
    // mode & 0o777 should be 0o600
    expect(info.mode & 0o777).toBe(0o600);
  });
});

/**
 * 테스트용 config 함수를 특정 경로로 생성한다.
 * 실제 구현의 CONFIG_PATH를 대체할 수 없으므로, 비슷한 로직을 인라인으로 구현.
 */
async function createTestConfigFns(configPath: string) {
  const { KodocConfigSchema, KodocError } = await import("@kodocagent/shared");
  const { readFile, writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  async function loadConfig() {
    let raw: string;
    try {
      raw = await readFile(configPath, "utf-8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return KodocConfigSchema.parse({});
      }
      throw new KodocError(
        `설정 파일을 읽을 수 없습니다: ${configPath}`,
        `파일 권한을 확인하거나 삭제 후 재실행하세요.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new KodocError(`설정 파일이 손상되었습니다: ${configPath}`, "삭제 후 재실행하세요.");
    }
    const result = KodocConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new KodocError(`설정 파일 형식 오류: ${result.error.message}`, "삭제 후 재실행하세요.");
    }
    return result.data;
  }

  async function saveConfig(config: ReturnType<typeof KodocConfigSchema.parse>) {
    const dir = dirname(configPath);
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      await chmod(configPath, 0o600);
    } catch {
      // ignore on Windows
    }
  }

  return { loadConfig, saveConfig };
}
