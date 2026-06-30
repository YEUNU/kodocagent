/**
 * kordoc RAW parse 결정적 손상 게이트 (LLM·외부 바이너리 불요 — 항상 실행)
 *
 * 배경: kordoc 의 도형 대체텍스트 스트립 정규식이 미앵커면 본문의 "(키워드)입니다" 꼬리를
 * 어디서든 잘라낸다(예: "1730000원입니다"→"1730000" — won "원"을 도형 "원"으로 오인,
 * "발표입니다 그리고 끝"→"발 그리고 끝"). 우리 patches/kordoc@*.patch 의 `^…$` 앵커가
 * 이를 막는다. **이 테스트는 우리 patch 가 실제로 적용됐는지(=raw kordoc 무손상)를 검증한다.**
 *
 * ⚠️ 왜 raw kordoc 인가: 우리 doc-tools `parse()` 래퍼(kordoc-parse.ts)는 읽기 경로에서
 * 과제거된 꼬리를 복원하므로, 래퍼를 통하면 미패치 kordoc 도 통과해 손상을 **가린다**.
 * 그러나 편집 경로(patchHwpx/patchHwp)는 내부에서 raw kordoc parse 를 쓰므로 가드가 안 닿고
 * patch 에만 의존한다. 따라서 게이트는 반드시 **raw kordoc**(직접 import)로 검증해야 한다.
 *
 * 합성 픽스처(markdownToHwpx 생성)가 이 손상 클래스를 그대로 재현함을 실증 확인했다:
 *   patched 3.4.1 → 전부 보존 / unpatched 3.5.4 → 전부 손상(원입니다·목표입니다·번호입니다…).
 * 따라서 kordoc 업그레이드/재패치 시 이 테스트가 raw 손상 회귀의 게이트가 된다.
 */
import { markdownToHwpx, parse } from "kordoc";
import { describe, expect, it } from "vitest";

/** 도형/금액 키워드 + "입니다" 꼬리가 본문에서 보존돼야 하는 케이스(미앵커 정규식이면 잘림). */
const PRESERVE_CASES: string[] = [
  // 금액: won "원"을 도형 "원"으로 오인 → "원입니다." 드롭
  "총액은 1730000원입니다.",
  "수수료는 5000원입니다.",
  "단위는 원입니다.",
  // 합성어 trailing: 표/별/선/형/개체 등으로 끝나는 합성어
  "이것은 목표입니다",
  "오늘 오후에 발표입니다",
  "다음은 도표입니다",
  "여기는 도시의 공원입니다", // 원
  "이것은 별표입니다", // 별/표
  "저것은 곡선입니다", // 선
  "이 선은 직선입니다", // 선
  "화면의 화살표입니다", // 화살표
  // 호(arc)로 끝나는 다음절 합성어
  "주문 번호입니다",
  "특수 기호입니다",
  "이것은 비밀 암호입니다",
  "녹색 신호입니다",
  // mid-text: 키워드+입니다 뒤에 본문이 더 있는 최악 케이스(중간 절단)
  "발표입니다 그리고 끝",
  "목표입니다만 아직 멀었다",
  // multi-keyword 한 문장
  "목표입니다. 그리고 도표입니다.",
];

async function rawParseText(markdown: string): Promise<string> {
  const ab = await markdownToHwpx(markdown);
  const u8 = new Uint8Array(ab instanceof ArrayBuffer ? ab : (ab as Uint8Array));
  const result = await parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  if (!result.success || typeof result.markdown !== "string") {
    throw new Error(`parse 실패: ${(result as { error?: string }).error ?? "unknown"}`);
  }
  return result.markdown.trim();
}

describe("kordoc RAW 손상 게이트 — 본문 (키워드)입니다 보존", () => {
  for (const text of PRESERVE_CASES) {
    it(`보존: ${JSON.stringify(text)}`, async () => {
      const out = await rawParseText(text);
      // raw kordoc(우리 patch 적용)가 본문을 그대로 보존해야 한다.
      // 미패치면 꼬리/중간이 잘려 실패한다(회귀 게이트).
      expect(out).toBe(text);
    });
  }
});
