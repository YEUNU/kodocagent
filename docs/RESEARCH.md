# 기반 기술 조사

> 2026-06-10 조사 기준. 버전·스타 수 등은 시점 정보. 2차 검증(npm 패키지·.d.ts 직접 확인) 반영 — **굵은 정정** 참고.

## 1. kordoc — 한국 문서 파싱/변환

- **저장소**: https://github.com/chrisryugj/kordoc (TypeScript, MIT, ★1,011)
- **배포**: npm `@clazic/kordoc` **v2.7.6 (npm 최신 — GitHub 릴리스 v2.9.1과 차이 있음, npm 기준으로 핀)** / CLI(`npx kordoc`) / MCP 서버 셋 다 제공
- **요구사항**: Node 18+, ESM+CJS 듀얼

### 포맷 지원 매트릭스

| 포맷 | 읽기 | 쓰기 | 비고 |
|---|---|---|---|
| HWP 3.x | ✓ | ✗ | 레거시 (1996–2002) |
| HWP 5.x | ✓ | ✗ | OLE2 바이너리, AES-128 암호화 문서 지원 |
| HWPX | ✓ | ✓ | ZIP+XML, 직접 조작 가능 |
| HWPML | ✓ | ✗ | |
| PDF | ✓ | ✓ | XY-Cut 테이블 인식 |
| DOCX / XLSX / XLS | ✓ | ✗ | |

### 핵심 API (.d.ts 검증 완료 — 시그니처는 [SPEC.md](SPEC.md) §2)

- `parse(path|ArrayBuffer|Buffer)` → `Promise<ParseResult>` — **throw하지 않음**, `{success, markdown, blocks, metadata, warnings, fileType}` 또는 `{success: false, error, code}` (code: `ENCRYPTED`/`CORRUPTED`/`IMAGE_BASED_PDF` 등)
- `markdownToHwpx(md, {templateArrayBuffer})` — **원본을 템플릿으로 넘기면 서식 보존** (쓰기 경로의 핵심)
- `fillForm(buffer, values, {format: "hwpx-preserve"})` — 원본 서식 유지 폼 채우기
- `compare(bufferA, bufferB)` — **ArrayBuffer만 받음(경로 불가)**, 포맷 교차 비교 지원

특징: 모든 포맷을 IR로 정규화 후 변환, 2-pass 테이블 빌딩(colSpan/rowSpan), 손상된 ZIP 복구. 암호 파라미터는 미노출(암호화 문서는 ENCRYPTED 코드 반환).

## 2. rhwp — HWP 렌더링/편집 (Rust+WASM)

- **저장소**: https://github.com/edwardkim/rhwp (Rust+WASM+TS, MIT, ★3,304)
- **배포**: npm `@rhwp/core`(WASM), `@rhwp/editor`(iframe 웹 에디터) v0.7.15, Rust CLI(cargo, npm 아님), VS Code/브라우저 확장
- **지원**: HWP 5.0 + HWPX 읽기, SVG/HTML/Canvas 렌더링
- **핵심 API**: `new HwpDocument(Uint8Array)`, `pageCount()`, `renderPageSvg(page)`

**⚠ 2차 검증 정정 — Node 서버사이드 부적합 (v1 CLI에서 제외 확정)**:
- 텍스트 레이아웃에 브라우저 canvas 기반 `globalThis.measureTextWidth` 필수 — Node 구현 미제공
- PNG 출력은 Rust CLI(`rhwp export-png`, native-skia 빌드)에서만 가능, npm API에는 없음
- **쓰기/저장 API가 WASM 바인딩에 미노출** (insertText 등 편집은 메모리상만, HWPX 저장은 의도적 비활성) — "HWP 쓰기 대안" 가설 기각
- 결론: **M5 GUI(브라우저 환경)에서 `@rhwp/editor` 임베드로만 사용**. v1 CLI 미리보기는 텍스트/구조 diff로 대체

## 3. awesome-mcp-korea — 한국 MCP 생태계

- **저장소**: https://github.com/darjeeling/awesome-mcp-korea — 67개 MCP 서버, 11개 카테고리

### 법령 관련 MCP 서버 (9개 중 주요)

| 서버 | 특징 |
|---|---|
| [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) | **기본 번들 채택.** 한국 법령 API 42개를 17개 MCP 툴로 — 법령/판례/행정규칙/자치법규/헌재결정/법령해석례. 인용 검증, 시점 비교 diff. PyPI `korean-law-mcp` |
| [ChangooLee/mcp-kr-legislation](https://github.com/ChangooLee/mcp-kr-legislation) | 130+ 툴 (가장 방대하나 컨텍스트 부담 큼 → 기본 채택 안 함) |
| [seo-jinseok/korean-law-mcp](https://github.com/seo-jinseok/korean-law-mcp) | 구어체 법령명 인식, 공식 출처 URL 생성 |
| [hollobit/assembly-api-mcp](https://github.com/hollobit/assembly-api-mcp) | 국회 API — 의안/회의록/청원 |
| [Koomook/data-go-mcp-servers](https://github.com/Koomook/data-go-mcp-servers) | data.go.kr 공공데이터 |

### 국가법령정보센터 Open API

- 포털: https://open.law.go.kr (가이드: /LSO/openApi/guideList.do)
- **무료** API 키 (법제처 발급, data.go.kr 경유 가능)
- 인증: URL 파라미터 `?oc=` 또는 환경변수 — **2차 검증 정정: korean-law-mcp의 환경변수명은 `LAW_OC`** (LAW_API_OC 아님). 선택 변수: `LAW_API_PROTOCOL`, `LAW_REFERER`, `LAW_USER_AGENT`
- 포맷: JSON(기본)/XML
- 커버리지: 현행 법령 조문, 시행일별 목록, 개정 이력, 행정규칙, 자치법규, 판례, 법령해석례, 조약, 헌재결정
- 미확인: 일일 호출 한도 수치(문서화 안 됨)

**korean-law-mcp 실행 방식 (검증)**: **npm 패키지 존재** — `npx -y korean-law-mcp@latest` (stdio MCP 서버, **Python 불필요**). PyPI 변형도 존재(`uvx korean-law-mcp`, Python ≥3.10). 기본 번들은 npx 방식 채택.

## 4. oh-my-pi — 하네스 아키텍처 레퍼런스

- **저장소**: https://github.com/can1357/oh-my-pi (TS 84% + Rust, MIT, ★11.6k)
- 포크하지 않고 **설계 패턴만 차용**:

| oh-my-pi 패턴 | kodocagent 적용 |
|---|---|
| AgentSession 멀티턴 루프 + 이벤트 스트림 | `AgentSession.run(): AsyncIterable<AgentEvent>` |
| Zod 스키마 툴 + `execute({signal})` + 스트리밍 onUpdate | core 툴 레지스트리 |
| append-only JSONL 세션 영속화 | `~/.kodocagent/sessions/*.jsonl` |
| "(proposed)" 카드 → resolve 커밋 | 미리보기+승인 게이트 (`requiresApproval`) |
| MCPManager (stdio/HTTP, 프로젝트+사용자 설정) | `core/src/mcp/manager.ts` |
| 40+ 프로바이더 역할 라우팅 | v1은 3사 BYOK 단순화, 라우팅 제외 |

차용하지 않는 것: LSP/DAP 연동, 실행 커널(Python/Bun), TTSR 스트림 규칙, 서브에이전트 — 코딩 에이전트 특화 기능으로 본 프로젝트엔 과함.

## 5. SDK 버전·모델 ID (2026-06-10 검증)

| 항목 | 검증 결과 |
|---|---|
| Vercel AI SDK | **v6이 현재** (`ai@6.0.199`) — 초기 계획의 v5는 구버전. 프로바이더는 `@ai-sdk/*@3.x` |
| MCP SDK | `@modelcontextprotocol/sdk@1.29.0` (stdio + Streamable HTTP) |
| Anthropic 모델 | `claude-opus-4-8`($5/$25), `claude-fable-5`($10/$50), `claude-sonnet-4-6`($3/$15), `claude-haiku-4-5`($1/$5). **Opus 4.7+/Fable 5는 temperature/top_p/top_k에 400** — 샘플링 파라미터 미설정 원칙 |
| OpenAI 모델 | `gpt-5.5`(플래그십), `gpt-5.4`, `gpt-5.4-mini`, `gpt-5` |
| Gemini 모델 | `gemini-3.5-flash`(GA 안정), `gemini-3.1-pro-preview`, `gemini-2.5-pro/flash` |
| npm 이름 | `kodocagent`, `@kodocagent/*` 모두 미등록(확보 가능) |
| 쓰기 라이브러리 | `docx@9.7.1`(MIT), `exceljs@4.4.0`(MIT) |

## 결론

5가지 요구 기능 전부 기존 오픈소스 조합으로 커버 가능:

1. **OTA 업데이트** → npm 배포 + 자체 업데이트 체크 (무료)
2. **에이전틱 하네스** → Vercel AI SDK v6 위 자체 경량 루프 (oh-my-pi 패턴 차용)
3. **BYOK 3사** → `@ai-sdk/openai|anthropic|google@3`
4. **문서 읽기/수정** → kordoc(읽기 전포맷 + HWPX 쓰기) + docx/exceljs(DOCX/XLSX 쓰기)
5. **법령 기반 검토** → korean-law-mcp 기본 번들 (`npx`, `LAW_OC`, 무료 API)

주요 갭과 정책:
- HWP 5.0 바이너리 **쓰기**는 kordoc·rhwp 모두 불가(검증) → `.hwp` 편집 결과는 `.hwpx` 저장 정책
- 시각 미리보기는 Node에서 불가(rhwp 브라우저 전용) → v1은 텍스트/구조 diff, 시각화는 M5 GUI
- DOCX 편집은 마크다운 경유 재생성이라 복잡 서식 손실 → proposal 카드에 경고 명시
