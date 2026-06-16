# kodocagent 기술 명세 (v1)

> 2026-06-10 확정. 이 문서는 [PLAN.md](PLAN.md)의 구현 상세 명세다. API 시그니처·버전·모델 ID는 npm 레지스트리/공식 문서에서 검증된 값이다.

## 0. 확정된 제품 결정

| # | 항목 | 결정 |
|---|---|---|
| 1 | 제품 형태 | 코어 라이브러리 + CLI 먼저, GUI는 M5 |
| 2 | 하네스 | Vercel AI SDK 위 자체 경량 루프 |
| 3 | 한국 사이트 자동화 | MCP 클라이언트 생태계 (korean-law-mcp 기본 번들) |
| 4 | 문서 수정 UX | 스테이징 → diff 미리보기 → 승인 → 백업 후 저장 |
| 5 | v1 쓰기 범위 | **HWPX + DOCX + XLSX 모두 쓰기** (HWP 5.0 바이너리 쓰기는 제외, `.hwp` 편집 결과는 `.hwpx`) |
| 6 | 미리보기 | **텍스트/구조 diff만** (rhwp 시각 렌더링은 브라우저 전용이므로 M5 GUI로 이관) |
| 7 | 에이전트 접근 범위 | 읽기전용 파일 탐색(cwd 이하) + 문서 툴. 일반 쓰기·셸 실행 없음 |
| 8 | 기본 모델 | 프로바이더별 플래그십 (아래 §3) |

## 1. 의존성 (버전 검증 완료, 2026-06-10 npm 기준)

### 런타임

| 패키지 | 버전 | 용도 | 라이선스 |
|---|---|---|---|
| `ai` | ^6.0 (6.0.199) | 에이전트 루프 기반 (`streamText` 멀티스텝) | Apache-2.0 |
| `@ai-sdk/openai` | ^3.0 | OpenAI 프로바이더 | Apache-2.0 |
| `@ai-sdk/anthropic` | ^3.0 | Anthropic 프로바이더 | Apache-2.0 |
| `@ai-sdk/google` | ^3.0 | Gemini 프로바이더 | Apache-2.0 |
| `@modelcontextprotocol/sdk` | ^1.29 | MCP 클라이언트 | MIT |
| `@clazic/kordoc` | ^2.7.6 | HWP/HWPX/DOCX/XLSX/PDF 읽기, HWPX 쓰기, 비교, 폼 | MIT |
| `docx` | ^9.7 | DOCX 생성/쓰기 | MIT |
| `exceljs` | ^4.4 | XLSX 읽기보조/셀 단위 수정 (서식 보존) | MIT |
| `zod` | ^4.4 | 툴 스키마·설정 검증 | MIT |
| `diff` | ^9.0 | 마크다운 unified diff | BSD |
| `commander` | ^15 | CLI 인자 파싱 | MIT |
| `@clack/prompts` | ^1.5 | 승인/선택 프롬프트 | MIT |
| `chalk` | ^5.6 | 터미널 컬러 | MIT |
| `marked` ^18 + `marked-terminal` ^7.3 | — | 마크다운 터미널 렌더 | MIT |

### 개발

tsup 8.5 / vitest 4.1 / @biomejs/biome 2.4 / @changesets/cli 2.31 / TypeScript 5.x / Node ≥ 20, ESM-only.

**v1에서 제외된 의존성**: `@rhwp/core`(브라우저 전용 — `measureTextWidth` canvas 필요, Node PNG 불가, 쓰기 API 미노출 → M5 GUI에서 `@rhwp/editor`로 사용), keytar(네이티브 모듈), ink(React 의존).

**npm 배포 구조**: `kodocagent` 단일 패키지만 npm에 배포된다. `@kodocagent/core`, `@kodocagent/doc-tools`, `@kodocagent/shared`는 `"private": true` 워크스페이스 전용 패키지로, CLI 빌드 시 tsup `noExternal` 설정에 의해 `kodocagent` 번들에 인라인된다. 사용자는 `npm i -g kodocagent` 하나만 설치하면 모든 기능을 사용할 수 있다.

### 구현 시 재확인 항목 (문서화 시점에 미검증)

- AI SDK **v6**의 멀티스텝 정지 조건 정확한 심볼명 (`stopWhen: stepCountIs(N)`은 v5 기준 — v6 문서에서 확인 후 적용)
- `@modelcontextprotocol/sdk` v1.29의 transport import 경로 (`client/stdio.js`, `client/streamableHttp.js`로 추정 — 타입 정의에서 확인)
- `ai@6` × `zod@4` 툴 스키마 호환성 (스캐폴딩 시 스모크 테스트)

## 2. kordoc 검증된 API (이대로 코딩 가능)

```ts
import { parse, compare, fillForm, markdownToHwpx } from "@clazic/kordoc";

// 1) 읽기 — 절대 throw하지 않음. 항상 ParseResult 반환
parse(input: string /*경로*/ | ArrayBuffer | Buffer, options?: ParseOptions): Promise<ParseResult>
// 성공: { success: true, markdown, blocks: IRBlock[], metadata?, outline?, warnings?, fileType, pageCount? }
// 실패: { success: false, error, code? }  // code: "ENCRYPTED" | "DRM_PROTECTED" | "CORRUPTED" | "UNSUPPORTED_FORMAT" | "IMAGE_BASED_PDF" | ...

// 2) 비교 — ArrayBuffer만 받음 (경로 불가). 포맷 교차 비교 지원
compare(a: ArrayBuffer, b: ArrayBuffer, options?): Promise<DiffResult>
// DiffResult: { stats: {added, removed, modified, unchanged}, /* block-level diffs */ }

// 3) 폼 필드 추출 — ⚠ 2.7.6에는 fillForm이 없음 (M2 구현 시 확인).
//    폼 채우기는 extractFormFields(blocks)로 현재 값을 읽고 마크다운 치환 후
//    markdownToHwpx(템플릿=원본)로 재생성하는 방식으로 구현함
extractFormFields(blocks: IRBlock[]): FormField[]

// 4) 마크다운→HWPX — templateArrayBuffer에 원본을 넘기면 원본 스타일 보존
markdownToHwpx(markdown: string, options?: { templateArrayBuffer?: ArrayBuffer, warnings?: string[], images?: ExtractedImage[] }): Promise<ArrayBuffer>
```

핵심 포인트: **`propose_edit`은 `markdownToHwpx(newMarkdown, { templateArrayBuffer: 원본 })`으로 원본 서식을 보존**한다. 암호화 문서는 `code: "ENCRYPTED"`로 반환되므로 에러 메시지로 변환해 모델에 전달.

## 3. 모델 레지스트리 (`core/src/providers/registry.ts`)

기본값: Google은 `gemini-3.5-flash`, **Anthropic은 `claude-sonnet-4-6`, OpenAI는 `gpt-5.4`** (비용·속도 균형). 미등록 모델 ID는 통과 허용(BYOK 특성). **샘플링 파라미터(`temperature`/`top_p`/`top_k`)는 어떤 요청에도 설정하지 않는다** — Claude Opus 4.7+/Fable 5는 400 에러를 반환한다.

| 프로바이더 | 기본 모델 | 레지스트리 등재 모델 | 환경변수 |
|---|---|---|---|
| anthropic | `claude-sonnet-4-6` ($3/$15 per MTok) | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| openai | `gpt-5.4` | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5` | `OPENAI_API_KEY` |
| google | `gemini-3.5-flash` (GA 안정판) | `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-2.5-pro`, `gemini-2.5-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` |

키 우선순위: 환경변수 > `~/.kodocagent/config.json`. Anthropic 모델은 추론(thinking) 기본 설정을 건드리지 않는다(어댑티브가 모델 기본).

## 4. 설정 파일

> 홈 디렉터리(`~/.kodocagent`)는 `KODOCAGENT_HOME` 환경변수로 오버라이드 가능 (테스트 격리·포터블 설치용).

### `~/.kodocagent/config.json` (mode 0600, zod 검증)

```jsonc
{
  "version": 1,
  "provider": "anthropic",            // 활성 프로바이더
  "model": "claude-sonnet-4-6",       // 활성 모델 (미지정 시 프로바이더 기본값)
  "apiKeys": {                         // 환경변수가 우선
    "anthropic": "sk-ant-...",
    "openai": null,
    "google": null
  },
  "lawApiKey": null,                   // LAW_OC 값. MCP korean-law 서버 env로 주입
  "locale": "ko",                      // CLI 메시지 언어 (v1은 ko 고정)
  "maxSteps": 24,                      // 턴당 최대 툴콜 스텝
  "maxContextTokens": 120000           // 컨텍스트 토큰 예산 (초과 시 오래된 도구 결과 자동 압축)
}
```

### MCP 설정 — `~/.kodocagent/mcp.json` (사용자) + `./.kodocagent/mcp.json` (프로젝트, 서버명 단위로 사용자 설정 덮어씀)

표준 `mcpServers` 포맷. `${VAR}`는 환경변수/`config.json` 값으로 치환.

```jsonc
{
  "mcpServers": {
    "korean-law": {
      "command": "npx",
      "args": ["-y", "korean-law-mcp@latest"],   // npm 버전 존재 — Python 불필요 (검증됨)
      "env": { "LAW_OC": "${LAW_OC}" },          // 주의: LAW_API_OC 아님
      "disabled": false,
      "allowedTools": null                        // null = 전체 허용, ["tool1"] = 허용 목록
    }
  }
}
```

- 사용자 mcp.json이 없으면 위 `korean-law` 항목을 **기본 번들**로 사용
- `LAW_OC` 미설정 시: korean-law 서버만 스킵 + 1줄 안내 (open.law.go.kr에서 무료 발급 → `kodocagent config set law-key <키>`)
- HTTP 서버는 `{ "url": "https://...", "headers": {...} }` 형태 지원 (Streamable HTTP)
- 툴 네임스페이스: `mcp__<server>__<tool>`. 총 MCP 툴 40개 초과 시 경고
- MCP 연결 실패/툴 에러는 tool-error 결과로 격리 — 루프 크래시 금지. 서버 spawn 타임아웃 10s

## 5. 코어 에이전트 루프

### AgentEvent (`core/src/agent/events.ts`)

```ts
type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown; callId: string }
  | { type: "tool-result"; callId: string; result: unknown; isError: boolean }
  | { type: "approval-required"; proposal: Proposal }   // §7
  | { type: "turn-complete"; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string; recoverable: boolean };
```

### AgentSession (`core/src/agent/session.ts`)

```ts
class AgentSession {
  constructor(opts: {
    config: KodocConfig;
    tools: ToolRegistry;            // 내장 + MCP 툴 병합
    approvalHandler: ApprovalHandler; // (proposal) => Promise<{approved: boolean; reason?: string}>
    store: SessionStore;            // JSONL 영속화
  });
  run(userMessage: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
```

- 내부적으로 `streamText({ model, system, messages, tools, stopWhen: <v6 멀티스텝 정지 조건>(config.maxSteps), abortSignal })`
- **컨텍스트 관리**: 매 턴 `streamText` 직전 `compactMessages(messages, config.maxContextTokens)`로 예산 초과 시 오래된 대형 tool-result를 플레이스홀더로 축약(system·최근 6개 보호, 메시지 삭제 없이 tool_call↔result 짝 보존). 세션 JSONL엔 전체 기록 유지. CLI는 매 턴/`/context`로 사용량 표시
- `ApprovalHandler`는 CLI(clack confirm)/GUI(다이얼로그)가 주입. **core는 터미널 import·console 출력 금지**
- Ctrl+C → AbortSignal → 턴 중단, 세션 파일은 유효 상태 유지

### 세션 JSONL (`~/.kodocagent/sessions/<ulid>.jsonl`)

한 줄 = `{ "v": 1, "ts": "<ISO8601>", "type": "...", "data": {...} }`

| type | data |
|---|---|
| `meta` | `{ id, cwd, provider, model, createdAt }` (첫 줄) |
| `user` / `assistant` | `{ content }` (assistant는 툴콜 블록 포함, AI SDK 메시지 포맷 그대로) |
| `tool-result` | `{ callId, result, isError }` |
| `approval` | `{ proposalId, approved, reason? }` |

재개(`--continue`/`--resume <id>`): user/assistant/tool-result 레코드를 AI SDK 메시지 배열로 재구성.

### 시스템 프롬프트 (`core/src/agent/prompts.ts`, 목표 ~1.5k 토큰)

섹션 구성 (안정 prefix 우선 — 캐시 친화):
1. 역할: 한국어 문서 전문 에이전트. 기본 응답 언어 한국어
2. 문서 규칙: 수정 전 반드시 `read_document` / 모든 저장은 `propose_*` 경유, 승인 전 "저장했다"고 말하지 않기 / `.hwp` 편집 결과는 `.hwpx`로 저장됨을 사용자에게 고지
3. 법령 규칙: 법령 인용은 「법령명」 제N조 제N항 제N호 형식, 현행 여부는 MCP 법령 툴로 확인 후 인용, 확인 못 한 법령 내용은 추정임을 명시
4. 동적 컨텍스트 (마지막에 주입): cwd, 연결된 MCP 서버 목록, 열람한 문서 목록

## 6. 내장 툴 (`doc-tools` → core 레지스트리에 등록)

모든 툴은 `{ name, description, inputSchema: zod, requiresApproval, execute({input, signal, ctx}) }` 래퍼로 등록. `requiresApproval: true`인 툴은 래퍼가 `ApprovalHandler` 승인 없이는 파일을 쓰는 코드 경로 자체가 없다.

### 읽기 (승인 불필요)

| 툴 | 시그니처 | 구현 |
|---|---|---|
| `read_document` | `(path, pages?, outline?, search?)` → 마크다운+메타 | kordoc `parse()`(평문 .md/.txt는 직접 읽기). 100MB 초과 차단. `outline`=헤딩 구조만, `search`=키워드 주변만, 80k자 캡 |
| `compare_documents` | `(pathA, pathB)` → 구조 diff 통계+상세 | 파일 읽어 ArrayBuffer로 kordoc `compare()` |
| `list_files` | `(dir?, glob?)` → 파일 목록 | cwd 이하로 제한(realpath 검증), 문서 확장자 우선 표시 |
| `read_file` | `(path)` → 텍스트 | cwd 이하 텍스트 파일만, 256KB 제한 |

### 쓰기 (승인 필요 — 스테이징 경유)

| 툴 | 시그니처 | 구현 |
|---|---|---|
| `propose_edit` | `(path, newMarkdown, summary)` | `.hwp`/`.hwpx` → `markdownToHwpx(md, {templateArrayBuffer: 원본})`, `.docx` → `docx` 라이브러리로 재생성(서식 손실을 proposal에 명시), `.md`/`.txt` → 그대로 |
| `propose_form_fill` | `(path, fields: Record<string,string>, summary)` | kordoc `extractFormFields` + 마크다운 치환 + `markdownToHwpx`(원본 템플릿) — 2.7.6에 fillForm 부재 |
| `propose_sheet_edit` | `(path, updates: {sheet, cell, value}[], summary)` | exceljs로 원본 워크북 로드 → 셀 단위 수정 → 서식 보존 저장 |
| `write_new_document` | `(path, markdown)` | 확장자별: `.hwpx` kordoc / `.docx` docx / `.md` fs. 신규 파일이므로 diff 없이 내용 미리보기로 승인 |
| `write_new_spreadsheet` | `(path, sheets: {name, rows: string[][]}[])` | exceljs 신규 생성 |

경로 정규화: 모든 path는 NFC 정규화(macOS NFD 대응) + cwd 이하 검증.

## 7. 스테이징 → 승인 파이프라인 (`doc-tools/src/staging.ts`)

```
propose_* 호출
 1. 결과물 생성 → ~/.kodocagent/staging/<sessionId>/<n>-<파일명>   (원본 무변경)
 2. diff 생성:
    - 문서(.hwpx/.docx): kordoc compare(원본, 스테이징) 통계 + parse() 마크다운 양쪽 unified diff
    - 시트(.xlsx): 셀 변경 목록 (Before → After 표)
    - 신규 파일: 전체 내용 미리보기
 3. core가 approval-required 이벤트 발행:
    Proposal = { id, kind, targetPath, stagedPath, summary, diff, warnings,
                 willConvertFormat?: ".hwp → .hwpx" }
 4. CLI: 컬러 diff 렌더 → clack select: [승인 / 거절 / 거절+사유 입력]
 5-a. 승인: 원본을 ~/.kodocagent/backups/<ISO타임스탬프>-<파일명> 복사(항상)
      → 같은 볼륨에 temp 쓰기 + rename(원자적). .hwp 대상이면 <이름>.hwpx로 저장하고 원본 .hwp는 보존
      → 툴 결과: "저장 완료: <경로> (백업: <경로>)"
 5-b. 거절: 스테이징 파일 유지(세션 종료 시 정리), 툴 결과: "사용자 거절: <사유>" → 모델이 재제안
```

비대화형(non-TTY) 실행 시: 모든 `propose_*`는 자동 거절 + "대화형 터미널에서 실행하세요" 메시지 (v1에는 `--yes` 자동승인 없음 — 안전 우선).

세션 종료(정상 종료·EOF·SIGINT) 시 해당 세션의 스테이징 디렉터리를 자동 삭제한다 (`cleanSessionStaging` — 실패는 무시). `kodocagent clean` 명령으로 스테이징 전체 + 30일 경과 백업을 수동 정리할 수 있다.

## 8. CLI (`packages/cli`)

### 명령

| 명령 | 동작 |
|---|---|
| `kodocagent` | 채팅 시작 (최초 실행 시 온보딩) |
| `kodocagent -p "<질문>"` | 단발 질의(쓰기 툴은 비활성) |
| `kodocagent --continue` / `--resume <id>` | 세션 재개 |
| `kodocagent sessions` | 세션 목록 |
| `kodocagent config set <key> <value>` / `config show` | 설정 (api-key.anthropic, law-key, model 등) |
| `kodocagent mcp list` / `mcp test <server>` | MCP 서버 상태 확인 |
| `kodocagent clean` | 스테이징 전체 + 30일 경과 백업 정리 (`--all`로 백업 전체 삭제) |
| `kodocagent update` | 셀프 업데이트 (§9) |
| `kodocagent --version` | 버전 |

### 채팅 내 슬래시 명령

`/model`(프로바이더·모델 전환 — 키 있는 프로바이더만 표시, "직접 입력..." 선택 시 임의 모델 ID 입력 가능·BYOK 미등재 ID 허용), `/clear`(새 세션), `/help`, `/exit`

### 온보딩 (최초 실행)

1. 프로바이더 선택(clack select) → API 키 입력(마스킹) → config.json 0600 저장
2. 법령 기능 안내: `LAW_OC` 키 없으면 발급 안내 URL 출력 + 지금 입력/나중에 선택
3. 샘플 안내 메시지 출력 후 채팅 시작

### 출력 규칙

스트리밍 텍스트는 plain stdout(델타 그대로), 턴 완료 후 마지막 어시스턴트 메시지는 marked-terminal로 재렌더하지 않음(중복 방지) — 델타 출력만 사용. 툴콜은 `⚙ read_document(보고서.hwpx)` 형태 1줄 표시. Windows: 시작 시 `process.stdout`에 UTF-8 강제 + README에 `chcp 65001` 안내.

## 9. OTA 업데이트 (`cli/src/update.ts`)

- 시작 시(24h 1회, `~/.kodocagent/update-check.json` 캐시) `https://registry.npmjs.org/kodocagent/latest` 조회(3s 타임아웃, 실패 무시)
- 새 버전 존재 시 비차단 배너: `새 버전 vX.Y.Z — kodocagent update 로 업데이트`
- `kodocagent update`: 실행 경로로 설치 방식 감지(글로벌 npm/pnpm → 해당 PM으로 `i -g kodocagent@latest`, npx → "항상 최신 사용 중" 안내)
- **배포 형태**: 단일 npm 패키지 `kodocagent`. 내부 워크스페이스 패키지(`@kodocagent/core|doc-tools|shared`)는 빌드 시 번들링되며 npm에는 배포되지 않음. changesets → GitHub Actions에서 `kodocagent` 패키지만 publish.

## 10. 에러 처리 정책

- 모든 사용자 노출 에러 메시지는 한국어, `원인 + 해결 방법` 형태
- kordoc 에러 코드 매핑: `ENCRYPTED`/`DRM_PROTECTED` → "암호화/DRM 문서는 열 수 없습니다", `IMAGE_BASED_PDF` → "스캔 PDF입니다(OCR 미지원)", `CORRUPTED` → "손상된 파일"
- 프로바이더 401 → "API 키가 유효하지 않습니다. kodocagent config set api-key.<provider> ..." / 429 → 지수 백오프 2회 후 안내
- MCP 서버 실패 → 해당 툴만 비활성, 채팅 시작 시 1줄 고지
- 모든 예외는 AgentEvent `error`로 변환 — 프로세스 크래시 금지

## 11. 테스트 전략

- **doc-tools**: 픽스처 기반 — 한글/한자/특수기호 포함 .hwpx/.docx/.xlsx 샘플로 read→propose→approve 라운드트립, 백업 생성·원자적 저장 검증. NFC/NFD 경로 테스트
- **core**: 모의 LanguageModel(AI SDK test util)로 루프·승인 게이트·취소·세션 재개 단위 테스트. 승인 거부 시 파일 미변경 assert
- **mcp**: 로컬 echo MCP 서버 픽스처로 연결/네임스페이스/allowedTools/장애 격리 테스트
- **CI**: macOS + ubuntu + windows × Node 20/22. 3사 프로바이더 실키 스모크는 시크릿 있을 때만(배포 전 필수)

## 12. 마일스톤 수용 기준

| 단계 | 완료 조건 |
|---|---|
| **M0** | 클린 클론에서 `pnpm i && pnpm build && pnpm test` 통과, `node packages/cli/dist/index.js --version` 출력 |
| **M1** | 3사 실키로 한국어 채팅 + `read_document`/`list_files` 툴콜 동작, Ctrl+C 후 `--continue` 복원, `/model` 전환 |
| **M2** | 실제 .hwpx: "날짜를 2026년으로 변경" → diff → 거절(재제안 확인) → 승인 → 한컴오피스에서 열림 + 백업 존재. .xlsx 셀 수정, .docx 신규 생성 동일 검증 |
| **M3** | `LAW_OC` 키로 "근로기준법 제60조 확인해서 이 취업규칙 검토" → `mcp__korean-law__*` 호출 → 조문 인용 수정안. 프로젝트 mcp.json으로 서드파티 서버 1개 추가 연결 |
| **M4** | 클린 머신 `npx kodocagent@latest` 온보딩→법령 기반 수정 E2E, 패치 배포 후 업데이트 배너 |
| **M5 (v2)** | Tauri/Electron + `@rhwp/editor` 임베드(시각 미리보기·편집), ApprovalHandler를 다이얼로그로 |
