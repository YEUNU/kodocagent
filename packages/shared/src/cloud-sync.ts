/**
 * 클라우드 동기 폴더 경고 (#13) — 비차단 경고만, 절대 throw 안 함.
 *
 * 순수 경로/파일 존재 검사만 하는 진단 헬퍼라 shared 에 둔다(core 가 직접 사용하며,
 * doc-tools 에 두면 core→doc-tools 워크스페이스 의존 사이클이 생긴다).
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * 알려진 클라우드 동기 위치(경로 부분 문자열, 대소문자 무시).
 * - `Library/Mobile Documents`  : macOS iCloud Drive
 * - `Library/CloudStorage/`     : macOS 통합 마운트(iCloud/OneDrive/GoogleDrive/Dropbox/Box)
 * - `/Dropbox/`                 : Dropbox 동기 폴더
 * - `OneDrive`                  : Microsoft OneDrive
 * - `Google Drive`             : Google Drive(레거시 마운트)
 */
const CLOUD_SYNC_MARKERS = [
  "library/mobile documents",
  "library/cloudstorage/",
  "/dropbox/",
  "onedrive",
  "google drive",
] as const;

/** 클라우드 동기 폴더 경고 문구 */
const CLOUD_SYNC_WARN =
  "이 문서는 클라우드 동기 폴더(iCloud/Dropbox/OneDrive 등)에 있습니다. " +
  "동기 중에는 충돌 사본이 생기거나 변경 반영이 지연될 수 있으니, 저장 후 동기 완료를 확인하세요.";

/** macOS iCloud placeholder(미다운로드) 경고 문구 */
const ICLOUD_PLACEHOLDER_WARN =
  "이 파일은 아직 기기에 내려받지 않은 클라우드 placeholder일 수 있습니다. " +
  "한글/Finder에서 먼저 다운로드한 뒤 편집하세요.";

/**
 * 절대 경로가 알려진 클라우드 동기 위치에 있는지, 또는 macOS iCloud placeholder
 * (미다운로드 파일)인지 감지해 비차단 경고 문자열을 반환한다.
 *
 * - 알려진 클라우드 동기 위치가 경로에 포함되면(대소문자 무시) 동기 경고를 반환한다.
 * - macOS placeholder 감지: `dirname/.{basename}.icloud` 동반 파일이 존재하면
 *   다운로드 안내 경고를 (우선해) 반환한다.
 * - 둘 다 아니면 null. 이 함수는 진단/안내 목적이므로 절대 throw 하지 않는다
 *   (fs 접근 실패 등은 조용히 무시 — 쓰기 흐름을 막지 않는다).
 *
 * @param absPath 검증할 파일의 절대 경로
 * @returns       경고 문자열 또는 null
 */
export function detectCloudSyncWarning(absPath: string): string | null {
  try {
    // macOS iCloud placeholder(미다운로드) — 동반 파일 `.{name}.icloud` 존재 시 우선 안내.
    // 예: /…/report.hwpx 의 placeholder 는 /…/.report.hwpx.icloud
    try {
      const dir = dirname(absPath);
      const base = basename(absPath);
      if (base && existsSync(join(dir, `.${base}.icloud`))) {
        return ICLOUD_PLACEHOLDER_WARN;
      }
    } catch {
      // 경로 파싱/접근 실패 → placeholder 검사만 건너뛴다(동기 경로 검사는 계속)
    }

    const lower = absPath.toLowerCase();
    if (CLOUD_SYNC_MARKERS.some((marker) => lower.includes(marker))) {
      return CLOUD_SYNC_WARN;
    }

    return null;
  } catch {
    // 어떤 이유로든 실패해도 경고는 선택적 기능이므로 조용히 통과
    return null;
  }
}
