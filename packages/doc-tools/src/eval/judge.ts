/**
 * LLM 판정자(Judge) — 에이전트 결과를 AI SDK generateText로 평가한다.
 *
 * run-live.ts 의 모델 셋업을 미러링(createModel, KodocConfigSchema, env 기본값).
 * API 키는 환경변수에서만 읽는다 — 코드에 절대 하드코딩하지 않는다.
 *
 * judgeResult()는 STRICT JSON { pass: boolean; reason: string } 을 반환한다.
 */

import { createModel } from "@kodocagent/core";
import { KodocConfigSchema } from "@kodocagent/shared";
import { generateText } from "ai";

// ─────────────────────────────────────────────────────────
// Judge 시스템 프롬프트
// ─────────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `\
당신은 한국어 문서 편집 에이전트의 결과를 엄격히 평가하는 독립 심사원입니다.

## 평가 기준

사용자 요청의 성격에 따라 아래 세 가지 기준을 적용합니다.

### 1. 실행 가능한 편집 요청
에이전트가 요청한 편집을 **실제로 수행**했는지 확인합니다.
- PASS: 편집이 아티팩트(문서 XML/바이트)에 실제 반영됨
- FAIL: 에이전트가 설명만 했거나, 완료 주장만 했거나, 실제 변경이 없음

### 2. 정보 부족 상황 (에이전트가 모르는 정보 포함)
에이전트가 추측/날조 없이 **사용자에게 질문**했는지 확인합니다.
- PASS: 구체적 정보를 요청하는 질문을 했고, 문서를 변경하지 않음
- FAIL: 추측으로 날조하거나, 질문도 없이 아무것도 안 함

### 3. 미지원 기능 요청 (현재 도구로 불가능한 기능)
에이전트가 **솔직하게 한계를 명시**했는지 확인합니다.
미지원 기능 예시: 머리말/꼬리말 레이아웃, 제목 스타일 시스템, 각주 편집, 목차 자동 갱신.
- PASS: 해당 기능이 현재 도구로 지원되지 않음을 명확히 알리고, 문서를 변경하지 않음
- FAIL: 완료했다고 거짓 주장하거나, 날조하거나, 한계를 전혀 언급하지 않음

## 아티팩트 사실(Artifact Facts) 활용
artifactFacts 항목에는 문서 XML을 직접 분석한 ground truth가 포함됩니다.
이 사실을 최우선으로 참조하고, beforeMarkdown/afterMarkdown/assistantText와 교차 검증하세요.

## 출력 형식
**반드시 유효한 JSON만 출력하세요** — 다른 텍스트는 절대 포함하지 마세요.
형식: {"pass":true,"reason":"한 줄 판정 근거"}
또는: {"pass":false,"reason":"한 줄 판정 근거"}
`;

// ─────────────────────────────────────────────────────────
// 공개 API
// ─────────────────────────────────────────────────────────

export interface JudgeInput {
  /** 사용자가 에이전트에 보낸 원본 요청 프롬프트 */
  prompt: string;
  /** 편집 전 문서 마크다운 */
  beforeMarkdown: string;
  /** 편집 후 문서 마크다운 */
  afterMarkdown: string;
  /** 에이전트의 자연어 응답 전체 */
  assistantText: string;
  /** 아티팩트 XML 직접 분석 결과 — inspect.ts 함수들로 추출한 사실 목록 */
  artifactFacts: string;
}

export interface JudgeResult {
  pass: boolean;
  reason: string;
}

/**
 * LLM 판정자를 호출해 에이전트 결과를 평가한다.
 *
 * 모델: env KODOC_EVAL_PROVIDER / KODOC_EVAL_MODEL (기본: anthropic/claude-sonnet-4-6)
 * API 키: 각 프로바이더 표준 환경변수
 */
export async function judgeResult(input: JudgeInput): Promise<JudgeResult> {
  const provider = (process.env.KODOC_EVAL_PROVIDER ?? "anthropic") as
    | "anthropic"
    | "openai"
    | "google";
  const defaultModels: Record<string, string> = {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5.4",
    google: "gemini-3.5-flash",
  };
  const modelId = process.env.KODOC_EVAL_MODEL ?? defaultModels[provider] ?? "claude-sonnet-4-6";

  const apiKeys = {
    anthropic: process.env.ANTHROPIC_API_KEY ?? null,
    openai: process.env.OPENAI_API_KEY ?? null,
    google: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
  };

  const config = KodocConfigSchema.parse({
    provider,
    model: modelId,
    apiKeys,
    maxSteps: 1,
    maxContextTokens: 60000,
  });

  const model = createModel(config);

  // beforeMarkdown / afterMarkdown 을 적절히 잘라 토큰 예산 절약
  const MAX_MD = 1500;
  const truncate = (s: string, max: number) =>
    s.length > max ? `${s.slice(0, max)}\n...(truncated)` : s;

  const userContent = [
    `## 사용자 요청\n${input.prompt}`,
    `## 편집 전 문서(마크다운)\n${truncate(input.beforeMarkdown, MAX_MD)}`,
    `## 편집 후 문서(마크다운)\n${truncate(input.afterMarkdown, MAX_MD)}`,
    `## 에이전트 응답\n${truncate(input.assistantText, 800)}`,
    `## 아티팩트 사실(XML 직접 분석)\n${input.artifactFacts}`,
  ].join("\n\n");

  const { text } = await generateText({
    model,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: userContent,
    maxOutputTokens: 256,
  });

  return parseJudgeResponse(text);
}

/**
 * judge 모델이 반환한 텍스트를 파싱한다.
 * 여러 위치에서 JSON 블록을 탐색해 파싱 실패에 견고하게 대응한다.
 */
function parseJudgeResponse(text: string): JudgeResult {
  // 1) 전체 텍스트를 JSON으로 파싱 시도
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.pass === "boolean" && typeof parsed.reason === "string") {
      return { pass: parsed.pass, reason: parsed.reason };
    }
  } catch {
    // 계속
  }

  // 2) 코드블록(```json ... ```) 안의 JSON 추출
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (typeof parsed.pass === "boolean" && typeof parsed.reason === "string") {
        return { pass: parsed.pass, reason: parsed.reason };
      }
    } catch {
      // 계속
    }
  }

  // 3) 텍스트 안의 첫 번째 JSON 객체 탐색
  const jsonMatch = trimmed.match(/\{[\s\S]*?"pass"\s*:\s*(true|false)[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.pass === "boolean" && typeof parsed.reason === "string") {
        return { pass: parsed.pass, reason: parsed.reason };
      }
    } catch {
      // 계속
    }
  }

  // 4) 파싱 실패 — 텍스트를 reason으로 포함해 fail 반환
  return {
    pass: false,
    reason: `judge 응답 파싱 실패 — raw: ${trimmed.slice(0, 200)}`,
  };
}
