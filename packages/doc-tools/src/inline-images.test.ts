import { describe, expect, it } from "vitest";
import { inlineImagesAsDataUri, type ParsedImage } from "./inline-images.js";

const png = (bytes: number[]): ParsedImage => ({
  filename: "image_001.png",
  data: new Uint8Array(bytes),
  mimeType: "image/png",
});

describe("inlineImagesAsDataUri", () => {
  it("상대 src 를 추출된 그림 바이트의 data URI 로 치환한다", () => {
    const html = `<p><img src="image_001.png" alt="image"></p>`;
    const out = inlineImagesAsDataUri(html, [png([1, 2, 3])]);
    expect(out).toContain("data:image/png;base64,");
    expect(out).not.toContain('src="image_001.png"');
    // base64(of 0x01 0x02 0x03) === "AQID"
    expect(out).toContain("data:image/png;base64,AQID");
  });

  it("매칭되는 이미지가 없으면 그대로 둔다(비파괴적)", () => {
    const html = `<img src="missing.png">`;
    expect(inlineImagesAsDataUri(html, [png([1])])).toBe(html);
  });

  it("이미 data:/원격/절대 URL 은 건드리지 않는다", () => {
    const html = `<img src="data:image/png;base64,AAAA"><img src="https://x/y.png">`;
    expect(inlineImagesAsDataUri(html, [png([1])])).toBe(html);
  });

  it("마지막 경로 세그먼트로도 매칭한다(중첩 경로 src)", () => {
    const html = `<img src="bin/image_001.png">`;
    const out = inlineImagesAsDataUri(html, [png([255])]);
    expect(out).toContain("data:image/png;base64,/w=="); // 0xFF
  });

  it("images 가 비었거나 없으면 원본 HTML 을 그대로 반환한다", () => {
    const html = `<img src="image_001.png">`;
    expect(inlineImagesAsDataUri(html, [])).toBe(html);
    expect(inlineImagesAsDataUri(html, undefined)).toBe(html);
  });

  it("ArrayBuffer 데이터도 처리한다", () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    const out = inlineImagesAsDataUri(`<img src="image_001.png">`, [
      { filename: "image_001.png", data: ab, mimeType: "image/png" },
    ]);
    expect(out).toContain("data:image/png;base64,AQID");
  });
});
