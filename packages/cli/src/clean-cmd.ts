/**
 * kodocagent clean — 스테이징 + 오래된 백업 정리
 * docs/SPEC.md §8 / ROADMAP M4.5 #1
 */
import { cleanAllStaging, cleanOldBackups } from "@kodocagent/doc-tools";
import chalk from "chalk";

/**
 * clean 커맨드 실행
 * @param opts.all  --all 플래그: 백업 전체 삭제 (날짜 무관)
 */
export async function runClean(opts: { all?: boolean }): Promise<void> {
  // 스테이징 전체 삭제
  const stagingDeleted = await cleanAllStaging();

  let backupDeleted: number;
  let backupKept: number;

  if (opts.all) {
    // --all: 모든 백업 삭제 (maxAgeDays=0이면 전부 해당)
    const result = await cleanOldBackups(0);
    backupDeleted = result.deleted;
    backupKept = result.kept;
  } else {
    // 기본: 30일 경과 백업만 삭제
    const result = await cleanOldBackups(30);
    backupDeleted = result.deleted;
    backupKept = result.kept;
  }

  const backupNote = opts.all ? "" : ` (보존 ${backupKept}개)`;
  process.stdout.write(
    chalk.green(`✓ 스테이징 ${stagingDeleted}개, 백업 ${backupDeleted}개 정리${backupNote}\n`),
  );
}
