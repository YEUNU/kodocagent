# 변경 이력 (Changelog)

이 프로젝트의 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르며,
버전은 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따릅니다.

배포 단위는 npm 패키지 `@kodocagent/cli` 하나입니다(내부 워크스페이스 패키지는 빌드 시 인라인 번들됨).

## [Unreleased]

발행되지 않은 작업입니다. 안정성·보안 하드닝과 릴리스 위생 위주의 변경입니다.

### Added

- **Anthropic 프롬프트 캐싱**: 안정적인 system 프리픽스를 분리하고 ephemeral 캐시 마커를 부여해, 반복 호출에서 캐시 적중을 노립니다.
- **구조화 로깅**: `KODOC_DEBUG` 환경변수로 디버그 로깅을 켤 수 있습니다.
- **클라우드 동기 폴더 경고**: iCloud/Dropbox 등 동기 폴더의 문서를 편집할 때 동시 동기로 인한 충돌 위험을 사전 경고합니다.
- **GUI 크래시 핸들러**: 렌더러/메인 프로세스의 예기치 못한 예외를 잡아 사용자에게 안내합니다.

### Changed

- **lost-update 윈도우 제거**: 수정안 생성(`propose()`) 시 *읽기 시점*에 파일 mtime을 캡처하도록 정밀화해, 미리보기와 저장 사이의 동시 편집 덮어쓰기 가능성을 줄였습니다.
- **릴리스 안전 위생**: CI에 `pnpm audit --prod` 게이트 추가, Windows 예약 파일명 방어, CLI 최상위 예외 그물(unhandled rejection 등) 보강.

### Fixed / Hardened (엣지케이스 하드닝 Batch 1–8)

문서 읽기·편집 경로의 데이터 손실·보안·견고성 갭을 발굴해 단계적으로 보강했습니다.

- 한국어 레거시 인코딩(CP949/EUC-KR/UTF-16)의 무음 손상 방지.
- 스프레드시트 수식 보존, 병합 슬레이브 셀 경고, 셀 타입 처리.
- 80k 텍스트 절단으로 인한 데이터 소실 가드, 압축 폭탄(zip bomb) OOM 가드, 중복 unzip 방지.
- 한글 정규화(NFC)·서로게이트 페어 처리, PII 정규식 ReDoS 완화.
- 인젝션 경계 강화, MCP 호출 타임아웃, AI SDK 오류 메시지 한국어화, 스테이징 자동 정리, 다중 인스턴스 경고.
- 내보내기 파일명 sanitize, 미리보기 보안(HTML), 동시 전송 가드, 승인 누수 방지, 접근성(a11y) 보강, 설정 파일 방어적 파싱.
- 변환 출력 백업, 백업 파일명 충돌 회피, NULL 바이트·`find == replace`·예약명·하드링크 처리.
- 열린 파일·권한·디스크 부족으로 인한 저장 실패를 정직하게 안내하고 사전 경고(errno → 친절 메시지).
- 동시 편집(mtime) 덮어쓰기 방지 및 파일 크기 가드(100MB).

## [0.7.1]

- API 사용량 표시를 토큰 수만으로 단순화(추정 비용 표시 제거).
- 에이전트 thrash(같은 도구 무의미 반복) 감지 및 `.hwp` 표 셀 편집 한계 정직 안내.

## [0.7.0]

- **kordoc API-우선 마이그레이션**: 편집 엔진을 kordoc의 무손실 프리미티브(scan/splice 등)로 이전하고 export(HTML/PDF) 기능을 신규 추가.
- **에이전트 자가 검증 루프**: 문서 편집 후 결과를 다시 읽어 요청 반영 여부를 스스로 점검(약한 모델에서도 "전부/모두" 요청 누락을 줄임).
- **API 사용량 표시** 및 `/usage` 명령 추가(누적 입력·출력 토큰).

## [0.6.3]

- kordoc parse의 '표입니다' 텍스트 손실 버그 수정(도형 대체텍스트 전역 스트립 정규식 과매칭 교정, 회귀 테스트 추가).
- 양식 채우기를 kordoc `fillHwpx`로 전환(마크다운 정규식 우회 제거).

## [0.6.2]

- 능력·한계 grounding: 미지원 기능을 솔직히 flag하도록 시스템 프롬프트에 능력·한계 섹션 도입(도구 레지스트리에서 자동 도출해 드리프트 방지).
- 의도 충실도 검증 하네스(아티팩트 XML + LLM-judge) 및 검증 코드 버그 수정.

## [0.6.1]

- 에이전트 편집 행동 규칙 강화: 정보 부족·시점 의존 정보는 추측 대신 질문, 설명만 하지 말고 실제 `propose_*` 호출, 일괄 수정 완결성·자가 확인.
- `.hwp` 구조 편집에 친절 가드 추가.

## [0.6.0]

- 한글(`.hwp`) 직접 편집·무손실 편집 지원(kordoc 3.x 마이그레이션, optional ML 포함 풀 설치 채택).

## [0.5.0]

- 개인정보 비식별(`propose_redact_pii`) 추가.
- 구조적 검색(`find_in_document`) 추가.

## [0.4.5]

- 안전·보존 가드(편집 안전 규칙, `scan_pii`, PII 경고) 및 버그 수정.

## [0.4.4]

- `--print`(단발 질의) 읽기 전용화, 찾기/바꾸기 폴백, 능력 소개, 시트 `.xls` → `.xlsx` 처리.

## [0.4.3]

- 되돌리기, 작업 문서 기억, 찾기/바꾸기 diff 미리보기.

## [0.4.2]

- 제안 경고를 커밋 결과에 포함(에이전트 정직 보고).

## [0.4.1]

- 에이전트 구동 불능 버그 긴급 수정, 찾기/바꾸기·표 구조(XML) 편집.

## [0.4.0]

- 표 셀 직접 수정·양식 채우기(v0.3.0 폴리시 포함 묶음 발행).

## [0.3.0]

- CLI 폴리시·UX: 컨텍스트 관리, 사용량 표시, 효율적 읽기, 세션 재개, 진행 표시, 승인 1단계.

## [0.2.0]

- 검증된 코어: BYOK 3사(Anthropic/OpenAI/Google), 법령 MCP 실증, `compare_documents`, OIDC Trusted Publishing.

[Unreleased]: https://github.com/YEUNU/kodocagent/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/YEUNU/kodocagent/releases/tag/v0.7.1
[0.7.0]: https://github.com/YEUNU/kodocagent/releases/tag/v0.7.0
[0.6.3]: https://github.com/YEUNU/kodocagent/releases/tag/v0.6.3
[0.6.2]: https://github.com/YEUNU/kodocagent/releases/tag/v0.6.2
[0.6.1]: https://github.com/YEUNU/kodocagent/releases/tag/v0.6.1
[0.6.0]: https://github.com/YEUNU/kodocagent/releases/tag/v0.6.0
[0.5.0]: https://github.com/YEUNU/kodocagent/releases/tag/v0.5.0
[0.4.5]: https://github.com/YEUNU/kodocagent/releases/tag/v0.4.5
[0.4.4]: https://github.com/YEUNU/kodocagent/releases/tag/v0.4.4
[0.4.3]: https://github.com/YEUNU/kodocagent/releases/tag/v0.4.3
[0.4.2]: https://github.com/YEUNU/kodocagent/releases/tag/v0.4.2
[0.4.1]: https://github.com/YEUNU/kodocagent/releases/tag/v0.4.1
[0.4.0]: https://github.com/YEUNU/kodocagent/releases/tag/v0.4.0
[0.3.0]: https://github.com/YEUNU/kodocagent/releases/tag/v0.3.0
[0.2.0]: https://github.com/YEUNU/kodocagent/releases/tag/v0.2.0
