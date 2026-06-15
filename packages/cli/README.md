# kodocagent

**한국어 특화 문서 AI 에이전트** — HWP/HWPX/DOCX/XLSX 문서를 읽고 수정하며, 한국 법령을 확인해 문서를 검토·추천하는 터미널 에이전트.

## 설치

```bash
# npm 글로벌 설치
npm install -g kodocagent

# pnpm 글로벌 설치
pnpm add -g kodocagent

# npx로 바로 실행
npx kodocagent@latest
```

**요구 사항**: Node.js 20 이상

## 빠른 시작

```bash
# 최초 실행 — 온보딩 (프로바이더·API 키 설정)
kodocagent

# 단발 질의
kodocagent -p "이 계약서에서 위약금 조항을 찾아줘"

# 세션 재개
kodocagent --continue
```

## CLI 명령

| 명령 | 설명 |
|------|------|
| `kodocagent` | 채팅 시작 (최초 실행 시 온보딩) |
| `kodocagent -p "<질문>"` | 단발 질의 (쓰기 툴 비활성) |
| `kodocagent --continue` | 가장 최근 세션 재개 |
| `kodocagent --resume <id>` | 지정한 세션 ID 재개 |
| `kodocagent sessions` | 세션 목록 |
| `kodocagent config set <key> <value>` | 설정값 저장 |
| `kodocagent config show` | 현재 설정 표시 |
| `kodocagent mcp list` | MCP 서버 상태 목록 |
| `kodocagent mcp test <server>` | MCP 서버 연결 테스트 |
| `kodocagent clean` | 스테이징 전체 + 30일 경과 백업 정리 (`--all`로 백업 전체) |
| `kodocagent update` | 최신 버전으로 업데이트 |
| `kodocagent --version` | 버전 출력 |

## 개발자 참고

이 패키지는 모노레포의 `packages/cli`에 위치하며, 빌드 시 내부 워크스페이스 패키지(`@kodocagent/core`, `@kodocagent/doc-tools`, `@kodocagent/shared`)를 번들링해 단일 자급자족 npm 패키지로 배포됩니다. 내부 패키지는 `"private": true`로 npm에 배포되지 않습니다.

## 자세한 문서

전체 문서, 기능 설명, 개발자 섹션은 [GitHub 저장소](https://github.com/YEUNU/kodocagent)를 참고하세요.

## 라이선스

MIT
