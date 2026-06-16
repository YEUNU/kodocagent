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

### 표 셀 정확 수정 (병합 보존)

한글 문서의 표는 병합셀(가로/세로 병합)을 흔히 사용하는데, 일반 수정 경로(`propose_edit`)는 마크다운으로 변환했다가 되돌리면서 병합 구조를 잃습니다. `propose_cell_edit`은 `.hwpx` 내부 XML에서 **바꿀 셀의 텍스트만 직접 교체**해 병합·서식·다른 셀·양식 개체를 그대로 보존합니다.

- 셀은 표 번호·행·열(좌표)로 지정하거나, **라벨**("성명" 옆/아래 칸처럼)로 지정할 수 있습니다. `expectedText`(현재 셀 값)로 안전하게 검증합니다.
- **빈 칸 채우기**를 지원해 양식 문서의 비어 있는 셀에도 값을 넣을 수 있습니다.
- 한 번에 여러 셀을 수정할 수 있고, 하나라도 실패하면 파일을 전혀 건드리지 않습니다(원자적).
- `.hwpx` 전용입니다(`.hwp`는 한글에서 `.hwpx`로 저장 후 사용).

### 양식 개체 채우기 (입력상자·누름틀·콤보박스·체크/라디오)

HWPX 양식 개체(Form Object)를 조회하고 값을 설정합니다. 한글에서 삽입한 **편집 상자·명령 단추·콤보 상자·선택 상자·라디오 단추** 5종을 지원합니다.

- "이 양식에 어떤 입력칸이 있어?"라고 물으면 양식 개체 목록(이름·종류·현재 값)을 보여주고, "성명 칸에 홍길동 입력해줘"처럼 값을 채웁니다.
- 종류별로 편집 상자 텍스트, 체크/라디오 on·off, 콤보 선택값, 단추 캡션을 설정합니다(콤보는 실제 항목만 허용).
- `.hwpx` 전용이며, 변경은 diff 미리보기 + 승인 후 저장됩니다.

> 알려진 제약: 표 안에 **중첩된 표**의 셀은 좌표/라벨로 지정할 수 없습니다(문서 파서가 중첩 표를 구조로 노출하지 않음).

### 문서 전체 찾기/바꾸기

문서 전체(본문·표·머리말 등)에서 텍스트를 찾아 바꿉니다("이 문서의 'OOO'를 전부 '주식회사 가나다'로 바꿔줘"). 한글 렌더링 엔진(rhwp)을 사용하며, 바꾼 결과는 **항상 `.hwpx`로 저장**됩니다.

- `.hwp` 입력도 처리하지만 결과는 `.hwpx`로 저장됩니다(원본은 백업).
- 치환 후 **자동 검증**으로 실제 반영 여부를 확인하며, 일부만 바뀌는 경우(스타일 제목 등 특수 객체)에는 저장하지 않고 알려줍니다.

### 표 행·열 편집 (구조 수정)

표에 **행·열을 추가/삭제하거나 셀을 병합**합니다("이 표 맨 아래에 행 하나 추가해줘", "1행의 1~2번째 칸 합쳐줘"). 어떤 표인지는 그 표 안의 **고유한 텍스트(anchor)**로 지정합니다(먼저 문서를 읽어 표 내용을 확인). 결과는 항상 `.hwpx`로 저장되며, 변경 후 자동 검증으로 의도한 행·열 수가 맞는지 확인합니다.

### 큰 문서 효율적으로 읽기

큰 문서를 통째로 읽는 대신 필요한 부분만 가져옵니다.

- **구조 먼저(outline)**: 헤딩만 추출해 문서 개요를 파악 — "이 보고서 목차만 보여줘"
- **검색(search)**: 키워드가 포함된 부분과 앞뒤 맥락만 반환 — "이 계약서에서 '위약금' 부분만 찾아줘"
- **페이지 범위(pages)**: 특정 페이지/섹션만 읽기

### 컨텍스트 관리

긴 대화에서 컨텍스트가 무한정 커지지 않도록, 토큰 예산(`max-context-tokens`, 기본 120k)을 넘으면 **오래된 문서 읽기 결과를 자동으로 축약**합니다(최근 대화·승인 짝은 보존). 매 응답 끝과 `/context` 명령으로 **현재 사용량**(사용 토큰 / 예산 / %)을 확인할 수 있습니다.

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
| `kodocagent --resume [id]` | 세션 재개 (ID 생략 시 목록에서 선택) |
| `kodocagent sessions` | 세션 목록 표시 (첫 메시지 미리보기 포함) |
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
| `/context` | 현재 컨텍스트 사용량 표시 (사용 토큰 / 예산 / %) |
| `/clear` | 새 세션 시작 |
| `/help` | 도움말 |
| `/exit` | 종료 |

### config 설정 키

| 키 | 설명 | 예시 |
|----|------|------|
| `provider` | 활성 프로바이더 | `anthropic` \| `openai` \| `google` |
| `model` | 활성 모델 | `claude-sonnet-4-6` |
| `api-key.anthropic` | Anthropic API 키 | `sk-ant-...` |
| `api-key.openai` | OpenAI API 키 | `sk-...` |
| `api-key.google` | Google API 키 | `AI...` |
| `law-key` | LAW_OC 법령 API 키 | |
| `max-steps` | 턴당 최대 툴콜 수 (기본 24) | `24` |
| `max-context-tokens` | 컨텍스트 토큰 예산 (초과 시 오래된 도구 결과 자동 압축, 기본 120000) | `120000` |

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
| Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-5.4` | `OPENAI_API_KEY` |
| Google | `gemini-3.5-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` |

환경변수가 `config.json`보다 우선합니다. BYOK(Bring Your Own Key) 방식으로 API 키를 직접 관리합니다.

---

## 라이선스

MIT
