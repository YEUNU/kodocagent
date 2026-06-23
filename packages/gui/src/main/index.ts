/**
 * Electron main process 진입점
 *
 * - BrowserWindow 생성
 * - AgentBridge 초기화
 * - IPC 핸들러 등록
 * - 기본 cwd: app.getPath("documents")
 */

import { join } from "node:path";
import { logger } from "@kodocagent/shared";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import { AgentBridge, type SetupValues } from "./agent-bridge.js";

// electron-updater는 CommonJS default export(`{ autoUpdater }`)만 제공 → named import 대신 구조분해.
const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | null = null;
let bridge: AgentBridge | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// 전역 예외 핸들러 (프라이버시: 외부 업로드/텔레메트리 없음, 로컬 로깅만)
//
// 문서·PII 도구이므로 crashReporter/외부 전송은 절대 활성화하지 않는다.
// uncaughtException·unhandledRejection을 logger(로컬, stderr + KODOC_DEBUG 시 파일)로
// 기록해 조용한 크래시를 막고, 가능하면 사용자에게 다이얼로그로 알린다.
// ─────────────────────────────────────────────────────────────────────────────

/** 예외 핸들러 1회 등록 가드 (HMR/중복 호출 방지) */
let crashHandlersInstalled = false;

function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  process.on("uncaughtException", (err: Error) => {
    logger.error("uncaughtException", {
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
    // 메인 프로세스 크래시는 사용자에게 알린다(외부 전송 없음).
    try {
      dialog.showErrorBox(
        "예기치 않은 오류",
        `내부 오류가 발생했습니다: ${err.message}\n` +
          "작업을 다시 시도하거나 앱을 재시작하세요. (오류는 로컬에만 기록되며 외부로 전송되지 않습니다.)",
      );
    } catch {
      // 다이얼로그 표시 실패(앱 준비 전 등)는 무시 — 이미 logger로 기록됨
    }
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error("unhandledRejection", {
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 자동 업데이트 (electron-updater)
//
// 프라이버시: 업데이트 확인은 패키징된 앱(app.isPackaged)에서만, GitHub Releases를
// 대상으로만 수행한다. 텔레메트리/외부 분석 전송은 추가하지 않는다. dev/test 환경
// (app.isPackaged === false)에서는 아무 동작도 하지 않으므로 vitest·electron-vite dev에
// 영향이 없다. 업데이트 점검 실패는 logger로 삼키고 절대 크래시시키지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

function maybeCheckForUpdates(): void {
  if (!app.isPackaged) return; // dev/test 무영향
  try {
    autoUpdater.logger = null; // electron-updater 내부 콘솔 로깅 비활성(우리 logger만 사용)
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      logger.warn("autoUpdater.checkForUpdatesAndNotify failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err: unknown) {
    // 동기 예외(설정/플랫폼 문제)도 크래시로 번지지 않게 삼킨다.
    logger.warn("autoUpdater setup failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "kodocagent",
    backgroundColor: "#15171e",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 개발 시: electron-vite dev 서버
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 앱 준비 전에 전역 예외 핸들러를 먼저 등록한다(초기화 중 발생하는 오류도 포착).
installCrashHandlers();

app.whenReady().then(async () => {
  // 렌더러 프로세스가 비정상 종료되면 로컬에 기록(외부 전송 없음).
  app.on("render-process-gone", (_event, _webContents, details) => {
    logger.error("render-process-gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // 기본 cwd: Documents 폴더
  const defaultCwd = app.getPath("documents");
  bridge = new AgentBridge(defaultCwd);

  // AgentBridge → 렌더러 이벤트 브릿지
  bridge.onEvent = (ev) => {
    mainWindow?.webContents.send("agent:event", ev);
  };

  // IPC 핸들러 등록
  registerIpc();

  createWindow();

  // 초기화 (비동기, 창 생성 후)
  bridge.init().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send("agent:event", {
      type: "error",
      message: `초기화 실패: ${msg}`,
      recoverable: false,
    });
  });

  // 초기 cwd 전달
  mainWindow?.webContents.once("did-finish-load", () => {
    mainWindow?.webContents.send("cwd:changed", bridge?.getCwd() ?? defaultCwd);
  });

  // 패키징된 앱에서만 업데이트 확인(GitHub Releases). dev/test 무영향.
  maybeCheckForUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  bridge?.abort(); // pending approvals 정리 + controller 중단
  await bridge?.mcpManager?.disconnect().catch(() => {});
});

function registerIpc(): void {
  /** chat.send — 사용자 메시지 전송 */
  ipcMain.on("chat:send", (_event, text: string) => {
    bridge?.sendMessage(text).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      mainWindow?.webContents.send("agent:event", {
        type: "error",
        message: msg,
        recoverable: false,
      });
    });
  });

  /** chat.abort — 현재 턴 중단 */
  ipcMain.on("chat:abort", () => {
    bridge?.abort();
  });

  /** chat.compare — 키가 있는 여러 프로바이더 응답 비교 (읽기 전용) */
  ipcMain.handle("chat:compare", async (_event, prompt: string, documentPath?: string) => {
    return (
      (await bridge?.compareProviders(prompt, documentPath)) ?? {
        ok: false as const,
        error: "세션이 초기화되지 않았습니다.",
      }
    );
  });

  /** approval.respond */
  ipcMain.on(
    "approval:respond",
    (_event, proposalId: string, approved: boolean, reason?: string) => {
      bridge?.respondToApproval(proposalId, approved, reason);
    },
  );

  /** config.get */
  ipcMain.handle("config:get", async () => {
    return bridge?.getConfigSnapshot() ?? { provider: "anthropic", model: null, hasKeys: {} };
  });

  /** config.save — 온보딩 마법사 설정 저장 (사용자 입력 키 저장) */
  ipcMain.handle("config:save", async (_event, values: SetupValues) => {
    return (
      (await bridge?.saveSetup(values)) ?? {
        provider: "anthropic",
        model: null,
        hasKeys: {} as Record<string, boolean>,
      }
    );
  });

  /** session.new */
  ipcMain.on("session:new", () => {
    bridge?.resetSession().catch(() => {});
  });

  /** files.list — 작업 폴더 문서 목록 */
  ipcMain.handle("files:list", async () => {
    return (await bridge?.listFiles()) ?? [];
  });

  /** doc.preview — 문서 HTML 렌더 (읽기 전용) */
  ipcMain.handle("doc:preview", async (_event, path: string) => {
    return (
      (await bridge?.previewDocument(path)) ?? {
        ok: false as const,
        error: "세션이 초기화되지 않았습니다.",
      }
    );
  });

  /** backups.list — 되돌리기 타임라인 */
  ipcMain.handle("backups:list", async () => {
    return (await bridge?.listBackups()) ?? [];
  });

  /** cwd.select — 폴더 선택 다이얼로그 */
  ipcMain.handle("cwd:select", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "작업 폴더 선택",
      defaultPath: bridge?.getCwd(),
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const newCwd = result.filePaths[0];
    if (newCwd) {
      await bridge?.setCwd(newCwd);
      mainWindow?.webContents.send("cwd:changed", newCwd);
    }
    return newCwd ?? null;
  });
}
