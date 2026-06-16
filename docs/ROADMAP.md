# 로드맵 — 1.0.0(CLI)로 가는 길

> 2026-06-15 기준. **1.0.0의 범위는 CLI**로 확정(사용자 결정). GUI는 1.0과 독립된 0.x 트랙으로 분리한다.
> 완료 기준과 차단 요인을 명시하며, 변경 시 이 문서를 갱신한다.

## 1.0.0의 정의 (Definition of Done — CLI)

> **5대 기능이 전부 실키·실파일로 검증되고, 공개 API가 동결(시맨틱 버저닝 약속)되며, CI 자동 발행·OTA 자동 업데이트가 동작하는 상태.**

5대 기능: ① OTA 무료 업데이트 ② 에이전트 하네스/루프 ③ BYOK(OpenAI·Claude·Gemini) ④ HWP/HWPX/DOCX/XLSX 읽기·수정 ⑤ 한국 법령 연동 문서 검토.

## 완료 (main에 배포됨)

| 단계 | 내용 | 커밋 |
|---|---|---|
| M0 | 모노레포 스캐폴딩 + 설계/개발 전략 문서 | `baacd04` |
| M1 | 에이전트 루프(AI SDK v6) + BYOK 3사 + JSONL 세션 + CLI 채팅 | `39d487c` |
| M2 | 문서 쓰기 툴(HWPX/DOCX/XLSX) + 2단계 승인 게이트 + 스테이징/백업/diff | `7bfb927` |
| M3 | MCP 클라이언트 + korean-law 기본 번들 | `8871f22` |
| M4 | OTA 업데이트 체크 + 사용자 문서 + 배포 준비 | `fc216c5` |
| M4.5 | v1 폴리싱 — `clean` 명령, `/model` 커스텀 입력, 문서 매트릭스 회귀 테스트·격리 | `08f1257` |
| M5a | Electron GUI 스캐폴딩 (채팅 + 승인 다이얼로그) — GUI 트랙 시작점 | `241ac65` |
| R1 | **v0.1.0 npm 첫 발행** (`@kodocagent/cli`) | `b9540c9` |
| R2 | **v0.2.0 발행 — OIDC 자동 발행**(토큰·2FA 없이) | `c4bd004` |
| R3 | **v0.3.0 발행 — CLI 폴리시·UX 8항목**(컨텍스트 관리·사용량 표시·효율 읽기·세션 재개·진행 표시·승인 1단계) | OIDC 자동 |
| 운영 | CI 그린(3 OS × Node 22/24), Actions v6, TS6 의존성 최신화 | `4b159d7` |
| 검증 | 실키 E2E(2026-06-15): **OpenAI gpt-5.5 + Google gemini-3.5-flash + Anthropic claude-sonnet-4-6** 읽기·요약(툴콜)·쓰기 거절+원본 무변경; **법령 MCP(korean-law)** 연동으로 근로기준법 제60조 조회→취업규칙 위반 식별·인용 성공 | — |

문서 매트릭스 회귀 현황(M4.5): XLSX/DOCX/HWPX 실파일 라운드트립 + 한자·특수기호(漢字 §1 ①) 보존 테스트 통과. **잔여 커버리지: PDF/MD/TXT 읽기, .hwp 실바이너리** → v0.2.0에서 보강.

---

## CLI 1.0 경로 (버전별 목표)

### v0.2.0 — 검증된 코어 (Verified Core)

> 테마: "동작한다"에서 "검증됐다"로. 1.0의 신뢰 기반. **✅ 전 항목 완료(2026-06-15), v0.2.0 발행됨.**

| # | 작업 | 완료 기준 | 차단/필요 | 진행 |
|---|---|---|---|---|
| 1 | 문서 매트릭스 커버리지 마감 | MD/TXT 직접 처리 구현 + 회귀 테스트(127건 그린) | 없음 | ✅ `c363c1b` |
| 2 | OpenAI 실키 E2E 재검증 | `.env` 키로 읽기·요약·비대화형 쓰기 거절 재확인(코어 리팩터 후 무결성) | 없음(`.env`) | ✅ 통과(2026-06-15) — 3줄 요약 정확, 쓰기 거절+원본 해시 무변경 |
| 3 | 한국어 에러·온보딩 카피 점검 + 에러 UX 픽스 | 카피 검수(명백한 이슈 없음) + 모델 API 오류 시 onError 원시 덤프 제거 | 없음 | ✅ `924b091` |
| 4 | **CI 자동 발행 — OIDC Trusted Publishing 전환** | main 푸시 시 토큰 없이 자동 발행(provenance 포함). 2FA 토큰 문제 제거 | (등록 완료) | ✅ **완전 검증** — Trusted Publisher 등록 후 v0.2.0이 OIDC로 자동 발행됨(2026-06-15) |
| 5 | Anthropic·Google 실키 채팅+툴콜 | 2사 각각 한국어 채팅 + read_document 툴콜 성공 | — | ✅ Google·Anthropic 모두 통과(2026-06-15). **BYOK 3사 전체 실증 완료** |
| 6 | 법령 MCP 실연동 | "근로기준법 제60조 확인해서 취업규칙 검토" → 법령 MCP 호출 → 조문 인용 제안 | `LAW_OC` 제공됨 | ✅ 통과(2026-06-15) — korean-law(9툴) 연결, 제60조 조회·인용, 연차 10일<15일 위반 식별 |
| 7 | 대화형 승인 흐름 확인 | diff→승인→백업→원자적 저장 | (확인 완료) | ✅ 통과(2026-06-15) — 실파일 승인→백업 생성→연 15일 저장 확인. 승인 UI 1단계 단순화 + 거절 무한루프 제거 반영(`7991a6c`) |

**검증 중 발견·수정**: 법령 MCP 첫 연결이 npx 최초 다운로드로 10초 타임아웃을 초과해 실패하던 실사용 버그 → stdio 연결 타임아웃 **60초 상향** + 재시도 안내 (`ecbac52`, 빈 캐시 콜드 연결 실증).

### v0.3.0 — CLI 폴리시·UX

> 테마: 매일 쓸 만한 도구로.

| # | 작업 | 완료 기준 |
|---|---|---|
| 1 | `compare_documents` 툴 노출 | ✅ `ee89c1e` — kordoc `compare` 기반 두 문서 구조 diff 툴 등록 + 테스트(실파일 검증) |
| 2 | 세션 목록/재개 UX 개선 | ✅ `2966ed5` — `sessions` 첫 메시지 미리보기·최근순, `--resume [id]` 선택 UI(TTY 가드) |
| 3 | 채팅 진행 표시 | ✅ `0eb6d29` — MCP 연결 스피너 + 툴 실행 스피너/소요시간. 검증 중 발견·수정: 비 TTY 스피너 이스케이프 도배 가드, stdio MCP 잔존으로 `/exit` 행 버그(`process.exit(0)`) |
| 4 | 큰 문서·다중 MCP 안정성 | ✅ `f60fcda` — read_document 100MB 파일 가드(OOM/행 방지), MCP 툴 수 경고를 채팅·단발 질의에서도 표시 |
| 5 | 도움말/카피 폴리시 마감 | ✅ — README CLI·슬래시·config 키 표 + 주요 기능(효율 읽기·컨텍스트 관리) 최신화, 승인 1단계 단순화(`7991a6c`) |
| 6 | **대화 컨텍스트 관리** | ✅ `4e16018` — 토큰 예산(`maxContextTokens`) 초과 시 오래된 도구 결과 자동 압축(짝·최근 턴 보존), 무한 누적 방지 |
| 7 | **컨텍스트 사용량 표시** | ✅ `3b4d7ee` — 매 턴 푸터 `컨텍스트: N/예산 (%)` + `/context` 명령(70%/90% 경고색) |
| 8 | **효율적 문서 읽기** | ✅ `e53da7b` — `read_document` outline(구조만)/search(키워드 주변만) 모드, 프롬프트 안내 |

### v0.4.0 — 한글 표·양식 정확 수정 (구조 보존)

> 테마: "글자는 고쳐진다"에서 "한글 문서답게 고쳐진다"로. 기능 ④(HWP/HWPX 수정)의 정확도를 실무 수준으로.

**현재 능력 실측(2026-06-16, kordoc 2.7.6):**

| 케이스 | 현재 | 근거 |
|---|---|---|
| 단순 격자 표 셀 편집 | ✅ 정확 | 3×3 왕복 + 셀 편집 무손실 |
| 라벨/값 양식(2열 표) 값 채우기 | ✅ 정확 | `extractFormFields` conf 1.0, 값 치환 반영 |
| 병합셀 표(colSpan/rowSpan) | ❌ **평면화** | 왕복 후 전 셀 span=1 — 병합 구조 파괴 |
| 진짜 양식 개체(입력상자·누름틀·콤보박스) | ❌ 미지원 | label-value 표 휴리스틱만 |
| 셀 서식(배경색·정렬·글꼴)·중첩표 | ⚠️ 손실 | markdown 왕복 한계 |

**근본 원인**: kordoc 쓰기 API가 `markdownToHwpx(markdown)` 하나뿐 — `IRBlock[]` 직접 쓰기 경로 없음. 모든 편집이 markdown 병목을 거쳐, markdown이 표현 못 하는 구조(병합·서식·양식 개체)가 손실됨. `templateArrayBuffer`는 파일 골격·스타일만 제공하고 본문 표는 markdown에서 재생성.

**제안 방향**: markdown 전체 재생성 대신 **HWPX(zip+XML) 셀 단위 직접 패치** — 바꿀 셀의 run 텍스트만 교체하고 나머지 바이트는 보존(병합·서식·양식 개체 무손실). 아래는 후보 작업.

| # | 작업 | 완료 기준 |
|---|---|---|
| 1 | 병합셀 보존 회귀 테스트(현 손실을 고정) | 병합표 왕복 시 span 보존 단언 — v0.4 구현 전엔 xfail/스킵으로 기준선 명시 |
| 2 | HWPX 구조 패치 기반 `propose_cell_edit`(표 좌표/라벨 단위) | 병합·서식 보존하며 특정 셀 텍스트만 수정, diff·승인 연동 |
| 3 | 양식 개체 인식·채우기 정밀화 | 입력상자/누름틀 등 실제 양식 컨트롤 식별·값 설정(가능 범위 한정 명시) |
| 4 | 한컴오피스 왕복 수동 확인 | 병합표 포함 .hwpx 편집본이 한/글에서 정상 열림 |

> 미정 결정: 구현 접근(HWPX XML 직접 패치 vs kordoc 업스트림 `blocksToHwpx` 대기 vs HTML-table 확장). 1순위 후보는 **XML 직접 패치**(외부 의존 없음·구조 무손실).

### v1.0.0 — 안정화·API 동결 (CLI GA)

> 테마: 약속할 수 있는 버전.

| # | 작업 | 완료 기준 |
|---|---|---|
| 1 | 5대 기능 전체 E2E 그린 | 3사 실키 + 법령 MCP + 문서 읽기/쓰기/승인 전 경로 통과 |
| 2 | 공개 API 동결 + 시맨틱 버저닝 약속 | config 스키마·툴 시그니처·AgentEvent 안정 선언, CHANGELOG 정책 명시 |
| 3 | 문서 포맷 매트릭스 한컴오피스 왕복 | 실제 한컴오피스에서 산출 .hwpx 열림 확인(수동) |
| 4 | 회귀 커버리지 목표 | 핵심 경로 커버리지 기준 설정·달성 |
| 5 | 문서·도움말 완비 | README/SPEC/DEVELOPMENT 최신화, 사용 가이드 |

---

## GUI 트랙 (1.0과 독립, 0.x)

**프레임워크: Electron** (2026-06-11 결정)
- 근거: 로컬 Rust 툴체인 부재(Tauri는 Rust 필수), 기존 Node/TS 재사용, `@rhwp/editor`(iframe 웹 컴포넌트) 자연 결합, electron-updater로 GUI OTA 가능
- 트레이드오프: 번들 ~100MB. core가 UI 비종속이라 Tauri 전환 비용 낮음(추후 재검토 가능)

| 단계 | 산출물 | 완료 기준 | 상태 |
|---|---|---|---|
| GUI 스캐폴딩(M5a) | `packages/gui`(비공개): Electron 42 + electron-vite + React 19, 채팅·툴콜 칩, 승인 다이얼로그(diff·사유), IPC 승인 브릿지, cwd 선택, `~/.kodocagent` 설정 공유 | 창 실행 → 실키 채팅 → propose 승인/거절 | ✅ 구현·기동(에러 0). 잔여: 화면 수동 확인 `cd packages/gui && pnpm dev` |
| GUI 미리보기(M5b) | `@rhwp/editor` 임베드 HWPX 시각 미리보기(승인 전 전/후), 문서 탐색 패널, 마크다운 렌더, 세션 재개 UI, GUI 온보딩 | 실제 .hwpx 렌더 + 승인 흐름 미리보기 연동 | 예정 |
| GUI 패키징(M5c) | electron-builder(맥 dmg/윈도 nsis), electron-updater(GitHub Releases 채널) | 설치본 자동 업데이트 확인 | 예정 |

GUI 참고: electron-vite는 vite 8 지원 위해 6.0.0-beta.1 사용 — stable 출시 시 갱신. CI는 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`로 빌드/타입체크/테스트만 수행.

---

## 알려진 제약 (의존성)

- **PDF 읽기(kordoc/pdfjs-dist)**: ① pnpm 개발 환경에서 wasm 경로 해석 버그로 비결정적 행(hang)/오류 발생(설치형 번들에서는 정상 추정) → 단위 테스트 제외. ② PDF 파싱 시 `process.cwd()`에 `.kordoc_ocr_tmp/`(OCR용 PNG) 임시 산출물을 남김 → `.gitignore` 처리. 사용자 cwd 오염은 kordoc 동작이며, 추후 업스트림 이슈 제기 검토. (`v0.2.0` 검증 중 발견)
- ~~**`ANTHROPIC_BASE_URL` 환경변수 footgun**~~ **(해결됨, v0.2.0 발행분)**: AI SDK는 `ANTHROPIC_BASE_URL`을 baseURL로 그대로 사용한다. Claude Code/Desktop은 이 값을 `https://api.anthropic.com`(끝에 `/v1` 없음)으로 주입하는데, 같은 셸에서 kodocagent를 실행하면 `…/messages`(/v1 누락)로 가서 404가 났다. → `normalizeAnthropicBaseUrl`로 **공식 호스트(api.anthropic.com)이고 경로가 비었거나 `/`일 때만 `/v1` 보정**(커스텀 프록시 URL은 보존)하도록 수정·검증 완료. (`v0.2.0` 검증 중 발견·수정)

## 운영 원칙 (요약)

- 진행 방식: [DEVELOPMENT.md](DEVELOPMENT.md) — Sonnet 4.6 서브에이전트 구현 / Fable 5 검증·커밋
- 실험용 BYOK 키: 레포 루트 `.env`(gitignored)의 `GPT_API_KEY` → `OPENAI_API_KEY`로 주입해 사용
- 의존성: Dependabot 주간 + 마일스톤 시작 시 최신화. TS6 전환 완료(`ignoreDeprecations: "6.0"` — tsup의 baseUrl 사용이 TS7에서 제거 예정이므로 tsup 업데이트 추적 필요)
- 발행: `release.yml`이 **npm OIDC Trusted Publishing**으로 자동 발행(장기 토큰·2FA 불필요, provenance 포함). pnpm 11 OIDC 404 회귀를 피해 발행 단계만 npm CLI 사용. Trusted Publisher 등록 완료 → **v0.2.0부터 main에 버전 범프 push 시 자동 발행**(검증됨 2026-06-15). 릴리스 절차: `packages/cli/package.json` 버전 올리고 CHANGELOG 갱신 → push.
