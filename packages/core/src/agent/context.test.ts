/**
 * context.ts — estimateTokens / compactMessages 테스트
 */

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactMessages, estimateTokens } from "./context.js";

// ─────────────────────────────────────────────────────────
// estimateTokens 테스트
// ─────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("빈 배열은 0 토큰을 반환한다", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("문자열 content의 토큰을 올림 추정한다", () => {
    // "abc" = 3자 → ceil(3/3) = 1
    const msgs: ModelMessage[] = [{ role: "user", content: "abc" }];
    expect(estimateTokens(msgs)).toBe(1);
  });

  it("여러 메시지의 토큰 합산이 올바르다", () => {
    // 9자 → ceil(9/3) = 3
    const msgs: ModelMessage[] = [
      { role: "user", content: "abc" }, // 3자
      { role: "assistant", content: "def" }, // 3자
      { role: "user", content: "ghi" }, // 3자
    ];
    expect(estimateTokens(msgs)).toBe(3);
  });

  it("배열 content (텍스트 파트)를 올바르게 합산한다", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "안녕하세요" }, // 5자
        ],
      },
    ];
    // ceil(5/3) = 2
    expect(estimateTokens(msgs)).toBe(2);
  });

  it("tool 메시지의 text output 길이를 올바르게 추정한다", () => {
    const msgs: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "test_tool",
            output: { type: "text", value: "a".repeat(300) }, // 300자
          },
        ],
      },
    ];
    // ceil(300/3) = 100
    expect(estimateTokens(msgs)).toBe(100);
  });

  it("대략적인 근사값 — 긴 문자열 (100자, 올림)", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "a".repeat(100) }];
    // ceil(100/3) = 34
    expect(estimateTokens(msgs)).toBe(34);
  });
});

// ─────────────────────────────────────────────────────────
// compactMessages 테스트
// ─────────────────────────────────────────────────────────

describe("compactMessages", () => {
  /** 대형 tool-result 메시지를 생성하는 헬퍼 */
  function makeToolMsg(toolCallId: string, size: number): ModelMessage {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "read_document",
          output: { type: "text", value: "x".repeat(size) },
        },
      ],
    } as ModelMessage;
  }

  function makeUserMsg(text: string): ModelMessage {
    return { role: "user", content: text };
  }

  function makeAssistantMsg(text: string): ModelMessage {
    return { role: "assistant", content: text };
  }

  it("예산 이하이면 입력 배열을 그대로 반환한다 (동일 참조)", () => {
    const msgs: ModelMessage[] = [makeUserMsg("짧은 메시지"), makeAssistantMsg("응답")];
    const result = compactMessages(msgs, 10000);
    expect(result).toBe(msgs); // 동일 참조
    expect(result.length).toBe(2);
  });

  it("예산 초과 시 메시지 개수는 동일하다 (삭제 금지)", () => {
    // 각 tool-result 30,000자 * 2 = 60,000자 → ~20,000 토큰 → 예산 초과
    // protectFrom = max(0, 10 - 6) = 4 → index 0~3이 압축 대상
    const msgs: ModelMessage[] = [
      makeUserMsg("첫 번째 질문"), // index 0
      makeAssistantMsg("첫 번째 응답"), // index 1
      makeToolMsg("call-1", 30000), // index 2
      makeToolMsg("call-2", 30000), // index 3
      makeUserMsg("두 번째 질문"), // index 4 (보호)
      makeAssistantMsg("두 번째 응답"), // index 5 (보호)
      makeUserMsg("최근 1"), // index 6 (보호)
      makeUserMsg("최근 2"), // index 7 (보호)
      makeUserMsg("최근 3"), // index 8 (보호)
      makeUserMsg("마지막 질문"), // index 9 (보호)
    ];

    const result = compactMessages(msgs, 5000);
    // 메시지 개수는 동일
    expect(result.length).toBe(msgs.length);
  });

  it("오래된 tool-result content가 플레이스홀더로 축약된다", () => {
    // 오래된 tool 메시지가 보호 범위(마지막 6개) 밖에 있도록 충분한 메시지 생성
    const msgs: ModelMessage[] = [
      makeUserMsg("첫 번째 질문"),
      makeToolMsg("call-1", 30000), // index 1: 오래된 대형 결과 (보호 안 됨)
      makeToolMsg("call-2", 30000), // index 2: 오래된 대형 결과 (보호 안 됨)
      makeUserMsg("최근 질문 1"), // index 3
      makeUserMsg("최근 질문 2"), // index 4
      makeUserMsg("최근 질문 3"), // index 5
      makeUserMsg("최근 질문 4"), // index 6
      makeUserMsg("최근 질문 5"), // index 7
      makeUserMsg("최근 질문 6"), // index 8 (마지막 6개 중 첫 번째)
    ];
    // protectFrom = max(0, 9 - 6) = 3 → index 0~2가 압축 대상

    const result = compactMessages(msgs, 5000);

    // 오래된 tool 메시지(index 1)가 압축됐는지 확인
    const firstToolMsg = result[1] as {
      role: "tool";
      content: Array<{ type: string; output: { type: string; value: string } }>;
    };
    const firstPart = firstToolMsg.content[0];
    expect(firstPart).toBeDefined();
    if (firstPart?.type === "tool-result") {
      const output = (firstPart as { output: { type: string; value: string } }).output;
      expect(output.type).toBe("text");
      expect(output.value).toContain("[이전 도구 결과 생략");
    }
  });

  it("마지막 6개 메시지는 압축하지 않는다", () => {
    const bigText = "z".repeat(90000); // 매우 큰 내용 (30,000 토큰)

    // 마지막 6개에 대형 tool-result 포함
    const msgs: ModelMessage[] = [
      makeUserMsg("오래된 질문"), // index 0 → 압축 대상
      makeToolMsg("call-old", 1000), // index 1 → 압축 대상
      makeUserMsg("보호 1"), // index 2 → 마지막 6개 중
      makeAssistantMsg("응답 1"), // index 3
      makeUserMsg("보호 2"), // index 4
      makeAssistantMsg("응답 2"), // index 5
      makeUserMsg("보호 3"), // index 6
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-new",
            toolName: "read_document",
            output: { type: "text", value: bigText },
          },
        ],
      } as ModelMessage, // index 7 → 마지막 6개, 보호
    ];

    const result = compactMessages(msgs, 100);

    // 마지막 tool 메시지 (index 7)는 원형 보존
    const lastToolMsg = result[7] as {
      role: "tool";
      content: Array<{ output: { value: string } }>;
    };
    const lastPart = lastToolMsg?.content[0];
    expect(lastPart?.output?.value).toBe(bigText); // 원형 유지
  });

  it("tool_call ↔ tool-result 짝 구조가 유지된다 (toolCallId 보존)", () => {
    // index 0~2가 압축 대상 (tool-result 포함), 마지막 6개 보호
    const msgs: ModelMessage[] = [
      makeUserMsg("질문"), // index 0
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "my-call-id",
            toolName: "read_document",
            input: { path: "/doc.txt" },
          },
        ],
      } as ModelMessage, // index 1
      makeToolMsg("my-call-id", 50000), // index 2: 대형 결과 (압축 대상)
      makeUserMsg("최근 1"), // index 3 (보호)
      makeUserMsg("최근 2"), // index 4 (보호)
      makeUserMsg("최근 3"), // index 5 (보호)
      makeUserMsg("최근 4"), // index 6 (보호)
      makeUserMsg("최근 5"), // index 7 (보호)
      makeUserMsg("최근 6"), // index 8 (보호)
    ];
    // protectFrom = max(0, 9 - 6) = 3 → index 0~2가 압축 대상

    const result = compactMessages(msgs, 1000);

    // tool 메시지가 압축됐더라도 toolCallId는 보존돼야 한다
    const toolMsg = result[2] as { role: "tool"; content: Array<{ toolCallId: string }> };
    expect(toolMsg.content[0]?.toolCallId).toBe("my-call-id");

    // assistant의 tool-call도 그대로
    const assistMsg = result[1] as { role: "assistant"; content: Array<{ toolCallId: string }> };
    expect(assistMsg.content[0]?.toolCallId).toBe("my-call-id");
  });

  it("압축 후 추정 토큰이 원본보다 줄어든다", () => {
    // index 0~2가 압축 대상 (tool 메시지 2개 포함), 마지막 6개 보호
    const msgs: ModelMessage[] = [
      makeUserMsg("질문 1"), // index 0
      makeToolMsg("c1", 30000), // index 1
      makeToolMsg("c2", 30000), // index 2
      makeUserMsg("최근 1"), // index 3
      makeUserMsg("최근 2"), // index 4
      makeUserMsg("최근 3"), // index 5
      makeUserMsg("최근 4"), // index 6
      makeUserMsg("최근 5"), // index 7
      makeUserMsg("최근 6"), // index 8
    ];
    // protectFrom = max(0, 9 - 6) = 3

    const budget = 5000;
    const beforeTokens = estimateTokens(msgs);
    const result = compactMessages(msgs, budget);
    const afterTokens = estimateTokens(result);

    // 압축 후 토큰이 원본보다 줄어야 한다 (tool-result 2개가 압축됨)
    expect(afterTokens).toBeLessThan(beforeTokens);
  });

  it("원본 배열을 변형하지 않는다 (불변성)", () => {
    const original = "x".repeat(30000);
    const msgs: ModelMessage[] = [
      makeUserMsg("질문"),
      makeToolMsg("call-1", 30000),
      makeUserMsg("최근 1"),
      makeUserMsg("최근 2"),
      makeUserMsg("최근 3"),
      makeUserMsg("최근 4"),
    ];

    // 원본 메시지 참조 저장
    const originalMsg1 = msgs[1] as { content: Array<{ output: { value: string } }> };
    const originalValue = originalMsg1.content[0]?.output?.value;

    compactMessages(msgs, 100);

    // 원본은 변경되지 않아야 한다
    expect(originalMsg1.content[0]?.output?.value).toBe(originalValue);
    expect(originalMsg1.content[0]?.output?.value).toBe(original);
  });

  it("대형 assistant tool-call 메시지는 평문으로 치환하지 않는다 (짝 보존)", () => {
    // propose_edit 처럼 input이 큰 tool-call — 평문 플레이스홀더로 바꾸면 tool-call
    // 파트가 사라져 짝이 되는 tool-result가 고아(orphan)가 되어 API 오류를 유발한다.
    const bigInput = "가".repeat(2000); // 큰 newMarkdown 모사 (>300자)
    const msgs: ModelMessage[] = [
      makeUserMsg("문서 수정해줘"), // index 0
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "edit-1",
            toolName: "propose_edit",
            input: { path: "/a.hwpx", newMarkdown: bigInput },
          },
        ],
      } as ModelMessage, // index 1: 배열 content(tool-call) — 압축 대상 범위지만 보존돼야 함
      makeToolMsg("edit-1", 40000), // index 2: 대형 결과 (압축 대상)
      makeUserMsg("최근 1"), // 3
      makeUserMsg("최근 2"), // 4
      makeUserMsg("최근 3"), // 5
      makeUserMsg("최근 4"), // 6
      makeUserMsg("최근 5"), // 7
      makeUserMsg("최근 6"), // 8
    ];
    // protectFrom = max(0, 9 - 6) = 3 → index 0~2 압축 대상

    const result = compactMessages(msgs, 1000);

    // assistant의 tool-call 파트는 배열 그대로 보존(평문 string으로 치환되면 안 됨)
    const assistMsg = result[1] as {
      role: "assistant";
      content: Array<{ type: string; toolCallId?: string }>;
    };
    expect(Array.isArray(assistMsg.content)).toBe(true);
    expect(assistMsg.content[0]?.type).toBe("tool-call");
    expect(assistMsg.content[0]?.toolCallId).toBe("edit-1");
  });
});
