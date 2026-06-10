/**
 * 설정 파일 로드/저장 — ~/.kodocagent/config.json (mode 0600)
 * docs/SPEC.md §4
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KodocConfig } from "@kodocagent/shared";
import { KODOC_PATHS, KodocConfigSchema, KodocError } from "@kodocagent/shared";

const CONFIG_PATH = KODOC_PATHS.config;

/**
 * 설정 파일을 로드한다.
 * 파일이 없으면 기본값을 반환한다.
 * 손상된 파일은 KodocError를 던진다.
 */
export async function loadConfig(): Promise<KodocConfig> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // 설정 파일 없음 — 기본값 반환
      return KodocConfigSchema.parse({});
    }
    throw new KodocError(
      `설정 파일을 읽을 수 없습니다: ${CONFIG_PATH}`,
      `파일 권한을 확인하거나 '${CONFIG_PATH}'를 삭제 후 재실행하세요.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KodocError(
      `설정 파일이 손상되었습니다: ${CONFIG_PATH}`,
      `'${CONFIG_PATH}'를 삭제하고 'kodocagent'를 다시 실행하면 초기 설정이 시작됩니다.`,
    );
  }

  const result = KodocConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new KodocError(
      `설정 파일의 형식이 올바르지 않습니다: ${result.error.message}`,
      `'${CONFIG_PATH}'를 삭제하고 'kodocagent'를 다시 실행하면 초기 설정이 시작됩니다.`,
    );
  }
  return result.data;
}

/**
 * 설정 파일을 저장한다.
 * 디렉터리가 없으면 생성하고, 파일 권한은 0600(소유자만 읽기·쓰기)으로 설정한다.
 */
export async function saveConfig(config: KodocConfig): Promise<void> {
  const dir = dirname(CONFIG_PATH);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // 이미 존재하면 무시
  }

  const json = JSON.stringify(config, null, 2);
  await writeFile(CONFIG_PATH, json, { encoding: "utf-8", mode: 0o600 });

  // 모드를 명시적으로 0600으로 설정 (umask 보호)
  try {
    await chmod(CONFIG_PATH, 0o600);
  } catch {
    // Windows 등에서 chmod 미지원 — 무시
  }
}
