# @kodocagent/gui

## 0.5.0

### Minor Changes

- **라이트 모던 워크스페이스 전면 재디자인**: 다크 크롬 → 화이트 패널 + 연그레이 캔버스. 토큰(ds.css) 스왑으로 앱·디자인 갤러리 일괄 전환. 스틸블루 액센트·"k" 아이콘·de-AI 원칙(SVG 아이콘, 이모지 0) 유지.
- **dmg/exe/AppImage 패키징 동작화**: 메인 프로세스를 전부 외부화하고 `pnpm deploy`로 완전한 평탄 node_modules를 만들어 패키징(+네이티브 .node 보강). 기존 스캐폴드는 빌드돼도 실행 시 `Cannot find module`로 크래시했음. 앱 아이콘 추가, 3-OS 미서명 빌드 워크플로(`gui-v*` 태그) 신설. 실 패키징 앱 크래시 0 검증.
- **모델 비교 화면**: 키가 2개 이상이면 입력창에 "모델 비교" 버튼 노출 → 같은 질문(+활성 문서)을 키 있는 여러 프로바이더에 읽기전용 병렬 전송해 결과를 모달로 비교(원본 무변경).
- **프로바이더 BYOK**: Claude·OpenAI·Gemini 중 최소 하나면 동작, 있는 프로바이더 자동 선택. 온보딩이 "셋 중 하나"로 바뀜(필수 강제 제거).

## 0.4.0

### Minor Changes

- G3 온보딩 마법사: 첫 실행 시 "CLI에서 설정하세요" 안내 대신 **앱에서 직접 API 키 입력·저장**.
  - 제공자 선택(Claude/OpenAI/Gemini) + 제공자별 키 입력(password·보기 토글) + 선택 국가법령 OC 키. 키는 **사용자가 직접 입력**하며 `~/.kodocagent/config.json` 에만 저장(미리 채우지 않음).
  - 새 IPC `config.save` → agent-bridge `saveSetup()`(core `saveConfig` 재사용) → 저장 후 재초기화 + 갱신 스냅샷 반환. **키 값은 렌더러로 되돌리지 않음**(스냅샷은 boolean만).
  - 격리 home + 가짜 키로 저장 백엔드 end-to-end 검증, 실 Electron `capturePage`로 마법사 렌더 확인.

## 0.3.0

### Minor Changes

- G2 시각 승인: 승인 다이얼로그를 `Proposal.kind`별 렌더로 확장(코어 무변경 — 기존 `proposal.diff` 문자열만 파싱, CLI 영향 없음).
  - **표 변경**(cell-edit·form-fill·form-object): 마크다운 표 diff를 실제 HTML 표로 렌더, "이후/새 값" 열 초록 강조.
  - **개인정보**(redact-pii): 정직성 배너 + 유형·건수·마스킹 결과 칩(원문 값 미표시).
  - **텍스트**(edit·find-replace·sheet-edit·table-structure·export·restore): 컬러 유니파이드 diff(+초록/−빨강/@@ 헤더). 포맷 변환·경고 배너 + 안전 문구.
  - dev 전용 `?demoApproval=<kind>` 승인 미리보기(프로덕션 빌드에서 제거). 실 Electron `capturePage`로 kind별 렌더 육안 확인.
- G2 되돌리기 타임라인: 좌측 패널에 백업 히스토리(시각·**작업 요약**·파일명) 표시, 클릭 → 자연어 복원 요청(restore_backup 승인 플로우 재사용). 새 IPC `backups.list`, agent-bridge `listBackups()`(`~/.kodocagent/backups` 파싱 + 작업 메타 사이드카 읽기, 최신 20). doc-tools `backupFile`이 백업 시 `.<name>.meta.json` 사이드카에 작업 요약을 기록(선행 점이라 기존 `list_backups` 정규식엔 안 걸림 → CLI 무영향). 요약 없는 과거 백업은 "백업 + 파일명"으로 표시.

## 0.2.0

### Minor Changes

- G1 워크스페이스: 단일 채팅 → **3-pane**(파일·되돌리기 / 문서 미리보기 / 대화) 레이아웃.
  - **문서 HTML 미리보기**: 좌측 선택·드래그&드롭 → kordoc `parse`→`renderHtml`을 샌드박스 iframe에 렌더(읽기 전용, 원본 무변경). 편집 승인 후 자동 새로고침.
  - **좌측 파일 패널**: 작업 폴더 문서 목록(포맷 배지)·드롭존. **우측 빠른 작업**: 요약·검토·개인정보 가리기·내보내기. **상단바**: 모델·누적 토큰·컨텍스트 게이지·새 세션.
  - **de-AI 디자인 시스템 이식**: `ds-tokens.css`(design/assets/ds.css 동기화), 스틸블루 팔레트, inline SVG 아이콘(이모지 0). 승인 다이얼로그·대화·입력창 재스타일.
  - IPC 추가: `files.list`·`doc.preview`·`doc.pathForFile`. doc-tools가 `parse`·`renderHtml` 재노출(kordoc-API-first).
  - **런타임 수정(실 Electron 검증서 발견)**: 샌드박스 preload는 ESM 불가 → CommonJS(`index.cjs`)로 빌드하고 main이 이를 로드(이전엔 `.js` 참조로 preload 미로드 → `window.kodoc` 부재). 렌더러 CSP 정리, React `ErrorBoundary` 추가. `webContents.capturePage`로 워크스페이스·문서 미리보기 렌더 육안 확인.

## 0.1.1

### Patch Changes

- Updated dependencies [fc216c5]
  - @kodocagent/core@0.1.0
  - @kodocagent/doc-tools@0.1.0
  - @kodocagent/shared@0.1.0
