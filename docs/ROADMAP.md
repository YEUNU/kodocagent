# 로드맵 — 남은 작업 정의

> 2026-06-11 기준. 완료 기준과 차단 요인을 명시한다. 변경 시 이 문서를 갱신한다.

## 완료 (v1 코어, main에 배포됨)

| 단계 | 내용 | 커밋 |
|---|---|---|
| M0 | 모노레포 스캐폴딩 + 설계/개발 전략 문서 | `baacd04` |
| M1 | 에이전트 루프(AI SDK v6) + BYOK 3사 + JSONL 세션 + CLI 채팅 | `39d487c` |
| M2 | 문서 쓰기 툴(HWPX/DOCX/XLSX) + 2단계 승인 게이트 + 스테이징/백업/diff | `7bfb927` |
| M3 | MCP 클라이언트 + korean-law 기본 번들 | `8871f22` |
| M4 | OTA 업데이트 체크 + 사용자 문서 + 배포 준비 | `fc216c5` |
| 운영 | CI 그린(3 OS × Node 22/24), Actions v6, TS6 의존성 최신화 | `4b159d7` |
| 검증 | **실키 E2E(OpenAI gpt-5.5)**: HWPX 읽기·요약 성공, 비대화형 쓰기 자동 거절 + 원본 무변경 확인 | — |

## 남은 작업

### M4.5 — v1 폴리싱 (즉시 진행 가능)

코드 점검에서 확인된 갭:

| # | 작업 | 완료 기준 |
|---|---|---|
| 1 | **스테이징/백업 정리 정책** — 현재 무한 누적 | 세션 정상 종료 시 해당 세션 스테이징 자동 삭제. `kodocagent clean` 명령: 스테이징 전체 + 30일 경과 백업 정리(`--all`로 백업 전체). 테스트 포함 |
| 2 | **`/model` 커스텀 모델 직접 입력** — 현재 TODO(`chat.ts:321`) | clack text로 임의 모델 ID 입력 → 저장 + 즉시 적용 (BYOK 특성상 미등재 ID 허용) |
| 3 | **세션 재개 통합 테스트** — loadHistory 후 풀턴 미검증 | 멀티턴 기록 → 재개 → 모의 모델 턴에서 이전 컨텍스트 포함 assert |
| 4 | **read_document 픽스처 보강** — .docx/.xlsx 실파싱 테스트 부재 | exceljs/md-to-docx로 생성한 픽스처 → kordoc parse 마크다운 검증 |
| 5 | 채팅 툴콜 표시에 핵심 인자(path 등) 1줄 요약 | `⚙ propose_edit(보고서.hwpx)` 형태 |

### R1 — v0.1.0 첫 릴리스 (사용자 액션 차단 중)

| # | 작업 | 담당 |
|---|---|---|
| 1 | 저장소 Settings → Actions → General → **"Allow GitHub Actions to create and approve pull requests"** 활성화 | **사용자** (보안 설정 — 에이전트 권한 차단됨) |
| 2 | Settings → Secrets → Actions에 **`NPM_TOKEN`** 등록 (automation 토큰) | **사용자** |
| 3 | Release 워크플로가 생성한 "chore: version packages" PR 검토·머지 → npm 자동 배포 | 사용자(머지) |
| 4 | 클린 환경 `npx kodocagent@latest` 스모크 + 패치 배포로 업데이트 배너 확인 (SPEC §12 M4 잔여) | 에이전트 |

### E2E-2 — 실키 검증 잔여 (키 제공 시 진행)

| # | 검증 | 필요한 것 |
|---|---|---|
| 1 | Anthropic(`claude-opus-4-8`)·Google(`gemini-3.5-flash`) 채팅+툴콜 | `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` |
| 2 | 법령 MCP 실연동: "근로기준법 제60조 확인해서 취업규칙 검토" (SPEC §12 M3 잔여) | `LAW_OC` (open.law.go.kr 무료) |
| 3 | 대화형 승인 흐름(diff→승인→백업→저장) 수동 확인 | 터미널 직접 실행 |

### M5 — GUI (v2)

**프레임워크 결정: Electron** (2026-06-11)
- 근거: 로컬에 Rust 툴체인 부재(Tauri는 Rust 필수), 기존 Node/TS 툴체인 재사용, `@rhwp/editor`(iframe 웹 컴포넌트)와 자연 결합, electron-updater로 GUI OTA 가능
- 트레이드오프: 번들 크기(~100MB). Tauri 전환은 추후 재검토 가능 (core가 UI 비종속이라 교체 비용 낮음)

| 단계 | 산출물 | 완료 기준 | 상태 |
|---|---|---|---|
| **M5a** GUI 스캐폴딩 | `packages/gui`(비공개 패키지): Electron 42 + electron-vite + React 19, 채팅 화면(스트리밍·툴콜 칩), 승인 다이얼로그(diff·사유 입력), IPC 승인 브릿지, cwd 폴더 선택, 기존 `~/.kodocagent` 설정 공유 | 로컬에서 창 실행 → 실키 채팅 → propose 승인/거절 동작 | ✅ 구현·기동 확인 (에러 0). **잔여: 화면 채팅·승인 수동 확인** — `cd packages/gui && pnpm dev` (OPENAI_API_KEY 필요) |
| **M5b** 문서 미리보기 | `@rhwp/editor` 임베드로 HWPX 시각 미리보기(승인 전 전/후), 문서 탐색 패널, 마크다운 렌더링, GUI 온보딩, 세션 재개 UI | 실제 .hwpx 렌더링 + 승인 흐름에 미리보기 연동 | 예정 |
| **M5c** 패키징/배포 | electron-builder(맥 dmg/윈도 nsis), electron-updater(GitHub Releases 채널) | 설치본에서 자동 업데이트 확인 | 예정 |

M5a 참고: electron-vite는 vite 8 지원을 위해 6.0.0-beta.1 사용 중 — stable 출시 시 갱신. CI는 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`로 바이너리 없이 빌드/타입체크/테스트만 수행.

## 운영 원칙 (요약)

- 진행 방식: [DEVELOPMENT.md](DEVELOPMENT.md) — Sonnet 4.6 서브에이전트 구현 / Fable 5 검증·커밋
- 실험용 BYOK 키: 레포 루트 `.env`(gitignored)의 `GPT_API_KEY` → `OPENAI_API_KEY`로 주입해 사용
- 의존성: Dependabot 주간 + 마일스톤 시작 시 최신화. TS6 전환 완료(`ignoreDeprecations: "6.0"` — tsup의 baseUrl 사용이 TS7에서 제거 예정이므로 tsup 업데이트 추적 필요)
