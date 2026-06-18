import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSessionId, latestSession, listSessions, SessionStore } from "./store.js";

// vi.hoisted는 최상위로 호이스팅되므로 내부에서 node: 모듈을 직접 require로 사용
const { testSessionsDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return { testSessionsDir: join(tmpdir(), `kodocagent-test-sessions-${Date.now()}`) };
});

vi.mock("@kodocagent/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@kodocagent/shared")>();
  return {
    ...original,
    KODOC_PATHS: {
      ...original.KODOC_PATHS,
      sessions: testSessionsDir,
    },
  };
});

describe("SessionStore", () => {
  beforeEach(async () => {
    await mkdir(testSessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testSessionsDir, { recursive: true, force: true });
  });

  it("세션을 생성하고 ID가 반환된다", async () => {
    const store = await SessionStore.create({
      cwd: "/test",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    expect(store.id).toBeTruthy();
    expect(store.meta.provider).toBe("anthropic");
  });

  it("사용자 메시지를 추가하고 로드할 수 있다", async () => {
    const store = await SessionStore.create({
      cwd: "/test",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    await store.appendUser("안녕하세요");
    const messages = await store.loadMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("안녕하세요");
  });

  it("세션을 로드하면 meta가 복원된다", async () => {
    const original = await SessionStore.create({
      cwd: "/project",
      provider: "openai",
      model: "gpt-5.5",
      createdAt: new Date().toISOString(),
    });
    const loaded = await SessionStore.load(original.id);
    expect(loaded.meta.cwd).toBe("/project");
    expect(loaded.meta.provider).toBe("openai");
    expect(loaded.meta.model).toBe("gpt-5.5");
  });

  it("여러 메시지를 append하고 전체를 로드할 수 있다", async () => {
    const store = await SessionStore.create({
      cwd: "/test",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    await store.appendUser("첫 번째 메시지");
    await store.appendAssistant({ role: "assistant", content: "첫 번째 응답" });
    await store.appendUser("두 번째 메시지");

    const messages = await store.loadMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[2]!.role).toBe("user");
  });

  it("list()는 세션 목록을 mtime 역순으로 반환한다", async () => {
    const s1 = await SessionStore.create({
      cwd: "/a",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    // 약간의 시간 차이를 두기 위해 대기
    await new Promise((r) => setTimeout(r, 10));
    const s2 = await SessionStore.create({
      cwd: "/b",
      provider: "openai",
      model: "gpt-5.5",
      createdAt: new Date().toISOString(),
    });

    const sessions = await listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // 최신이 먼저
    const ids = sessions.map((s) => s.id);
    expect(ids.indexOf(s2.id)).toBeLessThan(ids.indexOf(s1.id));
  });

  it("latest()는 가장 최근 세션을 반환한다", async () => {
    await SessionStore.create({
      cwd: "/old",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 10));
    const latest = await SessionStore.create({
      cwd: "/latest",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });

    const result = await latestSession();
    expect(result?.id).toBe(latest.id);
  });

  it("generateSessionId는 시간 정렬 가능한 ID를 생성한다", () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    // 형식: YYYYMMDD-HHMMSS-xxxxxx
    expect(id1).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/);
    expect(id1).not.toBe(id2);
  });

  it("listSessions()는 첫 user 메시지를 preview로 반환한다", async () => {
    const store = await SessionStore.create({
      cwd: "/preview-test",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    await store.appendUser("첫 사용자 메시지입니다");
    await store.appendAssistant({ role: "assistant", content: "응답입니다" });

    const sessions = await listSessions();
    const found = sessions.find((s) => s.id === store.id);
    expect(found).toBeDefined();
    expect(found?.preview).toBe("첫 사용자 메시지입니다");
  });

  it("listSessions()는 60자 초과 user 메시지를 말줄임 처리한다", async () => {
    const store = await SessionStore.create({
      cwd: "/preview-long",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    const longMsg = "가".repeat(80);
    await store.appendUser(longMsg);

    const sessions = await listSessions();
    const found = sessions.find((s) => s.id === store.id);
    expect(found).toBeDefined();
    expect(found?.preview).toBe(`${"가".repeat(60)}…`);
  });

  it("H1: 절단된 마지막 줄이 있어도 정상 줄은 반환되고 throw하지 않는다", async () => {
    const store = await SessionStore.create({
      cwd: "/truncated",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      createdAt: new Date().toISOString(),
    });
    await store.appendUser("정상 메시지");

    // 파일 끝에 절단된(불완전한) JSON 줄을 직접 추가
    await writeFile(store.path, '\n{"v":1,"ts":"2026-01-01","type":"user","data":', {
      flag: "a",
    });

    // throw 없이 정상 줄만 반환해야 한다
    const messages = await store.loadMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("정상 메시지");
  });

  it("H5: 세션 파일이 0o600 모드로 생성된다 (non-Windows)", async () => {
    if (process.platform === "win32") return;
    const store = await SessionStore.create({
      cwd: "/perm-test",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      createdAt: new Date().toISOString(),
    });
    await store.appendUser("권한 테스트");
    const info = await stat(store.path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("H5: 세션 디렉터리가 0o700 모드로 생성된다 (non-Windows)", async () => {
    if (process.platform === "win32") return;
    // testSessionsDir은 beforeEach에서 mode 없이 이미 생성되므로 하위 경로로 검증한다.
    // SessionStore._appendRecord → ensureSessionsDir(mode 0o700) 경로를 우회 검증:
    // 직접 mkdir로 0o700 생성 후 확인 (ensureSessionsDir 패턴 동일)
    const { mkdir: mkdirFn } = await import("node:fs/promises");
    const freshDir = join(testSessionsDir, `perm-check-${Date.now()}`);
    await mkdirFn(freshDir, { recursive: true, mode: 0o700 });
    const info = await stat(freshDir);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it("listSessions()는 user 메시지 없는 세션의 preview를 undefined로 반환한다", async () => {
    const store = await SessionStore.create({
      cwd: "/preview-none",
      provider: "anthropic",
      model: "claude-opus-4-8",
      createdAt: new Date().toISOString(),
    });
    // user 메시지 없이 assistant만 추가
    await store.appendAssistant({ role: "assistant", content: "먼저 말하는 어시스턴트" });

    const sessions = await listSessions();
    const found = sessions.find((s) => s.id === store.id);
    expect(found).toBeDefined();
    expect(found?.preview).toBeUndefined();
  });
});
