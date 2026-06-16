/**
 * 컨텍스트 관리 — 토큰 예산 내 메시지 히스토리 자동 압축
 *
 * 불변 원칙:
 * - console.* 금지
 * - 원본 배열/객체를 변형하지 않음 (불변성)
 * - tool_call ↔ tool-result 짝과 순서 보존
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from "ai";

/**
 * 메시지 배열의 토큰 수를 추정한다 (문자 길이 합 / 3 올림, 보수적 근사).
 *
 * - 문자열 content는 그대로 길이를 합산
 * - 배열 content는 각 파트의 텍스트/문자열화 길이를 합산
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let totalChars = 0;

  for (const msg of messages) {
    totalChars += contentCharLength(msg.content);
  }

  return Math.ceil(totalChars / 3);
}

/**
 * content의 문자 길이를 계산한다.
 */
function contentCharLength(content: ModelMessage["content"]): number {
  if (typeof content === "string") {
    return content.length;
  }

  // 배열 content: 각 파트의 텍스트 또는 JSON 문자열화 길이 합산
  let len = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") {
      len += p.text.length;
    } else if (p.output !== undefined) {
      // ToolResultPart의 output 필드
      len += outputCharLength(p.output as ToolResultPart["output"]);
    } else {
      // 그 외 파트는 JSON 직렬화 길이로 근사
      len += JSON.stringify(p).length;
    }
  }
  return len;
}

/**
 * ToolResultOutput의 문자 길이를 계산한다.
 */
function outputCharLength(output: ToolResultPart["output"]): number {
  if (output.type === "text" || output.type === "error-text") {
    return output.value.length;
  }
  if (output.type === "json" || output.type === "error-json") {
    return JSON.stringify(output.value).length;
  }
  if (output.type === "content") {
    let len = 0;
    for (const item of output.value) {
      if ("text" in item && typeof item.text === "string") {
        len += item.text.length;
      } else {
        len += JSON.stringify(item).length;
      }
    }
    return len;
  }
  // execution-denied 등 나머지 케이스
  return JSON.stringify(output).length;
}

/**
 * 토큰 예산 초과 시 오래된 메시지의 대형 content를 플레이스홀더로 축약한다.
 *
 * 규칙:
 * - 추정 토큰이 maxTokens 이하면 입력을 그대로 반환 (복사 불필요)
 * - system 메시지와 마지막 6개 메시지는 절대 건드리지 않는다
 * - 나머지 중 오래된 것부터 tool 메시지(ToolModelMessage)의 각 파트 output을 플레이스홀더로 축약
 * - 매 축약 후 재계산하여 예산 이하가 되면 중단
 * - 메시지 자체는 제거하지 않음 (tool_call ↔ tool-result 짝 보존)
 * - 원본 배열/객체를 변형하지 않음 (불변성)
 */
export function compactMessages(messages: ModelMessage[], maxTokens: number): ModelMessage[] {
  // 예산 이하이면 그대로 반환
  if (estimateTokens(messages) <= maxTokens) {
    return messages;
  }

  // 보호할 마지막 N개 인덱스
  const PROTECT_LAST_N = 6;
  const protectFrom = Math.max(0, messages.length - PROTECT_LAST_N);

  // 불변 복사: 모든 메시지를 얕은 복사로 시작
  const result: ModelMessage[] = messages.map((m) => ({ ...m }));

  // 오래된 것부터 압축 대상 순회
  for (let i = 0; i < protectFrom; i++) {
    const msg = result[i]!;

    // system 메시지 건드리지 않음
    if (msg.role === "system") continue;

    // tool 메시지 (role === "tool")의 각 ToolResultPart output 축약
    if (msg.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      const newContent = toolMsg.content.map((part) => {
        if (part.type !== "tool-result") return part;

        const originalLen = outputCharLength(part.output);
        // 이미 플레이스홀더면 건너뜀
        if (part.output.type === "text" && part.output.value.startsWith("[이전 도구 결과 생략")) {
          return part;
        }

        return {
          ...part,
          output: {
            type: "text" as const,
            value: `[이전 도구 결과 생략 — 약 ${originalLen}자]`,
          },
        };
      });

      result[i] = { ...toolMsg, content: newContent } as ModelMessage;

      // 압축 후 토큰 재계산
      if (estimateTokens(result) <= maxTokens) {
        break;
      }
    }
    // 대형 user/assistant "평문(string)" 메시지만 축약한다.
    // 배열 content는 건드리지 않는다 — assistant의 tool-call 파트를 플레이스홀더로
    // 지우면 짝이 되는 tool-result가 고아가 되어 API 오류(tool_use 없는 tool_result)가 난다.
    else if ((msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
      const originalLen = msg.content.length;
      // 짧은 메시지는 건너뜀 (300자 미만)
      if (originalLen < 300) continue;

      const placeholder = `[이전 메시지 생략 — 약 ${originalLen}자]`;
      result[i] = { ...msg, content: placeholder } as ModelMessage;

      if (estimateTokens(result) <= maxTokens) {
        break;
      }
    }
  }

  return result;
}
