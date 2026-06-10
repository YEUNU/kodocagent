/**
 * 경로 보안 검증 — cwd 이하 이탈 방지
 * docs/SPEC.md §6, DEVELOPMENT.md §2 불변 원칙
 *
 * - NFC 정규화 (macOS NFD 대응)
 * - realpath 기반 이탈 방지 (심링크 우회 차단)
 * - 플랫폼 독립 구분자 처리 (path.relative 기반 — Windows 역슬래시 포함)
 * - 한국어 에러 메시지
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { KodocError } from "@kodocagent/shared";

/**
 * 경로를 NFC 정규화하고 cwd 이하인지 검증한 후 절대 경로를 반환한다.
 *
 * @param cwd 현재 작업 디렉터리 (신뢰할 수 있는 절대 경로)
 * @param p   검증할 경로 (상대 또는 절대)
 * @returns   realpath로 해석된 안전한 절대 경로
 * @throws    KodocError — cwd 이탈 또는 경로 불법
 */
export async function resolveSafePath(cwd: string, p: string): Promise<string> {
  // NFC 정규화 (macOS는 NFD로 파일명을 저장하므로 비교 전 정규화 필요)
  const normalizedCwd = normalize(cwd).normalize("NFC");
  const normalizedP = p.normalize("NFC");

  // cwd 기준 절대 경로로 변환
  const candidate = resolve(normalizedCwd, normalizedP);

  // realpath로 심링크 등 해결. 아직 존재하지 않는 경로는 부모 디렉터리까지만 해석
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      try {
        const realDir = await realpath(dirname(candidate));
        real = join(realDir, basename(candidate));
      } catch {
        throw new KodocError(
          `경로를 찾을 수 없습니다: ${p}`,
          `'${normalizedCwd}' 이하에 존재하는 파일 또는 디렉터리를 지정하세요.`,
        );
      }
    } else {
      throw new KodocError(`경로에 접근할 수 없습니다: ${p}`, "파일 권한을 확인하세요.");
    }
  }

  // realpath로 해결된 cwd
  let realCwd: string;
  try {
    realCwd = await realpath(normalizedCwd);
  } catch {
    realCwd = normalizedCwd;
  }

  // cwd 이하 검증 — 구분자 하드코딩 대신 relative() 사용 (Windows 호환)
  const rel = relative(realCwd, real);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new KodocError(
      "허용되지 않는 경로입니다: 작업 디렉터리 밖을 참조할 수 없습니다.",
      `'${realCwd}' 이하의 경로를 사용하세요. '../' 등 상위 디렉터리 이탈은 금지됩니다.`,
    );
  }

  return real;
}
