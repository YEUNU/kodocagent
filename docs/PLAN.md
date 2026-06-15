# kodocagent 구현 계획

> 2026-06-10 확정 / 2026-06-11 갱신: **M0~M4 구현 완료, CI 그린, OpenAI 실키 E2E 통과.**
> 남은 작업 정의는 **[ROADMAP.md](ROADMAP.md)**, 구현 상세는 **[SPEC.md](SPEC.md)**, 기반 조사는 [RESEARCH.md](RESEARCH.md) 참고. 변경 시 이 문서를 갱신한다.

## 배경과 목표

한국 특화 오픈소스(kordoc, rhwp, awesome-mcp-korea)를 종합 활용하여 **한국어 문서(HWP/HWPX/DOCX/XLSX) 읽기·수정 + 한국 법령 기반 문서 검토/추천 + MCP 플러그인 생태계**를 갖춘 AI 에이전트를 만든다.

**확정된 방향** (전체 결정표: SPEC §0)

- 제품 형태: **코어 라이브러리 + CLI 먼저**, GUI(데스크톱 앱)는 같은 코어 위에 M5로
- 하네스: **자체 경량 에이전트 루프** (oh-my-pi는 아키텍처 레퍼런스로만)
- 한국 사이트 자동화: **MCP 클라이언트 플러그인 생태계** (korean-law-mcp 기본 번들)
- 문서 수정 UX: **미리보기 + 승인** (diff 확인 후 승인해야만 저장, 자동 백업)
- v1 쓰기 범위: **HWPX(kordoc) + DOCX(docx) + XLSX(exceljs)** — HWP 5.0 바이너리 쓰기는 제외, `.hwp` 편집 결과는 `.hwpx`로 저장
- 미리보기: v1은 **텍스트/구조 diff만** — rhwp는 브라우저 전용(Node 부적합 검증됨)이라 M5 GUI에서 사용
- 에이전트 접근: 읽기전용 탐색(cwd 이하) + 문서 툴. 셸 실행 없음
- 기본 모델: `claude-sonnet-4-6`(Anthropic) / `gpt-5.4`(OpenAI) / `gemini-3.5-flash` — Anthropic·OpenAI는 비용·속도 균형

**활용 자산** (검증 결과: RESEARCH.md)

- `@clazic/kordoc@^2.7.6` (TS, MIT): HWP 3~5/HWPX/HWPML/PDF/DOCX/XLSX 읽기→마크다운, HWPX 쓰기(`markdownToHwpx` — 원본 템플릿으로 서식 보존), 폼 채우기(`fillForm`), 문서 비교(`compare`). API는 throw하지 않고 결과 객체 반환
- `korean-law-mcp`: **npm 버전 존재**(`npx -y korean-law-mcp@latest`) — Python 불필요. 국가법령정보센터 Open API 무료 키, 환경변수 **`LAW_OC`**
- `@rhwp/editor` (MIT): M5 GUI에서 문서 시각 미리보기/편집 임베드용
- oh-my-pi 참고 패턴: 이벤트 스트림 세션 루프, Zod 툴, append-only JSONL, proposed→resolve 승인, MCPManager

## 기술 스택 & 레포 구조

TypeScript 5.x / Node ≥ 20 / ESM-only / **pnpm workspaces** / tsup / vitest / Biome / changesets. 전체 의존성 버전표: SPEC §1.

```
packages/
├── shared/      → @kodocagent/shared    # 공용 타입, zod 스키마, 에러
├── core/        → @kodocagent/core      # 에이전트 루프, 프로바이더, 툴 레지스트리, MCP, 세션, 설정
├── doc-tools/   → @kodocagent/doc-tools # kordoc/docx/exceljs 래퍼, 스테이징/백업/diff
└── cli/         → kodocagent            # bin 엔트리, TUI, 승인 프롬프트, 온보딩, 업데이트
```

의존 방향: `cli → core → doc-tools → shared`.

**UI 비종속 원칙**: core는 터미널 관련 import·`console` 출력 금지. 모든 상호작용은 `AgentEvent` 스트림과 주입식 `ApprovalHandler`로만 — M5 GUI가 동일 코어를 소비.

TUI: `@clack/prompts` + plain stdout 스트리밍(chalk, marked-terminal). ink는 React 의존이 무거워 배제.

## 1. 에이전트 루프 (core)

**Vercel AI SDK v6** (`ai@^6` + `@ai-sdk/openai|anthropic|google@^3`) `streamText` 멀티스텝 위 얇은 하네스:

- `AgentSession.run(userMessage, signal): AsyncIterable<AgentEvent>` — 이벤트 타입 정의: SPEC §5
- **승인 게이트**: `requiresApproval` 플래그 → 툴 래퍼가 주입된 `ApprovalHandler`를 await. 승인 없이는 파일 쓰기 코드 경로 자체가 없음
- **취소**: `AbortSignal` 하나를 streamText와 모든 툴에 관통. Ctrl+C는 턴만 중단
- **세션 영속화**: `~/.kodocagent/sessions/<id>.jsonl` append-only (포맷: SPEC §5). `--continue`/`--resume`
- **시스템 프롬프트**: 한국어 문서 전문가 / 수정 전 `read_document` 필수 / 모든 쓰기는 `propose_*` 경유 / 법령 인용 「법령명」 제N조 형식 + MCP로 현행 확인 (구성: SPEC §5)
- **샘플링 파라미터 미설정** — Claude Opus 4.7+/Fable 5는 `temperature` 등에 400 반환
- v1 제외: 서브에이전트, 역할 라우팅, 플랜 모드

## 2. BYOK 프로바이더 레이어

- 키 저장: `~/.kodocagent/config.json` (mode **0600**), 환경변수 우선. keytar 제외
- 모델 레지스트리: 프로바이더별 플래그십 기본 + 검증된 모델 목록(SPEC §3), 미등록 ID 통과 허용
- UX: 온보딩에서 프로바이더+키, 채팅 중 `/model`, `kodocagent config set`

## 3. 내장 문서 툴 (doc-tools) — 상세: SPEC §6

| 툴 | 백엔드 | 승인 |
|---|---|---|
| `read_document` / `compare_documents` | kordoc | 불필요 |
| `list_files` / `read_file` (cwd 이하, 읽기전용) | fs | 불필요 |
| `propose_edit` (hwp/hwpx→hwpx 서식보존, docx 재생성) | kordoc / docx | **필요** |
| `propose_form_fill` | kordoc `fillForm` | **필요** |
| `propose_sheet_edit` (셀 단위, 서식 보존) | exceljs | **필요** |
| `write_new_document` / `write_new_spreadsheet` | kordoc / docx / exceljs | **필요** |

**스테이징 → 승인 파이프라인** (알고리즘: SPEC §7): `propose_*` → `~/.kodocagent/staging/`에 생성(원본 무변경) → kordoc compare + 마크다운 unified diff(시트는 셀 변경표) → `approval-required` 이벤트 → CLI 컬러 diff + clack 승인/거절(+사유) → 승인 시 자동 백업 후 원자적 저장 / 거절 시 사유를 모델에 전달해 재제안.

## 4. MCP 클라이언트 (core/src/mcp/)

- `@modelcontextprotocol/sdk@^1.29`, stdio + Streamable HTTP
- 설정: 표준 `mcpServers` 포맷 — 사용자 + 프로젝트 병합, 서버별 `disabled`/`allowedTools` (스키마: SPEC §4)
- 기본 번들: `npx -y korean-law-mcp@latest` + `LAW_OC`. 키 없으면 해당 서버만 스킵 + 발급 안내
- 툴 네임스페이스 `mcp__<server>__<tool>`, 장애는 tool-error로 격리, 총 40툴 초과 경고

## 5. OTA 업데이트 (무료)

npm 배포(`npx kodocagent@latest`/글로벌) + 24h 1회 레지스트리 체크 배너 + `kodocagent update` 셀프 업데이트. 릴리스는 changesets + GitHub Actions. 상세: SPEC §9. 단일 바이너리는 보류.

## 마일스톤 (수용 기준: SPEC §12, 진행 현황: ROADMAP.md)

| 단계 | 산출물 | 상태 |
|---|---|---|
| **M0 스캐폴딩** | pnpm 워크스페이스, 4패키지 빌드, CI/vitest/Biome/changesets | ✅ 완료 |
| **M1 루프+BYOK** | AgentSession 스트리밍·취소·JSONL 세션, 3사 프로바이더, 온보딩, `/model`, `read_document`/`list_files` | ✅ 완료 |
| **M2 문서 툴** | propose 툴 전체(hwpx/docx/xlsx), 스테이징/백업/diff, 승인 UI | ✅ 완료 |
| **M3 MCP+법령** | MCPManager, mcp.json 병합, korean-law 기본 번들, `LAW_OC` 온보딩 | ✅ 완료 (법령 실연동은 LAW_OC 키 대기) |
| **M4 폴리시+OTA** | 업데이트 체크/`update`, 한국어 에러 메시지, README | ✅ 완료 (npm 첫 배포는 R1로 분리 — 사용자 액션 대기) |
| **M4.5 폴리싱** | 스테이징/백업 정리, `/model` 커스텀 입력, 테스트 보강 | 🔜 진행 |
| **M5 GUI (v2)** | **Electron** + `@rhwp/editor` 임베드, 승인 다이얼로그 (M5a/b/c — ROADMAP 참고) | 예정 |

## 리스크 & 대응

1. **HWP 5.0 바이너리 쓰기 불가**: `.hwp` 편집 결과는 `.hwpx` 저장(현대 한컴오피스에서 네이티브 열림), 승인 카드에 명시. rhwp의 쓰기 API도 미노출로 검증됨 — v1 대안 없음, 정책으로 해결
2. **DOCX 편집 서식 손실**: markdown 경유 재생성이라 복잡한 서식은 손실 — proposal에 경고 명시. 서식 중요 문서는 HWPX 권장
3. **한국어 인코딩**: 디코딩은 kordoc 신뢰, 경로 NFC 정규화(macOS NFD), 한자·특수기호 라운드트립 픽스처, Windows UTF-8 문서화
4. **MCP 서버 툴 수 폭증**: `allowedTools` + 40툴 경고, 기본은 경량 korean-law-mcp(17툴)
5. **AI SDK v6 API 변동**: `ai` import를 `providers/`와 툴 래퍼에 격리, minor 고정, 3사 스모크 테스트. v6 멀티스텝 정지 조건 심볼명은 스캐폴딩 시 확인(SPEC §1)

## 핵심 파일

- `pnpm-workspace.yaml` — 모노레포 루트
- `packages/core/src/agent/session.ts` — 에이전트 루프, 이벤트 스트림, 승인 게이트
- `packages/core/src/tools/registry.ts` — `requiresApproval` 기계적 강제
- `packages/doc-tools/src/staging.ts` — 제안/diff/백업/원자적 커밋 파이프라인
- `packages/core/src/mcp/manager.ts` — MCP 라이프사이클, korean-law 기본 번들
- `packages/cli/src/update.ts` — OTA 업데이트 체크
