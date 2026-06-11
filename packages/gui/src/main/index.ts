/**
 * Electron main process 진입점
 *
 * - BrowserWindow 생성
 * - AgentBridge 초기화
 * - IPC 핸들러 등록
 * - 기본 cwd: app.getPath("documents")
 */

import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { AgentBridge } from "./agent-bridge.js";

let mainWindow: BrowserWindow | null = null;
let bridge: AgentBridge | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "kodocagent",
    backgroundColor: "#1a1a2e",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
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

app.whenReady().then(async () => {
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

  /** session.new */
  ipcMain.on("session:new", () => {
    bridge?.resetSession().catch(() => {});
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
