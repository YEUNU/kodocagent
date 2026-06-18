/**
 * preload — contextBridge로 typed API 노출 (window.kodoc)
 *
 * 보안 원칙:
 * - contextIsolation: true — 렌더러와 완전히 격리
 * - nodeIntegration: false — Node API 직접 접근 불가
 * - API 키/민감 데이터를 IPC로 전달하지 않음
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  BackupEntry,
  DocPreviewResult,
  FileEntry,
  SerializedAgentEvent,
  SetupValues,
} from "../main/agent-bridge.js";

type ConfigSnapshot = { provider: string; model: string | null; hasKeys: Record<string, boolean> };

export interface KodocApi {
  chat: {
    /** 사용자 메시지 전송 (AgentSession.run 실행) */
    send: (text: string) => void;
    /** AgentEvent 스트림 구독. unsubscribe 함수를 반환 */
    onEvent: (cb: (ev: SerializedAgentEvent) => void) => () => void;
    /** 현재 턴 중단 */
    abort: () => void;
  };
  approval: {
    /** 승인 응답 */
    respond: (proposalId: string, approved: boolean, reason?: string) => void;
  };
  config: {
    /** 설정 조회 (키 값은 boolean만) */
    get: () => Promise<ConfigSnapshot>;
    /** 온보딩: 사용자 입력 설정 저장 → 갱신된 스냅샷 */
    save: (values: SetupValues) => Promise<ConfigSnapshot>;
  };
  session: {
    /** 새 세션 시작 */
    new: () => void;
  };
  cwd: {
    /** 폴더 선택 다이얼로그 → 새 cwd 반환 (취소 시 null) */
    select: () => Promise<string | null>;
    /** cwd 변경 이벤트 구독 */
    onChange: (cb: (cwd: string) => void) => () => void;
  };
  files: {
    /** 현재 작업 폴더의 지원 문서 목록 */
    list: () => Promise<FileEntry[]>;
  };
  doc: {
    /** 문서를 읽어 미리보기 HTML 렌더 */
    preview: (path: string) => Promise<DocPreviewResult>;
    /** 드롭된 파일의 절대 경로 (sandbox-safe) */
    pathForFile: (file: File) => string;
  };
  backups: {
    /** 되돌리기 타임라인 */
    list: () => Promise<BackupEntry[]>;
  };
}

const api: KodocApi = {
  chat: {
    send: (text: string) => {
      ipcRenderer.send("chat:send", text);
    },
    onEvent: (cb: (ev: SerializedAgentEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ev: SerializedAgentEvent) => cb(ev);
      ipcRenderer.on("agent:event", handler);
      return () => {
        ipcRenderer.removeListener("agent:event", handler);
      };
    },
    abort: () => {
      ipcRenderer.send("chat:abort");
    },
  },
  approval: {
    respond: (proposalId: string, approved: boolean, reason?: string) => {
      ipcRenderer.send("approval:respond", proposalId, approved, reason);
    },
  },
  config: {
    get: () => ipcRenderer.invoke("config:get"),
    save: (values: SetupValues) => ipcRenderer.invoke("config:save", values),
  },
  session: {
    new: () => {
      ipcRenderer.send("session:new");
    },
  },
  cwd: {
    select: () => ipcRenderer.invoke("cwd:select"),
    onChange: (cb: (cwd: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, cwd: string) => cb(cwd);
      ipcRenderer.on("cwd:changed", handler);
      return () => {
        ipcRenderer.removeListener("cwd:changed", handler);
      };
    },
  },
  files: {
    list: () => ipcRenderer.invoke("files:list"),
  },
  doc: {
    preview: (path: string) => ipcRenderer.invoke("doc:preview", path),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  backups: {
    list: () => ipcRenderer.invoke("backups:list"),
  },
};

contextBridge.exposeInMainWorld("kodoc", api);

// TypeScript 전역 타입 선언 (렌더러에서 window.kodoc 타입 사용)
declare global {
  interface Window {
    kodoc: KodocApi;
  }
}
