/**
 * H4 압축 폭탄 가드 — assertZipNotBomb 단위 테스트
 *
 * 1. 정상 .hwpx(markdownToHwpx 생성) → assertZipNotBomb 통과 (no throw)
 * 2. 중앙 디렉터리 uncompressed size 필드를 거대값으로 조작한 가짜 ZIP → KodocError
 * 3. uncompressed size 필드 중 하나를 0xFFFFFFFF(ZIP64 마커)로 설정 → KodocError
 * 4. 비-ZIP 버퍼(PK 시그니처 없음) → 통과 (no throw)
 * 5. 너무 짧은 버퍼 → 통과 (no throw)
 *
 * assertZipNotBomb은 순수 동기 함수이므로 WASM/파일 I/O 불필요.
 */

import { KodocError } from "@kodocagent/shared";
import { markdownToHwpx } from "kordoc";
import { describe, expect, it } from "vitest";
import { assertZipNotBomb } from "./security.js";

// ─────────────────────────────────────────────────────────
// ZIP 구조 조작 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * 실제 ZIP 버퍼에서 중앙 디렉터리(Central Directory File Header)의
 * uncompressed size 필드를 조작한 복사본을 반환한다.
 *
 * EOCD 탐색 → CDFH 위치 → offset +24 (uncompressed size, 4바이트 LE) 수정.
 *
 * @param buf      원본 ZIP 버퍼
 * @param newSize  교체할 uncompressed size 값 (32비트 unsigned)
 * @param entryIdx 조작할 CDFH 엔트리 인덱스 (0-based, 기본 0)
 */
function patchCdfhUncompressedSize(buf: Buffer, newSize: number, entryIdx = 0): Buffer {
  const copy = Buffer.from(buf);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.length);
  const len = copy.length;

  const EOCD_SIG = 0x06054b50;
  const CDFH_SIG = 0x02014b50;
  const EOCD_MIN = 22;
  const SCAN_MAX = 65535 + EOCD_MIN;

  // EOCD 탐색
  let eocdOffset = -1;
  for (let i = len - EOCD_MIN; i >= Math.max(0, len - SCAN_MAX); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found in test buffer");

  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // CDFH 순회
  let pos = cdOffset;
  let count = 0;
  while (pos + 46 <= len) {
    if (view.getUint32(pos, true) !== CDFH_SIG) break;
    if (count === entryIdx) {
      // uncompressed size: +24
      view.setUint32(pos + 24, newSize >>> 0, true);
      return copy;
    }
    const fnLen = view.getUint16(pos + 28, true);
    const exLen = view.getUint16(pos + 30, true);
    const cmLen = view.getUint16(pos + 32, true);
    pos += 46 + fnLen + exLen + cmLen;
    count++;
  }
  throw new Error(`CDFH entry ${entryIdx} not found`);
}

/** EOCD의 "총 엔트리 수"(+10, 2바이트 LE)를 위조한다 — 가드가 이를 신뢰하지 않음을 검증. */
function forgeEocdEntryCount(buf: Buffer, count: number): Buffer {
  const copy = Buffer.from(buf);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.length);
  const len = copy.length;
  const EOCD_SIG = 0x06054b50;
  const EOCD_MIN = 22;
  const SCAN_MAX = 65535 + EOCD_MIN;
  let eocdOffset = -1;
  for (let i = len - EOCD_MIN; i >= Math.max(0, len - SCAN_MAX); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found in test buffer");
  view.setUint16(eocdOffset + 8, count, true); // 이 디스크의 엔트리 수
  view.setUint16(eocdOffset + 10, count, true); // 총 엔트리 수
  return copy;
}

// ─────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────

describe("assertZipNotBomb", () => {
  it("정상 .hwpx는 통과한다", async () => {
    const hwpxBuf = await markdownToHwpx("# 테스트\n\n정상 문서입니다.");
    const buf = Buffer.from(hwpxBuf);
    expect(() => assertZipNotBomb(buf)).not.toThrow();
  });

  it("uncompressed size 합계가 한도를 초과하면 KodocError를 던진다", async () => {
    const hwpxBuf = await markdownToHwpx("# 테스트");
    const buf = Buffer.from(hwpxBuf);
    // 첫 번째 CDFH의 uncompressed size를 1GB + 1바이트로 조작
    const bombed = patchCdfhUncompressedSize(buf, 1024 * 1024 * 1024 + 1);
    expect(() => assertZipNotBomb(bombed, 1024 * 1024 * 1024)).toThrow(KodocError);
  });

  it("uncompressed size가 0xFFFFFFFF(ZIP64 마커)이면 KodocError를 던진다", async () => {
    const hwpxBuf = await markdownToHwpx("# 테스트");
    const buf = Buffer.from(hwpxBuf);
    const bombed = patchCdfhUncompressedSize(buf, 0xffffffff);
    expect(() => assertZipNotBomb(bombed)).toThrow(KodocError);
    expect(() => assertZipNotBomb(bombed)).toThrow("압축 해제 크기");
  });

  it("비-ZIP 버퍼(PK 시그니처 없음)는 통과한다", () => {
    const nonZip = Buffer.from("이것은 ZIP이 아닙니다. 평문 텍스트입니다.");
    expect(() => assertZipNotBomb(nonZip)).not.toThrow();
  });

  it("너무 짧은 버퍼는 통과한다(EOCD 최소 크기 미만)", () => {
    const tooShort = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP 시그니처 4바이트만
    expect(() => assertZipNotBomb(tooShort)).not.toThrow();
  });

  it("Uint8Array 입력도 정상 처리한다", async () => {
    const hwpxBuf = await markdownToHwpx("# 테스트");
    const u8 = new Uint8Array(hwpxBuf);
    expect(() => assertZipNotBomb(u8)).not.toThrow();
  });

  it("maxUncompressed 파라미터를 낮게 설정하면 작은 파일도 차단된다", async () => {
    const hwpxBuf = await markdownToHwpx("# 테스트");
    const buf = Buffer.from(hwpxBuf);
    // 1바이트 한도 — 실제 파일은 반드시 초과
    expect(() => assertZipNotBomb(buf, 1)).toThrow(KodocError);
  });

  it("EOCD 엔트리 수를 위조해도 모든 CDFH를 합산해 폭탄을 차단한다(개수 미신뢰)", async () => {
    const hwpxBuf = await markdownToHwpx("# 테스트\n\n여러 엔트리를 가진 문서");
    let buf = Buffer.from(hwpxBuf);
    // 두 엔트리를 각각 600MB로 조작(개별로는 1GB 한도 미만, 합치면 1.2GB로 초과)
    buf = patchCdfhUncompressedSize(buf, 600 * 1024 * 1024, 0);
    buf = patchCdfhUncompressedSize(buf, 600 * 1024 * 1024, 1);
    // EOCD가 "엔트리 1개"라고 거짓 보고 — entryCount를 신뢰하면 600MB만 합산해 통과(취약).
    buf = forgeEocdEntryCount(buf, 1);
    // 시그니처 체인을 끝까지 순회해 두 엔트리(1.2GB)를 모두 합산 → 1GB 초과로 차단.
    expect(() => assertZipNotBomb(buf, 1024 * 1024 * 1024)).toThrow(KodocError);
  });
});
