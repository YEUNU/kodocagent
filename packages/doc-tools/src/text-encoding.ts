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
 * 3) 유효한 UTF-8이 아님 →
 *    3a) NUL(0x00) 바이트가 있으면 UTF-16(무BOM) 가능성 → LE/BE/CP949 중 제어·치환·NUL
 *        문자가 가장 적은(=가장 그럴듯한) 디코딩을 선택(무BOM UTF-16 모지바케 방지).
 *    3b) 그 외 → 한국어 레거시(CP949/Windows-949, UHC 포함) 폴백.
 *
 * 한계(주석): 입력이 매우 짧고 우연히 유효한 UTF-8이기도 한 CP949 바이트열(예: 단일 음절
 *   c2 a1='징'이 UTF-8 '¡'와 충돌)은 2)에서 UTF-8로 판정될 수 있다. 짧은 입력의 본질적
 *   인코딩 모호성으로, UTF-8 우선판정을 깨면 정상 단문 UTF-8을 해치므로 의도적으로 보존한다.
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
    // 3a) NUL 바이트 존재 → UTF-16(무BOM) 후보를 CP949와 함께 평가해 가장 깨끗한 디코딩 선택
    if (b.some((x) => x === 0x00)) {
      const candidates = [
        { encoding: "utf-16le", text: new TextDecoder("utf-16le").decode(b) },
        { encoding: "utf-16be", text: new TextDecoder("utf-16be").decode(b) },
        { encoding: "cp949", text: iconv.decode(Buffer.from(b), "cp949") },
      ];
      candidates.sort((x, y) => decodeGarbageScore(x.text) - decodeGarbageScore(y.text));
      // biome-ignore lint/style/noNonNullAssertion: 후보 배열은 항상 3개로 비어있지 않음
      const best = candidates[0]!;
      return { text: best.text, encoding: best.encoding };
    }
    // 3b) NUL 없음 → CP949/UHC 폴백 (iconv-lite는 UHC 확장 음절 전체 지원)
    return { text: iconv.decode(Buffer.from(b), "cp949"), encoding: "cp949" };
  }
}

/**
 * 디코딩 결과의 "그럴듯하지 않은 정도" — 낮을수록 그럴듯. NUL·제어·치환문자에 큰 페널티,
 * 그리고 흔한 한국어 문서 문자 범위(ASCII·한글·CJK·CJK구두점·전각) 밖 문자에 페널티.
 * 후자는 BOM 없는 UTF-16 의 LE/BE 판별에서 결정적(반대 엔디안 오독은 희귀 CJK/PUA 를 낳음).
 */
function decodeGarbageScore(s: string): number {
  let score = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0xfffd) score += 2;
    else if (c === 0x00) score += 3;
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) score += 1;
    else if (!isCommonDocChar(c)) score += 1;
  }
  return score;
}

/** 한국어 문서에 흔히 등장하는 코드포인트 범위인지. */
function isCommonDocChar(c: number): boolean {
  return (
    c === 0x09 || c === 0x0a || c === 0x0d || // 탭/개행
    (c >= 0x20 && c <= 0x7e) || // ASCII 인쇄가능
    (c >= 0xac00 && c <= 0xd7a3) || // 한글 음절
    (c >= 0x1100 && c <= 0x11ff) || // 한글 자모
    (c >= 0x3130 && c <= 0x318f) || // 한글 호환 자모
    (c >= 0x4e00 && c <= 0x9fff) || // CJK 통합 한자(상용)
    (c >= 0x3000 && c <= 0x303f) || // CJK 기호·구두점(《》「」 등)
    (c >= 0xff00 && c <= 0xffef) || // 전각 형태
    c === 0x20a9 // ₩
  );
}
