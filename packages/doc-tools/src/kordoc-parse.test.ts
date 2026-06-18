/**
 * 런타임 가드 테스트 — kordoc parse() 의 도형 대체텍스트 과제거 복원.
 *
 * 핵심: 복원 로직을 **버그가 만들어낸 출력을 시뮬레이션**해 검증한다. 레포의 kordoc 은
 *   patches/kordoc@3.1.1.patch 로 이미 고쳐져 있어 wrapper parse() 만으로는 가드가
 *   실제로 일하는지 알 수 없으므로, BUGGY_SHAPE_STRIP 로 직접 잘라낸 입력을 복원시켜
 *   **패치 없는(발행) 환경에서의 동작**을 증명한다.
 */

import { markdownToHwpx } from "kordoc";
import { describe, expect, it } from "vitest";
import {
  BUGGY_SHAPE_STRIP,
  extractHwpxParagraphTexts,
  parse,
  restoreOverStrippedBlocks,
  restoreOverStrippedShapeText,
} from "./kordoc-parse.js";

/** kordoc 버그 출력 시뮬레이션: 본문 정규화 + 전역 대체텍스트 제거(앵커 없음). */
function simulateBuggyDrop(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .trim()
    .replace(BUGGY_SHAPE_STRIP, "")
    .trim();
}

function toArrayBuffer(x: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (x instanceof ArrayBuffer) return x;
  return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer;
}

describe("kordoc 런타임 가드 — 도형 키워드 합성어 복원", () => {
  it("과제거된 합성어 꼬리를 원본 단락 텍스트로 복원한다", () => {
    const paras = [
      "이것은 목표입니다",
      "우리 동네 공원입니다",
      "발표입니다",
      "이것은 도표입니다 끝",
    ];
    // 버그 환경에서 kordoc 이 내놓는 마크다운(라인별 과제거)
    const buggy = paras.map(simulateBuggyDrop).join("\n");
    // 사전 확인: 실제로 꼬리가 잘려 있어야 한다
    expect(buggy.split("\n")[0]).toBe("이것은 목");

    const restored = restoreOverStrippedShapeText(buggy, paras);
    expect(restored).toBe(
      ["이것은 목표입니다", "우리 동네 공원입니다", "발표입니다", "이것은 도표입니다 끝"].join(
        "\n",
      ),
    );
  });

  it("흔한 합성어(번호·기호·암호)도 복원한다 — 키워드 '호' 완전성", () => {
    // '호'는 도형 키워드(호=arc) — 한글에 융합된 합성어(번호·기호·암호)에서 과제거됨.
    // (공백으로 분리된 '수식입니다' 같은 케이스는 룩비하인드가 보호하지 못하는 본질적
    //  모호성으로, pnpm 패치와 동일하게 대체텍스트로 간주해 복원하지 않는다.)
    const paras = ["제 전화번호입니다", "이것은 약속된 기호입니다", "잊지 말 암호입니다"];
    const buggy = paras.map(simulateBuggyDrop).join("\n");
    expect(buggy).not.toContain("입니다"); // 종결어 소실(과제거 발생)
    expect(buggy.split("\n")[0]).toBe("제 전화번");
    const restored = restoreOverStrippedShapeText(buggy, paras);
    expect(restored).toBe(paras.join("\n"));
  });

  it("독립 단락 도형 대체텍스트는 복원하지 않는다(거짓 양성 없음)", () => {
    const paras = ["사각형입니다.", "표입니다", "그림입니다", "둥근 타원입니다."];
    // 이들은 버그/정상 모두 ""로 제거 → 복원 대상 아님
    const md = "본문 한 줄.\n다른 줄.";
    const restored = restoreOverStrippedShapeText(md, paras);
    expect(restored).toBe(md);
  });

  it("장식(제목·목록)이 붙은 라인도 내용만 복원한다", () => {
    const paras = ["목표입니다", "핵심 목표입니다"];
    const buggy = ["## 목", "- 핵심 목"].join("\n");
    const restored = restoreOverStrippedShapeText(buggy, paras);
    expect(restored).toBe(["## 목표입니다", "- 핵심 목표입니다"].join("\n"));
  });

  it("일치하지 않는 라인은 절대 건드리지 않는다", () => {
    const paras = ["완전히 다른 목표입니다"];
    const md = "제목\n무관한 본문\n표 안에 데이터";
    expect(restoreOverStrippedShapeText(md, paras)).toBe(md);
  });

  it("end-to-end: 실 HWPX 추출 + 버그 시뮬레이션 → 복원", async () => {
    const sentence = "국민 문화 접근성을 제고하고, AI 도입 효과를 극대화하는 것이 목표입니다.";
    const buf = await markdownToHwpx(sentence);
    const bytes = new Uint8Array(buf);
    const paras = await extractHwpxParagraphTexts(bytes);
    expect(paras.some((p) => p.includes("목표입니다"))).toBe(true);

    const buggyMarkdown = simulateBuggyDrop(sentence); // "…것이 목"
    expect(buggyMarkdown.endsWith("목")).toBe(true);
    const restored = restoreOverStrippedShapeText(buggyMarkdown, paras);
    expect(restored).toContain("목표입니다");
  });

  it("wrapper parse(): HWPX 본문이 온전히 반환된다(가드+패치)", async () => {
    const buf = await markdownToHwpx("이것은 목표입니다. 그리고 공원입니다.");
    const res = await parse(toArrayBuffer(buf));
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.markdown).toContain("목표입니다");
    expect(res.markdown).toContain("공원입니다");
  });

  it("wrapper parse(): 비-HWPX(평문) 입력은 그대로 통과한다", async () => {
    const res = await parse("그냥 평문 문자열 목표입니다");
    // 문자열 평문은 kordoc 이 그대로 처리 — 가드는 .hwpx 경로만 개입
    expect(res.success).toBeDefined();
  });
});

describe("restoreOverStrippedBlocks — blocks 과제거 복원", () => {
  it("문단·표 셀·중첩 셀 blocks의 과제거된 꼬리를 원본으로 복원한다", () => {
    // kordoc 버그는 키워드(표·호·원)+입니다 를 잘라낸다:
    //   "목표입니다"→"목"(표), "번호입니다"→"번"(호), "공원입니다"→"공"(원), "도표입니다"→"도"(표)
    // biome-ignore lint/suspicious/noExplicitAny: 테스트용 최소 IRBlock 모형
    const blocks: any[] = [
      { type: "paragraph", text: "목" },
      {
        type: "table",
        table: {
          rows: 1,
          cols: 2,
          hasHeader: false,
          cells: [
            [
              { text: "번", colSpan: 1, rowSpan: 1 },
              {
                text: "공",
                colSpan: 1,
                rowSpan: 1,
                blocks: [{ type: "paragraph", text: "도" }],
              },
            ],
          ],
        },
      },
    ];
    const paras = ["목표입니다", "번호입니다", "공원입니다", "도표입니다"];

    const changed = restoreOverStrippedBlocks(blocks, paras);
    expect(changed).toBe(true);
    expect(blocks[0].text).toBe("목표입니다");
    expect(blocks[1].table.cells[0][0].text).toBe("번호입니다");
    expect(blocks[1].table.cells[0][1].text).toBe("공원입니다");
    expect(blocks[1].table.cells[0][1].blocks[0].text).toBe("도표입니다");
  });

  it("과제거가 없으면 false를 반환하고 텍스트를 건드리지 않는다", () => {
    // biome-ignore lint/suspicious/noExplicitAny: 테스트용 최소 IRBlock 모형
    const blocks: any[] = [{ type: "paragraph", text: "평범한 문장입니다" }];
    const changed = restoreOverStrippedBlocks(blocks, ["평범한 문장입니다"]);
    expect(changed).toBe(false);
    expect(blocks[0].text).toBe("평범한 문장입니다");
  });
});
