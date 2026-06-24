/**
 * kordoc renderHtml 이미지 인라인
 *
 * kordoc `parse()` 는 문서에 박힌 그림을 바이트로 추출해 `result.images`
 * (`[{ filename, data, mimeType }]`) 로 돌려주고, 마크다운엔 `![alt](image_001.png)`
 * 같은 상대 참조만 남긴다. `renderHtml()` 은 그걸 `<img src="image_001.png">` 로 만든다.
 * 미리보기 iframe 이나 내보낸 HTML 에는 그 파일이 없으므로 이미지가 깨져 alt("image")만 뜬다.
 *
 * 이 헬퍼는 그 상대 `src` 를 추출된 바이트의 data URI 로 치환해, HTML 이 외부 파일 없이
 * 자체 완결되게 한다(미리보기·HTML 내보내기 공용).
 */

export interface ParsedImage {
  filename: string;
  /** 그림 바이트 (kordoc 은 Uint8Array/ArrayBuffer 로 준다) */
  data: ArrayBuffer | Uint8Array | ArrayLike<number>;
  mimeType: string;
}

/** 이미 인라인/원격/절대 URL 이면 건드리지 않는다. */
const ALREADY_RESOLVED = /^(data:|https?:|file:|blob:)/i;

/**
 * renderHtml 결과의 `<img src="파일명">` 을 result.images 의 data URI 로 인라인한다.
 * 매칭되는 이미지가 없거나 이미 절대/데이터 URL 이면 그대로 둔다(비파괴적).
 */
export function inlineImagesAsDataUri(
  html: string,
  images: readonly ParsedImage[] | undefined,
): string {
  if (!images || images.length === 0) return html;

  const byName = new Map<string, ParsedImage>();
  for (const im of images) {
    if (im?.filename) byName.set(im.filename, im);
  }

  return html.replace(
    /(<img\b[^>]*?\bsrc=)(["'])([^"']*)\2/gi,
    (match: string, pre: string, quote: string, src: string): string => {
      if (ALREADY_RESOLVED.test(src)) return match;
      // 정확한 파일명 → URL 디코딩본 → 마지막 경로 세그먼트 순으로 매칭
      const im =
        byName.get(src) ??
        byName.get(safeDecode(src)) ??
        byName.get(src.split(/[/\\]/).pop() ?? src);
      if (!im?.data) return match;
      const bytes =
        im.data instanceof Uint8Array ? im.data : new Uint8Array(im.data as ArrayBuffer);
      const b64 = Buffer.from(bytes).toString("base64");
      return `${pre}${quote}data:${im.mimeType || "image/png"};base64,${b64}${quote}`;
    },
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
