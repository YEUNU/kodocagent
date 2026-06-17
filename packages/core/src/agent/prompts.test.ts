/**
 * buildSystemPrompt 단위 테스트 — 특히 "능력·한계" 섹션의 "가능" 자동 도출.
 *
 * "가능" 목록은 손-목록이 아니라 전달된 toolNames(레지스트리)에서 생성되므로,
 * 도구가 추가/변경되면 자동 반영된다(드리프트 방지). 이 테스트가 그 배선을 지킨다.
 */

import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompts.js";

const base = { cwd: "/tmp/x", mcpServers: [], openDocuments: [] };

describe("buildSystemPrompt — 능력·한계 '가능' 자동 도출", () => {
  it("전달된 도구 이름이 '가능' 섹션에 모두 반영된다(드리프트 방지)", () => {
    const toolNames = [
      "read_document",
      "propose_edit",
      "propose_find_replace",
      "propose_cell_edit",
      "propose_redact_pii",
    ];
    const prompt = buildSystemPrompt({ ...base, toolNames });
    expect(prompt).toContain("능력·한계");
    for (const name of toolNames) {
      expect(prompt).toContain(name);
    }
  });

  it("MCP 도구(mcp__*)는 stable prefix 캐시를 위해 '가능' 목록에서 제외되고 일반 안내로 대체된다", () => {
    const prompt = buildSystemPrompt({
      ...base,
      toolNames: ["read_document", "mcp__korean-law__search_law"],
    });
    expect(prompt).toContain("read_document");
    expect(prompt).not.toContain("mcp__korean-law__search_law");
    expect(prompt).toContain("MCP 도구");
  });

  it("toolNames가 비어도 안전하게 생성된다", () => {
    const prompt = buildSystemPrompt({ ...base, toolNames: [] });
    expect(prompt).toContain("능력·한계");
    expect(prompt).toContain("(없음)");
  });
});
