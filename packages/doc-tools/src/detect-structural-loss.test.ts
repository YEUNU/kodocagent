/**
 * detectStructuralLoss 단위 테스트 — 순수 함수, WASM 불필요
 *
 * 테스트 시나리오:
 * 1. 동일 히스토그램 → lost:false
 * 2. after에서 표 1개 감소 (10→9) → lost:true, detail에 "표" 포함
 * 3. after에서 단락 + 이미지 모두 감소 → lost:true, detail에 둘 다 나열
 * 4. after에서 특정 타입 증가 → lost:false (false-positive 없음)
 * 5. 빈 before + 빈 after → lost:false
 * 6. before에 없는 타입이 after에만 있음 → lost:false
 */

import type { IRBlock } from "@clazic/kordoc";
import { describe, expect, it } from "vitest";
import { detectStructuralLoss } from "./rhwp-engine.js";

// ─────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────

function makeBlocks(spec: Array<{ type: IRBlock["type"]; count: number }>): IRBlock[] {
  const blocks: IRBlock[] = [];
  for (const { type, count } of spec) {
    for (let i = 0; i < count; i++) {
      blocks.push({ type } as IRBlock);
    }
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────

describe("detectStructuralLoss — 순수 함수 단위 테스트", () => {
  it("동일 히스토그램 → lost:false", () => {
    const before = makeBlocks([
      { type: "paragraph", count: 20 },
      { type: "table", count: 10 },
      { type: "image", count: 3 },
    ]);
    const after = makeBlocks([
      { type: "paragraph", count: 20 },
      { type: "table", count: 10 },
      { type: "image", count: 3 },
    ]);
    const result = detectStructuralLoss(before, after);
    expect(result.lost).toBe(false);
    expect(result.detail).toBe("");
  });

  it("after에서 표 1개 감소 (10→9) → lost:true, detail에 '표' 포함", () => {
    const before = makeBlocks([
      { type: "paragraph", count: 20 },
      { type: "table", count: 10 },
    ]);
    const after = makeBlocks([
      { type: "paragraph", count: 20 },
      { type: "table", count: 9 },
    ]);
    const result = detectStructuralLoss(before, after);
    expect(result.lost).toBe(true);
    expect(result.detail).toContain("표");
    expect(result.detail).toContain("10→9");
  });

  it("after에서 단락 + 이미지 모두 감소 → lost:true, detail에 둘 다 나열", () => {
    const before = makeBlocks([
      { type: "paragraph", count: 38 },
      { type: "table", count: 5 },
      { type: "image", count: 4 },
    ]);
    const after = makeBlocks([
      { type: "paragraph", count: 33 },
      { type: "table", count: 5 },
      { type: "image", count: 2 },
    ]);
    const result = detectStructuralLoss(before, after);
    expect(result.lost).toBe(true);
    expect(result.detail).toContain("단락");
    expect(result.detail).toContain("이미지");
    // 38→33 단락 손실
    expect(result.detail).toContain("38→33");
    // 4→2 이미지 손실
    expect(result.detail).toContain("4→2");
  });

  it("after에서 특정 타입만 증가 → lost:false (false-positive 없음)", () => {
    const before = makeBlocks([
      { type: "paragraph", count: 10 },
      { type: "table", count: 3 },
    ]);
    const after = makeBlocks([
      { type: "paragraph", count: 15 }, // 증가
      { type: "table", count: 3 },
    ]);
    const result = detectStructuralLoss(before, after);
    expect(result.lost).toBe(false);
    expect(result.detail).toBe("");
  });

  it("빈 before + 빈 after → lost:false", () => {
    const result = detectStructuralLoss([], []);
    expect(result.lost).toBe(false);
    expect(result.detail).toBe("");
  });

  it("before에 없는 타입이 after에만 있음 → lost:false", () => {
    const before = makeBlocks([{ type: "paragraph", count: 5 }]);
    const after = makeBlocks([
      { type: "paragraph", count: 5 },
      { type: "table", count: 2 }, // 새로 생긴 경우
    ]);
    const result = detectStructuralLoss(before, after);
    expect(result.lost).toBe(false);
    expect(result.detail).toBe("");
  });

  it("표 0개에서 0개로 (손실 없음) → lost:false", () => {
    const before = makeBlocks([{ type: "paragraph", count: 5 }]);
    const after = makeBlocks([{ type: "paragraph", count: 5 }]);
    const result = detectStructuralLoss(before, after);
    expect(result.lost).toBe(false);
  });

  it("kordoc 블록 38→33, 표 10→9 (실제 버그 재현 시나리오) → lost:true", () => {
    const before = makeBlocks([
      { type: "paragraph", count: 28 },
      { type: "table", count: 10 },
    ]);
    const after = makeBlocks([
      { type: "paragraph", count: 24 },
      { type: "table", count: 9 },
    ]);
    const result = detectStructuralLoss(before, after);
    expect(result.lost).toBe(true);
    expect(result.detail).toContain("표");
    expect(result.detail).toContain("단락");
  });
});
