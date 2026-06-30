import type { IRBlock } from "kordoc";
import { describe, expect, it } from "vitest";
import { compareFingerprints, computeStructuralFingerprint } from "./structural-fingerprint.js";

const para = (text: string): IRBlock => ({ type: "paragraph", text }) as IRBlock;
const heading = (level: number, text: string): IRBlock =>
  ({ type: "heading", level, text }) as IRBlock;
const table = (rows: number, cols: number, hasHeader = true): IRBlock =>
  ({ type: "table", table: { rows, cols, hasHeader, cells: [] } }) as IRBlock;
const image = (): IRBlock => ({ type: "image" }) as IRBlock;

describe("computeStructuralFingerprint", () => {
  it("블록 히스토그램·제목 계층·표 격자를 캡처한다", () => {
    const fp = computeStructuralFingerprint([
      heading(1, "제목"),
      para("본문"),
      table(3, 2),
      table(5, 4, false),
      image(),
    ]);
    expect(fp.blockHistogram).toEqual({ heading: 1, paragraph: 1, table: 2, image: 1 });
    expect(fp.headingOutline).toEqual([{ level: 1, text: "제목" }]);
    expect(fp.tables).toEqual([
      { rows: 3, cols: 2, hasHeader: true },
      { rows: 5, cols: 4, hasHeader: false },
    ]);
    expect(fp.imageCount).toBe(1);
  });

  it("항목부호 체계를 추정한다 — 보고서(□○-)", () => {
    const fp = computeStructuralFingerprint([para("□ 목적"), para("○ 세부"), para("- 항목")]);
    expect(fp.numberingStyle).toBe("보고서(□ ○ -)");
  });

  it("항목부호 체계를 추정한다 — 법정(1. 가.)", () => {
    const fp = computeStructuralFingerprint([para("1. 총칙"), para("가. 목적"), para("2. 적용")]);
    expect(fp.numberingStyle).toBe("법정(1. 가. 1) …)");
  });
});

describe("compareFingerprints — 양식 drift", () => {
  it("동일 구조는 drift 없음(텍스트만 달라도)", () => {
    const a = computeStructuralFingerprint([heading(1, "옛 제목"), para("a"), table(3, 2)]);
    const b = computeStructuralFingerprint([heading(1, "새 제목"), para("b"), table(3, 2)]);
    expect(compareFingerprints(a, b).drift).toBe(false);
  });

  it("표 격자 변화를 drift로 보고한다", () => {
    const a = computeStructuralFingerprint([table(3, 2)]);
    const b = computeStructuralFingerprint([table(4, 2)]);
    const d = compareFingerprints(a, b);
    expect(d.drift).toBe(true);
    expect(d.details.join()).toContain("표 1 격자 3×2→4×2");
  });

  it("블록 손실(표 삭제)을 drift로 보고한다", () => {
    const a = computeStructuralFingerprint([para("a"), table(3, 2)]);
    const b = computeStructuralFingerprint([para("a")]);
    const d = compareFingerprints(a, b);
    expect(d.drift).toBe(true);
    expect(d.details.join()).toContain("표 1→0");
  });

  it("이미지 손실을 drift로 보고한다", () => {
    const a = computeStructuralFingerprint([para("a"), image()]);
    const b = computeStructuralFingerprint([para("a")]);
    expect(compareFingerprints(a, b).details.join()).toContain("이미지 1→0");
  });
});
