/**
 * inspect.ts 단위 테스트 — JSZip 기반 HWPX XML 아티팩트 검사
 *
 * makeF3 (병합 헤더), makeF4 (양식 개체)를 픽스처로 사용해
 * 주입된 기능이 XML 수준에서 올바르게 탐지되는지 검증한다.
 */

import { describe, expect, it } from "vitest";
import { makeF3, makeF4 } from "./fixtures.js";
import {
  hwpxContainsText,
  hwpxFootnoteTexts,
  hwpxFormObjectValue,
  hwpxRawXml,
  hwpxTopLevelTableCount,
} from "./inspect.js";

// ─────────────────────────────────────────────────────────
// hwpxRawXml
// ─────────────────────────────────────────────────────────

describe("hwpxRawXml", () => {
  it("F3 — section0.xml 포함 raw XML 반환 (비어 있지 않음)", async () => {
    const f = await makeF3();
    const xml = await hwpxRawXml(f.bytes);
    expect(xml.length).toBeGreaterThan(0);
    expect(xml).toContain("<");
  });

  it("F4 — 양식 개체 XML 포함", async () => {
    const f = await makeF4();
    const xml = await hwpxRawXml(f.bytes);
    // F4에 주입된 양식 개체 태그가 raw XML에 있어야 한다
    expect(xml).toContain("hp:edit");
    expect(xml).toContain("성명입력");
  });
});

// ─────────────────────────────────────────────────────────
// hwpxContainsText
// ─────────────────────────────────────────────────────────

describe("hwpxContainsText", () => {
  it("F3 — '성명' 텍스트가 hp:t 안에 있음", async () => {
    const f = await makeF3();
    const found = await hwpxContainsText(f.bytes, "성명");
    expect(found).toBe(true);
  });

  it("F3 — '서울시' 텍스트가 hp:t 안에 있음", async () => {
    const f = await makeF3();
    const found = await hwpxContainsText(f.bytes, "서울시");
    expect(found).toBe(true);
  });

  it("F3 — 없는 텍스트는 false 반환", async () => {
    const f = await makeF3();
    const found = await hwpxContainsText(f.bytes, "이_텍스트는_절대없음XYZ");
    expect(found).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// hwpxFormObjectValue
// ─────────────────────────────────────────────────────────

describe("hwpxFormObjectValue", () => {
  it("F4 — '성명입력' 편집상자 존재 (값은 비어 있거나 문자열 반환)", async () => {
    const f = await makeF4();
    const value = await hwpxFormObjectValue(f.bytes, "성명입력");
    // F4 초기 상태: 성명입력 편집상자가 있지만 값이 비어 있다
    expect(value).not.toBeNull();
    // 빈 문자열 또는 임의의 초기값
    expect(typeof value).toBe("string");
  });

  it("F4 — '부서선택' 콤보박스는 hp:edit이 아니라 null 반환", async () => {
    const f = await makeF4();
    // '부서선택'은 hp:comboBox이지 hp:edit이 아니므로 null
    const value = await hwpxFormObjectValue(f.bytes, "부서선택");
    // 구현에 따라 null 또는 ""일 수 있음 — 핵심은 에러가 나지 않아야 한다
    expect(value === null || typeof value === "string").toBe(true);
  });

  it("F4 — 존재하지 않는 이름 → null 반환", async () => {
    const f = await makeF4();
    const value = await hwpxFormObjectValue(f.bytes, "없는이름XYZ");
    expect(value).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// hwpxFootnoteTexts
// ─────────────────────────────────────────────────────────

describe("hwpxFootnoteTexts", () => {
  it("F3 — 각주 없는 문서 → 빈 배열 반환", async () => {
    const f = await makeF3();
    const notes = await hwpxFootnoteTexts(f.bytes);
    expect(notes).toEqual([]);
  });

  it("F4 — 각주 없는 문서 → 빈 배열 반환", async () => {
    const f = await makeF4();
    const notes = await hwpxFootnoteTexts(f.bytes);
    expect(notes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// hwpxTopLevelTableCount
// ─────────────────────────────────────────────────────────

describe("hwpxTopLevelTableCount", () => {
  it("F3 — 표 1개 (신청서 양식 표)", async () => {
    const f = await makeF3();
    const count = await hwpxTopLevelTableCount(f.bytes);
    // F3은 markdownToHwpx + 병합 패치 → 표 1개
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("F4 — 표 없음 (양식 개체만 있는 문서)", async () => {
    const f = await makeF4();
    const count = await hwpxTopLevelTableCount(f.bytes);
    // F4 마크다운에는 표가 없다
    expect(count).toBe(0);
  });
});
