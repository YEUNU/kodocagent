# kodocagent

## 0.4.1

### Patch Changes (긴급 수정)

- **에이전트 구동 불능 버그 수정(critical)** — 0.4.0의 `propose_cell_edit` 스키마가 `z.undefined()`를 사용해 AI SDK의 JSON Schema 변환이 실패, 채팅 첫 메시지부터 "Undefined cannot be represented in JSON Schema" 오류로 에이전트가 동작하지 않던 문제를 해결(전 주소 필드 optional 단일 스키마 + 핸들러 검증).

### Minor Changes

- 문서 전체 찾기/바꾸기(`propose_find_replace`) — 본문·표·머리말 등 모든 텍스트를 문서 XML 직접 수정으로 치환. 이미지·표·서식 보존, 복잡 문서에서도 안전(`.hwpx` 전용). 서식이 나뉜 텍스트는 일부 누락 시 안내.
- 표 행·열 편집(`propose_table_structure`) — 행·열 추가/삭제·셀 병합을 XML 직접 수정으로. anchor 텍스트로 표 지정, 기존 병합 가로지름은 안전 거부, 이미지·다른 표 보존.

### 내부 변경

- rhwp(`@rhwp/core`) 의존 제거 — 찾기/바꾸기·표 구조를 자체 XML 패치로 구현(rhwp가 복잡 문서를 손상시키는 문제 회피). 사용자 설치 시 WASM(5.6MB) 미포함.
- 실제 공문서(보도자료·지자체 양식)로 AI end-to-end 수정 검증 완료.

## 0.4.0

### Minor Changes

- `propose_cell_edit` 추가 — HWPX 표 셀을 내부 XML에서 직접 수정. 병합셀(cellSpan/rowSpan)·서식·다른 셀·양식 개체를 완전히 보존(기존 `propose_edit`의 마크다운 왕복은 병합 구조를 평면화·소실). 셀은 표 좌표 또는 라벨(인접 방향)로 지정, `expectedText` 안전 검증, 여러 셀 원자적 수정
- 양식 빈 칸 채우기 — 비어 있는 표 셀(`<hp:t/>`)에 값 입력 지원
- 라벨 기반 셀 지정 — "성명" 옆/아래 칸처럼 라벨+방향(right/below)으로 값 셀 지정(병합 span 고려)
- 양식 개체(Form Object) 지원 — `list_form_objects`로 입력상자·누름틀·콤보박스·체크/라디오 단추 5종을 조회하고, `propose_form_object`로 값 설정(편집상자 텍스트, 체크/라디오 on/off, 콤보 선택, 단추 캡션). 타입·콤보 항목·기대값 검증, 원자적 적용

### 참고

- `propose_cell_edit`·양식 개체 툴은 `.hwpx` 전용. `.hwp`는 한글에서 `.hwpx`로 저장 후 사용. 병합셀이 있는 표 수정 시 `propose_edit` 대신 `propose_cell_edit`을 사용.
- 검증: rhwp 실문서(병합 표·양식·양식 개체 5종)로 편집 후 한컴오피스 한글 Viewer에서 정상 렌더·병합 보존·양식 개체 값 반영 확인.
- 알려진 제약: 표 안에 중첩된 표의 셀은 좌표/라벨로 지정 불가(kordoc이 중첩 표를 구조로 노출하지 않아 에이전트가 발견할 수 없음).

## 0.3.0

### Minor Changes

- 대화 컨텍스트 자동 관리 — 토큰 예산(`max-context-tokens`, 기본 120k) 초과 시 오래된 도구 결과를 자동 축약(최근 턴·승인 짝 보존)
- 컨텍스트 사용량 표시 — 매 응답 푸터(`컨텍스트: N/예산 (%)`) + `/context` 명령(70%/90% 경고색)
- `read_document` 효율 읽기 모드 — `outline`(구조만)·`search`(키워드 주변만)으로 큰 문서를 부분 열람
- 세션 재개 UX — `sessions` 첫 메시지 미리보기·최근순, `--resume [id]`(생략 시 목록 선택)
- 채팅 진행 표시 — MCP 연결·툴 실행 스피너 및 소요 시간(비 TTY 환경 가드)

### Patch Changes

- 승인 흐름을 1단계(승인/거절)로 단순화하고, 거절 시 동일 제안 자동 반복 루프 제거
- `read_document` 100MB 파일 크기 가드(OOM/행 방지)
- MCP 툴 수 경고를 채팅·단발 질의에서도 표시
- 비 TTY 환경 스피너 이스케이프 출력 가드, stdio MCP 잔존으로 인한 종료 지연(`/exit`) 수정

## 0.2.0

### Minor Changes

- `compare_documents` 툴 추가 — 두 문서(HWP/HWPX/DOCX/XLSX, 크로스 포맷) 블록 단위 비교
- `read_document`이 `.md`/`.txt` 평문 텍스트를 kordoc 없이 직접 처리
- 기본 모델 변경(비용·속도 균형): Anthropic `claude-sonnet-4-6`, OpenAI `gpt-5.4`
- CI 자동 발행을 npm OIDC Trusted Publishing으로 전환(장기 토큰·2FA 불필요)

### Patch Changes

- 모델 API 오류 시 AI SDK 원시 객체 콘솔 덤프 제거(`onError`)
- MCP stdio 첫 연결 타임아웃 60초 상향 — `npx` 최초 다운로드 실패(법령 서버) 해소 + 안내
- `ANTHROPIC_BASE_URL`에 `/v1` 누락 시 보정 — Claude Code/Desktop 환경 footgun(404) 방지
- 실키 E2E 검증: OpenAI·Google·Anthropic 3사 채팅+툴콜, 법령 MCP(korean-law) 연동

## 0.1.0

### Minor Changes

- fc216c5: v0.1.0 첫 릴리스: 에이전트 루프(BYOK 3사), HWP/HWPX/DOCX/XLSX 읽기·쓰기(미리보기+승인), MCP 클라이언트(korean-law 기본 번들), OTA 업데이트 체크

### Patch Changes

- Updated dependencies [fc216c5]
  - @kodocagent/core@0.1.0
  - @kodocagent/doc-tools@0.1.0
  - @kodocagent/shared@0.1.0
