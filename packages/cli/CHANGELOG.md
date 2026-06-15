# kodocagent

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
