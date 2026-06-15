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
| 운영 | CI 그린(3 OS × Node 22/24), Actions v6, TS6 의존성 최신화 | `4b159d7` |
| 검증 | 실키 E2E(OpenAI gpt-5.5): HWPX 읽기·요약 성공, 비대화형 쓰기 자동 거절 + 원본 무변경 | — |

문서 매트릭스 회귀 현황(M4.5): XLSX/DOCX/HWPX 실파일 라운드트립 + 한자·특수기호(漢字 §1 ①) 보존 테스트 통과. **잔여 커버리지: PDF/MD/TXT 읽기, .hwp 실바이너리** → v0.2.0에서 보강.

---

## CLI 1.0 경로 (버전별 목표)

### v0.2.0 — 검증된 코어 (Verified Core)

> 테마: "동작한다"에서 "검증됐다"로. 1.0의 신뢰 기반.

| # | 작업 | 완료 기준 | 차단/필요 | 진행 |
|---|---|---|---|---|
| 1 | 문서 매트릭스 커버리지 마감 | MD/TXT 직접 처리 구현 + 회귀 테스트(127건 그린) | 없음 | ✅ `c363c1b` |
| 2 | OpenAI 실키 E2E 재검증 | `.env` 키로 읽기·요약·비대화형 쓰기 거절 재확인(코어 리팩터 후 무결성) | 없음(`.env`) | 자율 |
| 3 | 한국어 에러·온보딩 카피 점검 + 에러 UX 픽스 | 카피 검수(명백한 이슈 없음) + 모델 API 오류 시 onError 원시 덤프 제거 | 없음 | ✅ `924b091` |
| 4 | **CI 자동 발행 — OIDC Trusted Publishing 전환** | main 푸시 시 토큰 없이 자동 발행(provenance 포함). 2FA 토큰 문제 제거 | 🔧 npmjs 패키지 설정에 이 저장소 Trusted Publisher 등록(사용자 1회) | ✅ 워크플로 작성 완료(`release.yml`). 등록 + 실제 버전 범프 시 검증 |
| 5 | Anthropic·Google 실키 채팅+툴콜 | 2사 각각 한국어 채팅 + read_document 툴콜 성공 | 🔑 `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | 키 필요 |
| 6 | 법령 MCP 실연동 | "근로기준법 제60조 확인해서 취업규칙 검토" → 법령 MCP 호출 → 조문 인용 제안 | 🔑 `LAW_OC` (open.law.go.kr 무료) | 키 필요 |
| 7 | 대화형 승인 흐름 수동 확인 | diff→승인→백업→원자적 저장, 거절+사유→재제안 1회 | 터미널 직접 실행 | 사용자 |

### v0.3.0 — CLI 폴리시·UX

> 테마: 매일 쓸 만한 도구로.

| # | 작업 | 완료 기준 |
|---|---|---|
| 1 | `compare_documents` 툴 노출 | kordoc `compare` 기반 두 문서 구조 diff 툴 등록 + 테스트 |
| 2 | 세션 목록/재개 UX 개선 | `sessions`에 제목·요약·최근순, `--resume` 선택 UI |
| 3 | 채팅 진행 표시·diff 렌더 개선 | 긴 툴 실행 스피너/단계 표시, 컬러 diff 가독성 |
| 4 | 큰 문서·다중 MCP 안정성 | 대형 .xlsx/.hwpx 처리 시간·메모리 점검, 툴 수 폭증 경고 동작 확인 |
| 5 | 도움말/카피 폴리시 마감 | `--help`, 온보딩, 슬래시 명령 카피 최종본 |

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

## 운영 원칙 (요약)

- 진행 방식: [DEVELOPMENT.md](DEVELOPMENT.md) — Sonnet 4.6 서브에이전트 구현 / Fable 5 검증·커밋
- 실험용 BYOK 키: 레포 루트 `.env`(gitignored)의 `GPT_API_KEY` → `OPENAI_API_KEY`로 주입해 사용
- 의존성: Dependabot 주간 + 마일스톤 시작 시 최신화. TS6 전환 완료(`ignoreDeprecations: "6.0"` — tsup의 baseUrl 사용이 TS7에서 제거 예정이므로 tsup 업데이트 추적 필요)
- 발행: `release.yml`이 **npm OIDC Trusted Publishing**으로 자동 발행(장기 토큰·2FA 불필요, provenance 포함). pnpm 11 OIDC 404 회귀를 피해 발행 단계만 npm CLI 사용. **최초 1회 사용자 설정**: npmjs.com → `@kodocagent/cli` → Settings → Trusted Publisher 추가(GitHub Actions / 저장소 `YEUNU/kodocagent` / 워크플로 `release.yml`). 등록 전 패치 릴리스는 수동 `pnpm --filter @kodocagent/cli publish --otp=<앱코드>`
