/**
 * 경로 보안 검증 — cwd 이하 이탈 방지
 * docs/SPEC.md §6, DEVELOPMENT.md §2 불변 원칙
 *
 * - NFC 정규화 (macOS NFD 대응)
 * - realpath 기반 이탈 방지 (심링크 우회 차단)
 * - 플랫폼 독립 구분자 처리 (path.relative 기반 — Windows 역슬래시 포함)
 * - 한국어 에러 메시지
 */
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { KodocError } from "@kodocagent/shared";
import { isOldHwpFile, isZipFile } from "kordoc";

/** 파일 크기 한도 — 100 MB */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 파일 크기가 한도 이내인지 검증한다.
 * 사용자 원본 문서를 readFile하기 직전에 호출하라.
 *
 * stat 실패(파일 없음·권한 등)는 여기서 던지지 않는다 — 후속 readFile/parse가
 * 한국어 친화 메시지로 처리하도록 위임한다(없는 경로에 raw ENOENT·절대경로가 새지 않게).
 * 실제로 너무 큰 파일(한도 초과)일 때만 KodocError를 던진다.
 *
 * @param path     검증할 파일 절대 경로 (resolveSafePath 통과 후)
 * @param maxBytes 최대 바이트 수 (기본값: MAX_FILE_BYTES = 100 MB)
 * @throws KodocError — 한도 초과 시에만
 */
export async function assertFileSizeWithinLimit(
  path: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // 파일이 없거나 stat 실패 → 크기 가드는 통과시키고 후속 읽기가 처리하게 둔다.
    return;
  }
  if (size > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    throw new KodocError(
      `파일이 너무 커서 처리할 수 없습니다(최대 ${maxMb}MB).`,
      "더 작은 파일로 나누거나 한글에서 일부만 저장해 다시 시도하세요.",
    );
  }
}

// ─────────────────────────────────────────────────────────
// ZIP 압축 폭탄(decompression bomb) 가드
// ─────────────────────────────────────────────────────────

/** 압축 해제 크기 기본 한도 — 1 GB */
const MAX_UNCOMPRESSED_ZIP_BYTES = 1024 * 1024 * 1024;

/** ZIP End of Central Directory 시그니처 (리틀 엔디언 0x06054b50) */
const EOCD_SIG = 0x06054b50;
/** ZIP Central Directory File Header 시그니처 (리틀 엔디언 0x02014b50) */
const CDFH_SIG = 0x02014b50;
/** EOCD 최소 크기(주석 없음) */
const EOCD_MIN_SIZE = 22;
/** EOCD 탐색 최대 범위 (주석 최대 65535 바이트 + EOCD 22바이트) */
const EOCD_SCAN_MAX = 65535 + EOCD_MIN_SIZE;

/**
 * ZIP 중앙 디렉터리 메타데이터만 읽어 압축 해제 크기 합산이 한도를 초과하는지 검사한다.
 * 파일을 실제로 해제하지 않으므로 안전하다.
 *
 * - ZIP 시그니처(PK)가 없으면 ZIP이 아닌 것으로 간주하고 통과시킨다(비-ZIP은 kordoc가 처리).
 * - ZIP64 엔트리(uncompressed size == 0xFFFFFFFF)는 비정상 .hwpx 파일에서 나타날 수 없으므로
 *   즉시 KodocError를 던진다.
 * - 파싱 중 범위를 벗어나는 오프셋 등 손상된 ZIP 구조는 throw 대신 return으로 관대하게 처리해
 *   kordoc가 이후 단계에서 적절한 오류를 반환하도록 위임한다.
 *
 * @param buf            검사할 파일 버퍼
 * @param maxUncompressed 압축 해제 크기 합산 한도 (기본값: 1 GB)
 * @throws KodocError — 합산이 한도를 초과하거나 ZIP64 엔트리가 감지된 경우
 */
export function assertZipNotBomb(
  buf: Buffer | Uint8Array,
  maxUncompressed = MAX_UNCOMPRESSED_ZIP_BYTES,
): void {
  const len = buf.length;
  // 최소 EOCD 크기에도 미치지 못하면 ZIP이 아니므로 통과
  if (len < EOCD_MIN_SIZE) return;

  // ZIP 시그니처 "PK" 확인 (선두 2바이트)
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return;

  const view = new DataView(buf.buffer, buf.byteOffset, len);

  // ── EOCD 탐색 (파일 끝에서 역방향) ──────────────────────────
  // EOCD는 파일의 마지막 EOCD_SCAN_MAX 바이트 안에 반드시 존재한다.
  const scanStart = Math.max(0, len - EOCD_SCAN_MAX);
  let eocdOffset = -1;
  for (let i = len - EOCD_MIN_SIZE; i >= scanStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  // EOCD를 찾지 못하면 ZIP 구조가 손상된 것 — 관대하게 통과 (kordoc에 위임)
  if (eocdOffset < 0) return;

  // EOCD 파싱: 중앙 디렉터리 시작 오프셋(+16, 4바이트).
  // 주의: EOCD의 엔트리 수(+10)는 위조 가능하므로 신뢰하지 않는다 — CDFH 시그니처가
  // 이어지는 동안 중앙 디렉터리를 끝까지 순회해 "모든" 엔트리를 합산한다.
  if (eocdOffset + 22 > len) return; // 범위 초과 — 손상된 ZIP, 관대하게 통과
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // 중앙 디렉터리 오프셋이 범위를 벗어나면 관대하게 통과
  if (cdOffset + 46 > len) return;

  // ── 중앙 디렉터리 순회 (entryCount 미신뢰, CDFH 시그니처 체인 추적) ──────────
  let pos = cdOffset;
  let totalUncompressed = 0;
  const MAX_ENTRIES = 1_000_000; // 무한 루프 방지용 안전 상한

  for (let i = 0; i < MAX_ENTRIES; i++) {
    // 헤더(46바이트)를 못 읽거나 시그니처가 CDFH가 아니면 중앙 디렉터리 끝
    if (pos + 46 > len) break;
    if (view.getUint32(pos, true) !== CDFH_SIG) break;

    // uncompressed size: 헤더 시작 +24, 4바이트 리틀 엔디언
    const uncompressedSize = view.getUint32(pos + 24, true);

    // ZIP64 마커(0xFFFFFFFF): 일반 .hwpx에는 존재하지 않으므로 비정상 파일로 간주
    if (uncompressedSize === 0xffffffff) {
      throw new KodocError(
        "문서 압축 해제 크기가 너무 큽니다(손상되었거나 비정상 파일).",
        "신뢰할 수 있는 원본인지 확인하세요.",
      );
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressed) {
      const maxGb = Math.round(maxUncompressed / (1024 * 1024 * 1024));
      throw new KodocError(
        `문서 압축 해제 크기가 너무 큽니다(합산 ${Math.round(totalUncompressed / (1024 * 1024))}MB, 최대 ${maxGb}GB).`,
        "신뢰할 수 있는 원본인지 확인하세요.",
      );
    }

    // 다음 헤더로 이동: 46바이트 고정부 + 파일명(+28) + 추가필드(+30) + 주석(+32)
    const fileNameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    pos += 46 + fileNameLen + extraLen + commentLen;
  }
}

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

  // Windows 파일명 호환성 가드 — macOS/Linux에서 만든 이름이 Windows에서 깨지지 않게.
  // (resolveSafePath는 OS 무관 로직이므로 어느 플랫폼에서든 동일하게 거부한다.)
  assertWindowsSafeBasename(basename(real));

  return real;
}

/** Windows 예약 디바이스명 (대소문자 무시, 확장자 유무 무관) */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 파일명이 Windows에서 안전한지 검증한다.
 *
 * - 예약 디바이스명(CON/PRN/AUX/NUL/COM1..9/LPT1..9)은 확장자가 붙어도 거부한다.
 * - basename이 점(.) 또는 공백으로 끝나면 거부한다(Windows는 무음으로 절단해 다른 파일을 덮어쓸 수 있음).
 *
 * @param name 검증할 basename (디렉터리 구분자 제외)
 * @throws KodocError — 예약명이거나 후행 점·공백인 경우
 */
function assertWindowsSafeBasename(name: string): void {
  if (WINDOWS_RESERVED_NAME.test(name)) {
    throw new KodocError(
      `사용할 수 없는 파일명입니다: ${name}`,
      "Windows 예약 이름(CON/PRN/NUL 등)이나 점·공백으로 끝나는 이름은 피하세요.",
    );
  }
  if (name.length > 0 && (name.endsWith(".") || name.endsWith(" "))) {
    throw new KodocError(
      `사용할 수 없는 파일명입니다: ${name}`,
      "Windows 예약 이름(CON/PRN/NUL 등)이나 점·공백으로 끝나는 이름은 피하세요.",
    );
  }
}
