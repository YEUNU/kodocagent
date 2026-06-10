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

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { KODOC_PATHS } from "@kodocagent/shared";
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
  await mkdir(sessionDir, { recursive: true });

  const counter = (stagingCounters.get(sessionId) ?? 0) + 1;
  stagingCounters.set(sessionId, counter);

  const name = basename(targetName);
  const stagedPath = join(sessionDir, `${counter}-${name}`);

  if (typeof data === "string") {
    await writeFile(stagedPath, data, "utf-8");
  } else {
    await writeFile(stagedPath, data);
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
export async function backupFile(targetPath: string, baseDir?: string): Promise<string | null> {
  // 파일이 존재하는지 확인
  try {
    await readFile(targetPath);
  } catch {
    return null;
  }

  const backupsRoot = baseDir ?? KODOC_PATHS.backups;
  await mkdir(backupsRoot, { recursive: true });

  // ISO 타임스탬프 (파일 이름에 안전한 문자로)
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = basename(targetPath);
  const backupPath = join(backupsRoot, `${ts}-${name}`);

  await copyFile(targetPath, backupPath);
  return backupPath;
}

/**
 * 스테이징된 파일을 타겟 경로에 원자적으로 쓴다.
 * temp 파일을 타겟과 같은 볼륨에 생성하고 rename().
 *
 * @param stagedPath  스테이징 파일 절대 경로
 * @param targetPath  최종 저장 경로
 */
export async function commitStaged(stagedPath: string, targetPath: string): Promise<void> {
  const targetDir = dirname(targetPath);
  await mkdir(targetDir, { recursive: true });

  // 같은 볼륨에 temp 파일 생성 (rename이 원자적으로 동작하려면 같은 파일시스템이어야 함)
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const data = await readFile(stagedPath);
  await writeFile(tmpPath, data);
  await rename(tmpPath, targetPath);
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
 * .hwp 경로를 .hwpx로 변환한다 (원본 .hwp는 보존, 출력만 .hwpx).
 * .hwp가 아니면 원래 경로 그대로 반환.
 */
export function resolveOutputPath(targetPath: string): {
  outputPath: string;
  willConvertFormat: string | undefined;
} {
  const ext = extname(targetPath).toLowerCase();
  if (ext === ".hwp") {
    const outputPath = targetPath.slice(0, -4) + ".hwpx";
    return { outputPath, willConvertFormat: ".hwp → .hwpx" };
  }
  return { outputPath: targetPath, willConvertFormat: undefined };
}
