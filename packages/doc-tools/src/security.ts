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
import { isOldHwpFile, isZipFile } from "kordoc";

// ─────────────────────────────────────────────────────────
// HWP 구조 편집 가드 — 포맷 감지는 kordoc API에 위임
// (kordoc-api-first 원칙: 매직바이트 감지를 자체 구현하지 않고 kordoc 사용)
// ─────────────────────────────────────────────────────────

/**
 * Uint8Array의 선두 헤더만 kordoc 감지 함수용 ArrayBuffer로 복사한다.
 *
 * kordoc의 is*File()은 매직바이트(선두 8바이트 이내)만 읽으므로 전체 파일을
 * 복사할 필요가 없다. Node Buffer.subarray는 풀링된 ArrayBuffer를 공유하므로
 * `new Uint8Array(view)`로 정확한 크기의 새 버퍼에 복사한다(풀 오염 회피).
 */
function headerBuffer(bytes: Uint8Array, n = 64): ArrayBuffer {
  return new Uint8Array(bytes.subarray(0, Math.min(n, bytes.length))).buffer;
}

/**
 * 파일이 OLE2/CFB 바이너리(구형 .hwp)인지 콘텐츠 기반으로 감지한다.
 * kordoc `isOldHwpFile`에 위임 (OLE2 시그니처 D0 CF 11 E0 … 검사).
 *
 * @param bytes 파일 바이트 (최소 8 바이트 이상이어야 정확하게 감지됨)
 * @returns     OLE2 시그니처가 맞으면 true
 */
export function isOle2Binary(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return isOldHwpFile(headerBuffer(bytes));
}

/**
 * 파일이 ZIP(.hwpx 등) 시그니처("PK", 0x50 0x4B)인지 감지한다.
 * kordoc `isZipFile`에 위임.
 *
 * @param bytes 파일 바이트
 * @returns     ZIP 시그니처가 맞으면 true
 */
export function isZipBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return isZipFile(headerBuffer(bytes));
}

/**
 * HWPX 구조 편집 툴에 대한 공통 가드.
 *
 * 파일이 실제 HWP5 OLE 바이너리임을 콘텐츠(매직 바이트)로 감지하거나
 * `.hwp` 확장자임이 확인될 때, 구조 편집이 불가능한 이유와 해결 방법을
 * 담은 한국어 안내 메시지를 반환한다.
 *
 * - `.hwpx` 파일(ZIP 시그니처)에는 null 반환 → 정상 진행.
 * - `.hwp` 확장자이거나 OLE2 시그니처가 감지되면 안내 문자열 반환 → 즉시 반환하여 쓰기 차단.
 *
 * @param ext   파일 확장자 (소문자, 예: ".hwp", ".hwpx")
 * @param bytes 파일 바이트 (파일을 읽은 후 전달)
 * @returns     구조 편집 불가 안내 메시지(한국어) 또는 null(정상 진행)
 */
export function hwpStructuralGuard(ext: string, bytes: Uint8Array): string | null {
  // 확장자가 .hwp이거나 OLE2 매직 바이트가 감지된 경우 가드 발동
  const isHwpExt = ext === ".hwp";
  const isOle2 = isOle2Binary(bytes);

  // .hwp 확장자가 아니고 OLE2 바이트도 아니면 정상 진행 (null 반환)
  if (!isHwpExt && !isOle2) return null;

  // .hwpx 확장자이고 ZIP 시그니처가 있으면 정상 .hwpx로 간주 — 가드 미발동
  // (OLE2 바이트지만 확장자가 .hwpx인 경우는 손상/잘못된 파일로 가드 발동)
  if (!isHwpExt && isZipBinary(bytes)) return null;

  return (
    "이 작업(표·셀·양식·찾기바꾸기 등 구조 편집)은 `.hwpx` 문서에서 지원됩니다. " +
    "`.hwp`는 OLE 바이너리라 구조를 무손실로 패치할 수 없습니다. " +
    "해결: (1) 본문 텍스트만 고치려면 `propose_edit`을 사용하세요(.hwp 제자리 편집). " +
    "(2) 표·셀·양식 편집이 필요하면 한글에서 '다른 이름으로 저장 → HWPX(.hwpx)'로 변환한 뒤 다시 시도하세요."
  );
}

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
