/**
 * onboarding.needsOnboarding() 단위 테스트
 *
 * 격리: vitest.setup.ts가 KODOCAGENT_HOME을 임시 디렉터리로 강제한다.
 *
 * 회귀 방지 대상:
 * - config.json이 없으면 온보딩 필요(true)
 * - config.json이 있으면 온보딩 불필요(false)
 *   (runOnboarding은 clack 인터랙티브 — 비대화형 테스트에서 제외)
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { KODOC_PATHS } from "@kodocagent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsOnboarding } from "./onboarding.js";

async function removeConfig() {
  await rm(KODOC_PATHS.config, { force: true });
}

beforeEach(removeConfig);
afterEach(removeConfig);

describe("needsOnboarding", () => {
  it("config.json이 없으면 true(온보딩 필요)", () => {
    expect(needsOnboarding()).toBe(true);
  });

  it("config.json이 있으면 false(온보딩 불필요)", async () => {
    await mkdir(dirname(KODOC_PATHS.config), { recursive: true });
    await writeFile(KODOC_PATHS.config, JSON.stringify({ version: 1 }), "utf-8");
    expect(needsOnboarding()).toBe(false);
  });
});
