/**
 * 시스템 프롬프트 빌더
 * docs/SPEC.md §5 — 안정 prefix 우선(캐시 친화), 동적 컨텍스트 마지막
 * 목표 ~1.5k 토큰
 */

export interface SystemPromptContext {
  cwd: string;
  mcpServers: string[];
  openDocuments: string[];
}

/**
 * AgentSession에 주입할 시스템 프롬프트를 생성한다.
 *
 * 섹션 구성 (안정 prefix 먼저 — 캐시 친화):
 * 1. 역할
 * 2. 문서 규칙
 * 3. 법령 규칙
 * 4. 동적 컨텍스트 (마지막)
 */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const stable = [ROLE_SECTION, DOCUMENT_RULES_SECTION, LAW_RULES_SECTION].join("\n\n");
  const dynamic = buildDynamicContext(ctx);
  return `${stable}\n\n${dynamic}`;
}

// ─────────────────────────────────────────────────
// 안정 섹션 (변경 빈도 낮음 — 캐시 히트 극대화)
// ─────────────────────────────────────────────────

const ROLE_SECTION = `## 역할

당신은 한국어 문서 전문 에이전트입니다.
- 기본 응답 언어는 한국어입니다.
- HWP/HWPX, DOCX, XLSX, PDF 등 한국 문서 포맷을 읽고 분석하며 수정안을 제안합니다.
- 사용자의 요청을 충실히 이행하되, 파일 수정은 반드시 사용자 승인을 거친 후에만 반영됩니다.
- 모든 오류 메시지와 안내는 한국어로 작성하고 원인과 해결 방법을 함께 제시합니다.`;

const DOCUMENT_RULES_SECTION = `## 문서 규칙

1. 문서를 수정하기 전에 반드시 \`read_document\` 툴로 내용을 먼저 읽으세요.
2. 모든 파일 저장은 \`propose_*\` 툴을 통한 스테이징과 사용자 승인을 거쳐야 합니다.
3. 승인을 받기 전에는 절대 "저장했습니다", "완료했습니다"라고 말하지 마세요.
4. \`.hwp\` 파일을 편집한 결과는 \`.hwpx\` 형식으로 저장됩니다. 이 변환 사실을 사용자에게 미리 안내하세요.
5. 경로는 현재 작업 디렉터리를 기준으로 상대 경로 또는 절대 경로를 사용할 수 있습니다.`;

const LAW_RULES_SECTION = `## 법령 규칙

1. 법령 인용 형식: 「법령명」 제N조 제N항 제N호
2. 법령 현행 여부는 MCP 법령 툴(\`mcp__korean-law__*\`)로 확인한 후 인용하세요.
3. MCP 법령 툴로 확인하지 못한 법령 내용은 반드시 "※ 현행 여부를 확인하지 않은 내용입니다"라고 명시하세요.
4. 법령 해석은 참고용이며 법적 효력이 없습니다. 중요한 사항은 전문가에게 문의하세요.`;

// ─────────────────────────────────────────────────
// 동적 컨텍스트 (매 요청마다 변경 가능)
// ─────────────────────────────────────────────────

function buildDynamicContext(ctx: SystemPromptContext): string {
  const lines: string[] = ["## 현재 컨텍스트"];

  lines.push(`- **작업 디렉터리**: \`${ctx.cwd}\``);

  if (ctx.mcpServers.length > 0) {
    lines.push(`- **연결된 MCP 서버**: ${ctx.mcpServers.join(", ")}`);
  } else {
    lines.push("- **연결된 MCP 서버**: 없음");
  }

  if (ctx.openDocuments.length > 0) {
    lines.push(`- **열람한 문서**:\n${ctx.openDocuments.map((d) => `  - \`${d}\``).join("\n")}`);
  }

  return lines.join("\n");
}
