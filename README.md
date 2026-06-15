# kodocagent

**한국어 특화 문서 AI 에이전트** — HWP/HWPX/DOCX/XLSX 문서를 읽고 수정하며, 한국 법령을 확인해 문서를 검토·추천하는 터미널 에이전트.

---

## 설치

```bash
# npm 글로벌 설치 (권장)
npm install -g @kodocagent/cli

# pnpm 글로벌 설치
pnpm add -g @kodocagent/cli

# npx로 바로 실행 (설치 불필요)
npx @kodocagent/cli@latest
```

설치 후 실행 명령은 `kodocagent` 입니다.

**요구 사항**: Node.js 20 이상

---

## 빠른 시작

### 1. 최초 실행 — 온보딩

```
kodocagent
```

최초 실행 시 온보딩이 시작됩니다:

1. 프로바이더 선택 (Anthropic / OpenAI / Google)
2. API 키 입력 (마스킹 처리, `~/.kodocagent/config.json` 0600 저장)
3. 법령 기능 사용 안내 (LAW_OC 키 선택 입력 또는 나중에)

### 2. 채팅 예시

```
You: 이 취업규칙의 연차 조항이 근로기준법에 맞는지 검토해줘
Assistant: read_document(취업규칙.hwpx) 실행 중...
          mcp__korean-law__search_law 실행 중...
          제60조 연차 유급휴가 조항과 비교하면...
```

```
You: 3페이지 날짜를 2026년 1월 1일로 수정해줘
Assistant: propose_edit(취업규칙.hwpx) — diff 미리보기 표시
          [승인 / 거절 / 거절+사유] 선택
```

---

## 주요 기능

### 문서 읽기·쓰기 포맷 매트릭스

| 포맷 | 읽기 | 쓰기/수정 | 비고 |
|------|------|-----------|------|
| `.hwpx` | ✅ | ✅ | 원본 서식 보존 |
| `.hwp` | ✅ | ✅ | 편집 결과는 `.hwpx`로 저장, 원본 보존 |
| `.docx` | ✅ | ✅ | 서식 재생성 (손실 가능성 diff에 명시) |
| `.xlsx` | ✅ | ✅ | 셀 단위 수정, 서식 보존 |
| `.pdf` | ✅ | ❌ | 텍스트 추출만 (스캔 PDF 불가) |
| `.md` / `.txt` | ✅ | ✅ | 텍스트 직접 처리 |

### 문서 비교 (신구대조)

두 문서의 변경점을 블록 단위로 비교합니다. 채팅에서 "이 두 계약서 뭐가 바뀌었는지 비교해줘"처럼 요청하면 `compare_documents`가 추가·삭제·수정 블록과 통계를 표로 정리해줍니다. HWP↔HWPX 등 서로 다른 포맷 간 비교도 가능합니다.

### 미리보기 + 승인 흐름

에이전트는 **절대 바로 저장하지 않습니다**. 모든 쓰기 작업은 다음 순서로 진행됩니다:

```
수정안 생성 → 스테이징 저장 → diff 미리보기 표시 → 사용자 승인
→ 원본 자동 백업(~/.kodocagent/backups/) → 원자적 저장
```

거절 시 스테이징 파일만 남고 원본은 변경되지 않습니다.

### 법령 연동 (LAW_OC 키 필요)

국가법령정보센터 Open API를 통해 현행 법령을 조회합니다.

**LAW_OC 키 발급**: [open.law.go.kr](https://open.law.go.kr) → 오픈API 신청 (무료)

```bash
# 키 등록
kodocagent config set law-key <발급받은_LAW_OC_키>
```

법령 인용은 「법령명」 제N조 제N항 형식으로 출력됩니다.

### MCP 확장 (mcp.json)

`~/.kodocagent/mcp.json` 또는 프로젝트 루트 `.kodocagent/mcp.json`에 MCP 서버를 추가할 수 있습니다.

```jsonc
{
  "mcpServers": {
    "korean-law": {
      "command": "npx",
      "args": ["-y", "korean-law-mcp@latest"],
      "env": { "LAW_OC": "${LAW_OC}" },
      "disabled": false,
      "allowedTools": null
    },
    "my-server": {
      "url": "https://my-mcp-server.example.com",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    }
  }
}
```

- `korean-law` 서버는 기본 번들로 자동 포함됩니다.
- `LAW_OC` 미설정 시 korean-law 서버만 스킵됩니다.
- 툴 네임스페이스: `mcp__<서버명>__<툴명>`
- [awesome-mcp-korea](https://github.com/darjeeling/awesome-mcp-korea)의 한국 서비스 MCP 서버를 플러그인처럼 연결할 수 있습니다.

---

## CLI 명령

| 명령 | 설명 |
|------|------|
| `kodocagent` | 채팅 시작 (최초 실행 시 온보딩) |
| `kodocagent -p "<질문>"` | 단발 질의 (쓰기 툴 비활성, 비대화형) |
| `kodocagent --continue` | 가장 최근 세션 재개 |
| `kodocagent --resume <id>` | 지정한 세션 ID 재개 |
| `kodocagent sessions` | 세션 목록 표시 |
| `kodocagent config set <key> <value>` | 설정값 저장 |
| `kodocagent config show` | 현재 설정 표시 (API 키 마스킹) |
| `kodocagent mcp list` | MCP 서버 상태 목록 |
| `kodocagent mcp test <server>` | 특정 MCP 서버 연결 테스트 + 툴 목록 |
| `kodocagent clean` | 스테이징 전체 + 30일 경과 백업 정리 (`--all`로 백업 전체 삭제) |
| `kodocagent update` | 최신 버전으로 업데이트 |
| `kodocagent --version` | 버전 출력 |

### 채팅 내 슬래시 명령

| 명령 | 설명 |
|------|------|
| `/model` | 프로바이더/모델 전환 (키 있는 프로바이더만 표시, 직접 입력도 가능) |
| `/clear` | 새 세션 시작 |
| `/help` | 도움말 |
| `/exit` | 종료 |

### config 설정 키

| 키 | 설명 | 예시 |
|----|------|------|
| `provider` | 활성 프로바이더 | `anthropic` \| `openai` \| `google` |
| `model` | 활성 모델 | `claude-opus-4-8` |
| `api-key.anthropic` | Anthropic API 키 | `sk-ant-...` |
| `api-key.openai` | OpenAI API 키 | `sk-...` |
| `api-key.google` | Google API 키 | `AI...` |
| `law-key` | LAW_OC 법령 API 키 | |
| `max-steps` | 턴당 최대 툴콜 수 (기본 24) | `24` |

---

## 설정 파일 경로

| 파일 | 설명 |
|------|------|
| `~/.kodocagent/config.json` | 프로바이더·API 키·모델 설정 (0600) |
| `~/.kodocagent/mcp.json` | 전역 MCP 서버 설정 |
| `./.kodocagent/mcp.json` | 프로젝트별 MCP 서버 설정 (전역 설정을 서버명 단위로 덮어씀) |
| `~/.kodocagent/sessions/` | 세션 이력 (JSONL) |
| `~/.kodocagent/backups/` | 자동 백업 (승인 시) |
| `~/.kodocagent/staging/` | 미승인 수정 스테이징 |
| `~/.kodocagent/update-check.json` | OTA 업데이트 캐시 (24h) |

---

## Windows 사용자

터미널 인코딩을 UTF-8로 설정하세요:

```cmd
chcp 65001
```

또는 Windows Terminal을 사용하세요 (기본 UTF-8).

---

## 개발자 섹션

### 모노레포 구조

```
packages/
├── shared/      # 공용 타입, zod 스키마, 에러  [워크스페이스 전용, npm 배포 안 함]
├── core/        # 에이전트 루프, BYOK 프로바이더, 툴 레지스트리, MCP 클라이언트, 세션  [워크스페이스 전용]
├── doc-tools/   # kordoc/docx/exceljs 래퍼, 스테이징/백업/diff  [워크스페이스 전용]
└── cli/         # kodocagent CLI — 빌드 시 위 3개 패키지를 번들링해 단일 npm 패키지로 배포
```

내부 패키지(`shared`, `core`, `doc-tools`)는 `"private": true`로 npm에 배포되지 않으며, CLI 빌드 시 `@kodocagent/cli` 패키지에 인라인됩니다. 사용자는 `npm i -g @kodocagent/cli` 하나만 설치하면 되고, 실행 명령은 `kodocagent` 입니다.

### 개발 환경 설정

```bash
# 의존성 설치
pnpm install

# 전체 빌드
pnpm build

# 테스트
pnpm test

# 린트
pnpm lint

# 타입 체크
pnpm -r typecheck
```

### 관련 문서

- [기술 명세 (SPEC.md)](docs/SPEC.md)
- [개발 전략 (DEVELOPMENT.md)](docs/DEVELOPMENT.md)

---

## 지원 모델

| 프로바이더 | 기본 모델 | 환경변수 |
|-----------|-----------|---------|
| Anthropic | `claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-5.5` | `OPENAI_API_KEY` |
| Google | `gemini-3.5-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` |

환경변수가 `config.json`보다 우선합니다. BYOK(Bring Your Own Key) 방식으로 API 키를 직접 관리합니다.

---

## 라이선스

MIT
