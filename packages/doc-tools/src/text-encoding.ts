/**
 * 텍스트 파일 인코딩 감지 및 디코딩 헬퍼
 *
 * UTF-16/UTF-8은 Node 내장 TextDecoder로 처리하고, 한국어 레거시 인코딩은
 * iconv-lite의 "cp949"(=Windows-949/UHC, 한글 11,172자 전체)로 디코딩한다.
 *
 * 주의: Node의 TextDecoder("euc-kr")는 WHATWG 사양과 달리 CP949/UHC 확장 영역
 * (선두 바이트 0x81–0xA0, 약 8,800 음절)을 디코딩하지 못해 실제 한국 Windows
 * 기본 인코딩(CP949) 파일의 흔한 한글이 깨진다. 따라서 폴백은 iconv-lite를 쓴다.
 */

import iconv from "iconv-lite";

/**
 * 텍스트 파일 바이트를 인코딩 감지해 UTF-8 문자열로 디코딩한다.
 *
 * 감지 순서:
 * 1) UTF-16 BOM (FF FE → UTF-16LE, FE FF → UTF-16BE)
 * 2) UTF-8 strict — TextDecoder fatal 모드로 검증; 유효하면 그대로 (BOM 자동 제거)
 * 3) 유효한 UTF-8이 아님 → 한국어 레거시(CP949/Windows-949, UHC 포함) 폴백
 */
export function decodeTextFile(buf: Buffer | Uint8Array): { text: string; encoding: string } {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // 1) UTF-16 BOM
  if (b.length >= 2) {
    if (b[0] === 0xff && b[1] === 0xfe)
      return { text: new TextDecoder("utf-16le").decode(b), encoding: "utf-16le" };
    if (b[0] === 0xfe && b[1] === 0xff)
      return { text: new TextDecoder("utf-16be").decode(b), encoding: "utf-16be" };
  }
  // 2) UTF-8 strict (BOM은 TextDecoder가 자동 제거) — 유효하면 그대로
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(b), encoding: "utf-8" };
  } catch {
    // 3) 유효한 UTF-8이 아님 → CP949/UHC 폴백 (iconv-lite는 UHC 확장 음절 전체 지원)
    return { text: iconv.decode(Buffer.from(b), "cp949"), encoding: "cp949" };
  }
}
