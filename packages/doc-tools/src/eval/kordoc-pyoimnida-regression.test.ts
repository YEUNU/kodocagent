/**
 * 회귀 테스트 — kordoc parse() 의 '표입니다' 무성 드롭 버그.
 *
 * 근본원인: kordoc 가 도형/이미지 대체텍스트("사각형입니다." 등)를 제거하는
 *   전역(/g) 정규식이 앵커 없이 본문 전체에 적용되어, 도형 키워드(표·그림·원·별…)
 *   로 끝나는 합성어("목표입니다"·"공원입니다"·"발표입니다")의 꼬리까지 잘라냈다.
 *   → 본문 텍스트가 마크다운에서 소실 + patchHwpx 재조정 시 숨은 꼬리 중복.
 *
 * 워크어라운드: patches/kordoc@3.1.1.patch — 해당 정규식 앞에 `(?<![가-힣])`
 *   룩비하인드를 넣어 **선행 한글 음절이 있을 때(=합성어 내부)는 제거하지 않음**.
 *   독립 단락 대체텍스트("사각형입니다.")는 그대로 제거(원 동작 보존).
 *
 * 이 테스트가 깨지면: kordoc 업데이트로 패치가 풀렸거나(pnpm 이 경고),
 *   업스트림이 정규식을 바꾼 것 — patches/kordoc@*.patch 재검토 필요.
 *
 * 상세: docs/EVAL-SET.md §10, 메모리 kordoc-parse-drops-pyoimnida.
 */

import { markdownToHwpx, parse, patchHwpx } from "kordoc";
import { describe, expect, it } from "vitest";
import { makeF1 } from "./fixtures.js";

/** ArrayBuffer/Uint8Array/Buffer 무엇이든 정확한 바이트의 ArrayBuffer로 정규화한다.
 *  (markdownToHwpx/patchHwpx 산출물이 풀링된 Buffer view일 수 있어 .buffer 직접 사용은 위험) */
function toArrayBuffer(x: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (x instanceof ArrayBuffer) return x;
  return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer;
}

async function roundtrip(text: string): Promise<string> {
  const buf = await markdownToHwpx(text);
  const r = await parse(toArrayBuffer(buf));
  if (!r.success) throw new Error(`parse 실패: ${r.error}`);
  return r.markdown;
}

describe("kordoc '표입니다' 드롭 회귀 (patches/kordoc@3.1.1.patch)", () => {
  it("도형 키워드로 끝나는 합성어 본문이 보존된다", async () => {
    const cases = [
      "이것은 목표입니다",
      "국민 문화 접근성을 재고하고, AI 도입 효과를 극대화하는 것이 목표입니다.",
      "발표입니다",
      "도표입니다",
      "우리 동네 공원입니다",
      "이것은 도표입니다 끝",
    ];
    for (const c of cases) {
      const out = await roundtrip(c);
      // 공백 정규화 후 핵심 종결어가 살아있는지 확인
      expect(out.replace(/\s+/g, " ")).toContain(c.replace(/\s+/g, " "));
    }
  });

  it("독립 단락 도형 대체텍스트는 여전히 제거된다(원 동작 보존)", async () => {
    for (const alt of ["사각형입니다.", "둥근 사각형입니다.", "타원입니다."]) {
      const out = (await roundtrip(alt)).trim();
      expect(out).toBe("");
    }
  });

  it("patchHwpx 편집 후 '목표입니다'가 중복되지 않는다(#3o 회귀)", async () => {
    const f1 = await makeF1();
    const parsed = await parse(toArrayBuffer(f1.bytes));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // 패치 전이라면 여기서 이미 '목표입니다'가 '목'으로 잘려 있어 실패한다.
    expect(parsed.markdown).toContain("목표입니다");

    // 본문의 다른 곳을 편집(재고→제고)한 뒤 패치 → 재파싱
    const edited = parsed.markdown.replace("재고하고", "제고하고");
    const res = await patchHwpx(f1.bytes, edited);
    expect(res.success).toBe(true);
    if (!res.success || !res.data) return;

    const reparsed = await parse(toArrayBuffer(res.data));
    expect(reparsed.success).toBe(true);
    if (!reparsed.success) return;

    // 꼬리 중복(목표입니다.표입니다.)이 없어야 한다
    expect(reparsed.markdown).not.toContain("목표입니다.표입니다");
    expect(reparsed.markdown).not.toContain("표입니다.표입니다");
    // 편집은 반영되고 본문 종결어는 1회만 존재
    expect(reparsed.markdown).toContain("제고하고");
    expect(reparsed.markdown).toContain("목표입니다");
  });
});
