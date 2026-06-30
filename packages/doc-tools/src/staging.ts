/**
 * 스테이징 파이프라인 — SPEC §7
 *
 * stageFile      : ~/.kodocagent/staging/<sessionId>/<n>-<basename>
 * backupFile     : ~/.kodocagent/backups/<ISO타임스탬프>-<basename>  (덮어쓰기 전 항상 실행)
 * commitStaged   : 타겟 디렉터리에 temp 쓰기 + rename (원자적)
 * markdownDiff   : unified diff 텍스트 생성 (diff v9 createTwoFilesPatch)
 *
 * .hwp 정책: 타겟 경로가 .hwp이면 출력 경로를 .hwpx로 변환하고 원본 .hwp는 보존
 *
 * 테스트 호환성: baseDir 파라미터로 KODOC_PATHS 우회 가능
 */

import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { KODOC_PATHS, KodocError } from "@kodocagent/shared";
import { createTwoFilesPatch } from "diff";

/** 세션당 스테이징 카운터 (증분 번호, 메모리 유지) */
const stagingCounters = new Map<string, number>();

/**
 * 결과물을 스테이징 디렉터리에 저장한다.
 *
 * @param sessionId   세션 ID
 * @param targetName  원본 파일명 (경로 제외, basename만)
 * @param data        저장할 데이터 (Uint8Array 또는 string)
 * @param baseDir     테스트 시 KODOC_PATHS.staging 대체 경로 (선택)
 * @returns           스테이징된 파일의 절대 경로
 */
export async function stageFile(
  sessionId: string,
  targetName: string,
  data: Uint8Array | string,
  baseDir?: string,
): Promise<string> {
  const stagingRoot = baseDir ?? KODOC_PATHS.staging;
  const sessionDir = join(stagingRoot, sessionId);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const counter = (stagingCounters.get(sessionId) ?? 0) + 1;
  stagingCounters.set(sessionId, counter);

  const name = basename(targetName);
  const stagedPath = join(sessionDir, `${counter}-${name}`);

  if (typeof data === "string") {
    await writeFile(stagedPath, data, { encoding: "utf-8", mode: 0o600 });
  } else {
    await writeFile(stagedPath, data, { mode: 0o600 });
  }

  return stagedPath;
}

/**
 * 파일을 백업 디렉터리에 복사한다.
 * 타겟 파일이 존재하지 않으면 no-op (신규 파일은 백업 불필요).
 *
 * @param targetPath  백업할 원본 파일의 절대 경로
 * @param baseDir     테스트 시 KODOC_PATHS.backups 대체 경로 (선택)
 * @returns           백업 파일 경로 (파일이 없으면 null)
 */
export async function backupFile(
  targetPath: string,
  baseDir?: string,
  meta?: { summary?: string },
): Promise<string | null> {
  // 파일이 존재하는지 확인
  try {
    await readFile(targetPath);
  } catch {
    return null;
  }

  const backupsRoot = baseDir ?? KODOC_PATHS.backups;
  await mkdir(backupsRoot, { recursive: true, mode: 0o700 });

  // ISO 타임스탬프 (파일 이름에 안전한 문자로).
  // 같은 ms 내 연속 백업이 같은 파일명을 낼 수 있으므로 COPYFILE_EXCL(배타적 생성)으로
  // 복사하고, 이미 존재하면(EEXIST) ms를 1씩 증가해 재시도한다 — access+copyFile 사이의
  // TOCTOU 없이 원자적으로 충돌을 회피한다. 정규식(-<name> 포맷)은 절대 바꾸지 않는다.
  const name = basename(targetPath);
  let ms = Date.now();
  let backupPath = "";
  for (;;) {
    const ts = new Date(ms).toISOString().replace(/[:.]/g, "-");
    backupPath = join(backupsRoot, `${ts}-${name}`);
    try {
      await copyFile(targetPath, backupPath, constants.COPYFILE_EXCL);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        ms++; // 이미 존재 → 다음 ms로 재시도
        continue;
      }
      throw err; // 그 외 오류(권한·디스크 등)는 그대로 전파
    }
  }

  // 백업 파일 권한을 0o600으로 제한 (소유자만 읽기·쓰기)
  try {
    await chmod(backupPath, 0o600);
  } catch {
    // Windows 등 chmod 미지원 환경 — 무시
  }

  // 작업 메타데이터 사이드카(되돌리기 타임라인용). 선행 점(.)으로 시작해 백업 목록
  // 정규식(^<ts>-<name>$)에 걸리지 않으므로 list_backups는 영향받지 않는다.
  // sourcePath(원본 절대 경로)를 항상 기록해, 타임라인이 현재 작업 폴더의 백업만
  // 보여줄 수 있게 한다(전역 백업 디렉터리에 다른 폴더·과거 작업 백업이 쌓여도 노이즈 방지).
  // summary는 있을 때만 포함한다. 사이드카 쓰기 실패가 백업을 깨지 않도록 best-effort.
  {
    const backupBasename = basename(backupPath);
    await writeFile(
      join(backupsRoot, `.${backupBasename}.meta.json`),
      JSON.stringify({
        sourcePath: targetPath,
        ...(meta?.summary ? { summary: meta.summary } : {}),
      }),
      "utf-8",
    ).catch(() => undefined);
  }

  return backupPath;
}

/**
 * errno 코드를 사용자 친화적 한국어 메시지로 변환한다.
 * 알 수 없는 코드는 null 반환 → 호출자가 원본 오류를 그대로 던짐.
 *
 * @param code  NodeJS.ErrnoException.code (예: "EBUSY")
 * @returns     { message, hint } 또는 null
 */
export function commitErrorMessage(
  code: string | undefined,
): { message: string; hint: string } | null {
  switch (code) {
    case "EBUSY":
    case "EPERM":
    case "EACCES":
    case "ETXTBSY":
      return {
        message: "파일을 저장하지 못했습니다(다른 프로그램에서 사용 중이거나 권한 없음).",
        hint: "한컴오피스·한글뷰어 등에서 이 파일을 열어 두었다면 닫은 뒤 다시 시도하세요. 쓰기 권한도 확인하세요.",
      };
    case "ENOSPC":
      return {
        message: "저장 공간이 부족해 파일을 저장하지 못했습니다.",
        hint: "디스크 여유 공간을 확보한 뒤 다시 시도하세요.",
      };
    case "EROFS":
      return {
        message: "읽기 전용 위치라 파일을 저장할 수 없습니다.",
        hint: "쓰기 가능한 폴더로 옮긴 뒤 다시 시도하세요.",
      };
    default:
      return null;
  }
}

/**
 * 스테이징된 파일을 타겟 경로에 원자적으로 쓴다.
 * temp 파일을 타겟과 같은 볼륨에 생성하고 rename().
 *
 * 실패 시:
 * - 임시 파일(tmpPath)을 best-effort 정리한다.
 * - EBUSY/EPERM/EACCES/ETXTBSY/ENOSPC/EROFS → KodocError(한국어 메시지 + 해결 힌트)
 * - 그 외 → 원본 오류 그대로 rethrow
 *
 * @param stagedPath  스테이징 파일 절대 경로
 * @param targetPath  최종 저장 경로
 * @throws KodocError  파일이 잠겨 있거나 디스크가 꽉 찼거나 읽기 전용 위치인 경우
 */
export async function commitStaged(stagedPath: string, targetPath: string): Promise<void> {
  const targetDir = dirname(targetPath);
  await mkdir(targetDir, { recursive: true });

  // 같은 볼륨에 temp 파일 생성 (rename이 원자적으로 동작하려면 같은 파일시스템이어야 함)
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const data = await readFile(stagedPath);

  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, targetPath);
  } catch (err: unknown) {
    // temp 파일 best-effort 정리 (실패해도 무시)
    await rm(tmpPath, { force: true }).catch(() => undefined);

    const errInfo = commitErrorMessage((err as NodeJS.ErrnoException).code);
    if (errInfo) {
      throw new KodocError(errInfo.message, errInfo.hint);
    }
    throw err;
  }
}

/**
 * 두 마크다운 문자열의 unified diff를 생성한다.
 *
 * @param beforeMd  변경 전 마크다운
 * @param afterMd   변경 후 마크다운
 * @param label     파일 레이블 (diff 헤더에 표시)
 * @returns         unified diff 문자열
 */
export function markdownDiff(beforeMd: string, afterMd: string, label: string): string {
  return createTwoFilesPatch(`a/${label}`, `b/${label}`, beforeMd, afterMd, undefined, undefined, {
    context: 3,
  });
}

/**
 * 특정 세션의 스테이징 디렉터리를 삭제한다.
 * 세션 종료 시 자동 정리에 사용한다.
 *
 * @param sessionId  정리할 세션 ID
 * @param baseDir    테스트 시 KODOC_PATHS.staging 대체 경로 (선택)
 */
export async function cleanSessionStaging(sessionId: string, baseDir?: string): Promise<void> {
  const stagingRoot = baseDir ?? KODOC_PATHS.staging;
  const sessionDir = join(stagingRoot, sessionId);
  await rm(sessionDir, { recursive: true, force: true });
  // 메모리 누수 방지: 카운터 맵에서 해당 세션 제거
  stagingCounters.delete(sessionId);
}

/**
 * 스테이징 루트 전체를 비운다 (모든 세션 스테이징 삭제).
 *
 * @param baseDir  테스트 시 KODOC_PATHS.staging 대체 경로 (선택)
 * @returns        삭제된 항목(세션 디렉터리/파일) 수
 */
export async function cleanAllStaging(baseDir?: string): Promise<number> {
  const stagingRoot = baseDir ?? KODOC_PATHS.staging;

  let entries: string[];
  try {
    entries = await readdir(stagingRoot);
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    const fullPath = join(stagingRoot, entry);
    await rm(fullPath, { recursive: true, force: true });
    count++;
  }
  // 메모리 누수 방지: 전체 카운터 맵 초기화
  stagingCounters.clear();
  return count;
}

/**
 * mtime 기준으로 오래된 백업 파일을 삭제한다.
 *
 * @param maxAgeDays  이 일수 이상 경과한 파일 삭제 (기본값: 30)
 * @param baseDir     테스트 시 KODOC_PATHS.backups 대체 경로 (선택)
 * @returns           { deleted: number; kept: number }
 */
export async function cleanOldBackups(
  maxAgeDays = 30,
  baseDir?: string,
): Promise<{ deleted: number; kept: number }> {
  const backupsRoot = baseDir ?? KODOC_PATHS.backups;

  let entries: string[];
  try {
    entries = await readdir(backupsRoot);
  } catch {
    return { deleted: 0, kept: 0 };
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let kept = 0;

  for (const entry of entries) {
    // 사이드카(점으로 시작)는 백업 파일 삭제 시 함께 처리하므로 독립 판정 제외
    if (entry.startsWith(".")) continue;
    const fullPath = join(backupsRoot, entry);
    try {
      const info = await stat(fullPath);
      if (info.mtimeMs < cutoff) {
        await rm(fullPath, { recursive: true, force: true });
        // 대응 사이드카도 best-effort로 함께 삭제 (고아 .meta.json 방지)
        await rm(join(backupsRoot, `.${entry}.meta.json`), { force: true }).catch(() => undefined);
        deleted++;
      } else {
        kept++;
      }
    } catch {
      // 상태 조회 실패 시 건너뜀
    }
  }

  return { deleted, kept };
}

/**
 * .hwp 경로를 .hwpx로 변환한다 (원본 .hwp는 보존, 출력만 .hwpx).
 * .hwp가 아니면 원래 경로 그대로 반환.
 */
export function resolveOutputPath(targetPath: string): {
  outputPath: string;
  willConvertFormat: string | undefined;
} {
  const ext = extname(targetPath).toLowerCase();
  if (ext === ".hwp") {
    return { outputPath: targetPath.slice(0, -4) + ".hwpx", willConvertFormat: ".hwp → .hwpx" };
  }
  if (ext === ".xls") {
    return { outputPath: targetPath.slice(0, -4) + ".xlsx", willConvertFormat: ".xls → .xlsx" };
  }
  return { outputPath: targetPath, willConvertFormat: undefined };
}
