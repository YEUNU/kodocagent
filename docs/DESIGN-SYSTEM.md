# 디자인 시스템 — kodocagent GUI

> 2026-06-18. [GUI-DESIGN.md](GUI-DESIGN.md)(비전)의 시각 구현체. `design/`의 정적 HTML 컴포넌트 라이브러리를 정의하고, claude.ai/design 동기화 및 Electron 구현 매핑을 기술한다.
> **de-AI 개정**: "AI가 만든 티"(이모지 아이콘 남발·Tailwind 기본색·빛나는 로고)를 제거 — inline SVG 아이콘 세트, 정제 팔레트(스틸블루·뮤트 시맨틱), 단색 브랜드마크로 교체.

## 1. 테마 결정 (확정)

**다크 중립 크롬 + 라이트 페이퍼.** 어두운 슬레이트 크롬(패널·대화·툴바·모달)이 흰 "종이" 문서 캔버스를 감싼다. 시선이 실제 문서에 집중되고("결과를 보여준다"), 문서 미리보기는 한글 출력과 동형(흰 종이)이다. 라이트-크롬/테마-토글은 1.0 이후 변형으로 보류(`ds.css` 토큰만 교체하면 가능).

## 2. 토큰 & 아이콘 (`design/assets/ds.css` 단일 소스)

색을 로컬에서 새로 정의하면 코히런스가 깨진다 — **반드시 CSS 변수·클래스만** 쓴다.

| 영역 | 변수 | 값 (de-AI 정제) |
|---|---|---|
| 크롬 | `--chrome-bg/-surface/-elevated/-inset` | `#15171e / #1c1f28 / #242834 / #0f1115` |
| 텍스트 | `--text-strong/--text/--text-muted/--text-faint` | `#f1f3f7 / #c8cdd8 / #8b93a3 / #5f6675` |
| 페이퍼 | `--paper/-sunken/-border/-rule` · 잉크 | `#ffffff / #f5f6f8 / #e2e5ea / #eceef2` · `#1a1d24` |
| 강조 | `--accent / -hover` | **`#4d84cf` 스틸블루** (기본 `#3b82f6` 회피) |
| 시맨틱(크롬) | `--add / --remove / --warn / --pii` | 뮤트 `#4fa386` / `#d96b6b` / `#d3a142` / `#a07bc4` (네온 제거) |
| 시맨틱(페이퍼) | `--p-add-bg/-ink · --p-remove… · --p-pii… · --p-find-bg` | 라이트 배경 diff/하이라이트 |
| 백드롭 | `--scrim` | `rgba(0,0,0,0.62)` (모든 모달 공용) |

- **아이콘 = inline SVG (이모지 금지).** `assets/icons.html`이 정본 — `<svg class="ico" viewBox="0 0 24 24">…</svg>`. 텍스트 색·크기를 상속하므로 path에 stroke/fill 지정 안 함. 크기 `.ico--sm/-lg/-xl`. 28종(doc·folder·sheet·history·lock·shield·eye-off·check·alert·info·search·download·target·edit·checkbox·compare·law·message·key·chevron-down·arrow-right·external·x·plus·minus 등).
- **브랜드마크**: 빛나는 원형 로고 대신 `.brand-mark`(단색 라운드 사각 "k").
- 컴포넌트 클래스: `.btn`(primary/secondary/ghost/approve/danger), `.chip`(tool/coord/ok/warn/pii), `.badge`, `.card`, `.field`, `.tabs`, `.gauge`, `.pane`, `.paper`/`.doc-table`/`.cell--changed|removed|ghost`, `.mark-add|remove|pii|find`, `.diff`, `.split`, `.tool-row`, `.bubble-*`, `.safe-note`, `.verify-note`/`.spin`, `.honesty`/`.is-disabled`, `.banner--warn|info`, `.modal-scrim`/`.modal`.

## 3. 카드 인벤토리 & 커버리지 감사 (등록 도구 20개 → 카드)

`design/index.html`이 갤러리 진입점. 첫 줄 `<!-- @dsCard … -->` 컨벤션으로 claude.ai/design 카드가 자동 색인된다. **모든 등록 도구가 UI를 가진다**(아래 ✅ = de-AI 개정에서 갭 메움):

| # | 등록 도구 | 카드 |
|---|---|---|
| 1 | `read_document` | panels/document-preview |
| 2 | `read_file` | *(파일 열기·미리보기에 흡수 — 별도 카드 불필요, 의도)* |
| 3 | `find_in_document` | panels/document-preview (찾기) |
| 4 | `list_files` | panels/file-timeline |
| 5 | `list_backups` | panels/file-timeline · approval/export-restore |
| 6 | `restore_backup` | approval/export-restore |
| 7 | `scan_pii` | approval/redact-pii |
| 8 | `propose_redact_pii` | approval/redact-pii |
| 9 | `propose_edit` | approval/edit-diff |
| 10 | `propose_find_replace` | approval/find-replace |
| 11 | `propose_cell_edit` | approval/cell-edit |
| 12 | `propose_table_structure` | approval/table-structure |
| 13 | `propose_sheet_edit` | **approval/sheet-edit ✅** · panels/spreadsheet-preview ✅ |
| 14 | `propose_form_fill` | approval/form-fill |
| 15 | `list_form_objects` | **approval/form-object ✅** |
| 16 | `propose_form_object` | **approval/form-object ✅** |
| 17 | `export_document` | approval/export-restore · panels/document-preview(내보내기) |
| 18 | `compare_documents` | states/compare |
| 19 | `write_new_document` | **states/new-document ✅** |
| 20 | `write_new_spreadsheet` | **states/new-document ✅** |
| + | 한국 법령 MCP `korean-law` | states/law-citation |

**셸·파운데이션·온보딩·정직성**: shell/workspace(히어로)·topbar·app-states · foundations/foundations · assets/icons · states/onboarding · states/honesty-empty.

→ **총 23 카드 + 파운데이션 2(스타일가이드·아이콘).** 등록 도구 20개 전부 + 법령 MCP 커버. `read_file`만 단독 카드 없음(파일 열기 동작에 흡수, 의도적).

## 4. claude.ai/design 동기화

`DesignSync`로 `design/`를 claude.ai/design에 푸시해 시각 리뷰. **현재 세션은 `CLAUDE_CODE_OAUTH_TOKEN` 로그인이라 design 스코프 없음 → 터미널 `/login` 1회 필요**(대화형, 에이전트 대행 불가). 이후: `list_projects`→`finalize_plan`(writes=`design/**`)→`write_files`(localPath). `@dsCard` 주석이 카드 자동 색인.

## 5. 디자인 → Electron 구현 매핑

`packages/gui`(Electron+React+Vite)는 **로직을 새로 만들지 않는다** — `@kodocagent/core`(AgentSession·ApprovalHandler·이벤트)를 import하고 이 디자인 시스템을 렌더만.

- `ds.css` 토큰·아이콘·brand-mark → `renderer/styles.css` 교체(현 코발트+이모지 → 본 정제 토큰+SVG 아이콘).
- 카드 HTML → React 컴포넌트 1:1 이식. 단일 채팅 → 3-pane(좌 `FilePane`/`Timeline`, 중 `DocumentPreview`/`SheetPreview`(탭), 우 `ChatView`+`QuickActions`).
- 승인 카드 → `ApprovalDialog`를 `Proposal.kind`별 분기 렌더로 확장(edit/find-replace/cell-edit/table-structure/sheet-edit/redact-pii/form-fill/form-object/export/restore).
- 미리보기 = 텍스트 diff(결정적) + `renderHtml` before/after(근사), **rhwp 비의존** ([GUI-DESIGN.md §5.1](GUI-DESIGN.md)).
- IPC: 현 `window.kodoc.{chat,approval,config,session,cwd}` + `cwd.listFiles`/`backups`/`export` 등 추가.

단계: GUI-DESIGN.md §8 로드맵(G1 기본 워크스페이스 → G4 고도화).

## 6. 코히런스 규칙

1. 색·간격·라운드·그림자는 `ds.css` 변수만. 카드 `<style>`엔 레이아웃(flex/grid/size)만.
2. **이모지 금지** — 아이콘은 `assets/icons.html`의 inline SVG(`.ico`)만. 빛나는 로고 금지(`.brand-mark`).
3. 문서는 항상 `.paper`(흰색) 위. 크롬은 다크.
4. PII 원문 값은 어디서도 표시하지 않음(타입·마스킹만) — CLI 정직성과 동일.
5. 미지원 기능은 회색(`.is-disabled`)+정직 안내(`.honesty`)+변환 버튼.
6. 외부 CDN/웹폰트/런타임 JS 금지(정적 HTML, inline SVG만). Electron 이식 시 React로.
