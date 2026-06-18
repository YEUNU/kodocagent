# @kodocagent/gui

## 0.3.0

### Minor Changes

- G2 시각 승인: 승인 다이얼로그를 `Proposal.kind`별 렌더로 확장(코어 무변경 — 기존 `proposal.diff` 문자열만 파싱, CLI 영향 없음).
  - **표 변경**(cell-edit·form-fill·form-object): 마크다운 표 diff를 실제 HTML 표로 렌더, "이후/새 값" 열 초록 강조.
  - **개인정보**(redact-pii): 정직성 배너 + 유형·건수·마스킹 결과 칩(원문 값 미표시).
  - **텍스트**(edit·find-replace·sheet-edit·table-structure·export·restore): 컬러 유니파이드 diff(+초록/−빨강/@@ 헤더). 포맷 변환·경고 배너 + 안전 문구.
  - dev 전용 `?demoApproval=<kind>` 승인 미리보기(프로덕션 빌드에서 제거). 실 Electron `capturePage`로 kind별 렌더 육안 확인.
- G2 되돌리기 타임라인: 좌측 패널에 백업 히스토리 표시(시각·파일명), 클릭 → 자연어 복원 요청(restore_backup 승인 플로우 재사용). 새 IPC `backups.list`, agent-bridge `listBackups()`(`~/.kodocagent/backups` 파싱, 최신 20).

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
