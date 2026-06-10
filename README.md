# kodocagent

**한국어 특화 문서 AI 에이전트** — HWP/HWPX/DOCX/XLSX 문서를 읽고 수정하고, 한국 법령을 확인해 문서를 검토·추천하는 터미널 에이전트.

> 현재 설계 단계입니다. 구현 계획은 [docs/PLAN.md](docs/PLAN.md), 기술 명세는 [docs/SPEC.md](docs/SPEC.md), 기반 기술 조사는 [docs/RESEARCH.md](docs/RESEARCH.md)를 참고하세요.

## 핵심 기능 (v1 목표)

| 기능 | 방식 |
|---|---|
| 문서 읽기 | [kordoc](https://github.com/chrisryugj/kordoc) — HWP 3~5/HWPX/HWPML/DOCX/XLSX/PDF → 마크다운 |
| 문서 쓰기/수정 | kordoc(HWPX, 원본 서식 보존) + docx(DOCX) + exceljs(XLSX 셀 단위). `.hwp` 편집 결과는 `.hwpx`로 저장 |
| 에이전틱 하네스 | 자체 경량 루프 (Vercel AI SDK v6 기반, [oh-my-pi](https://github.com/can1357/oh-my-pi) 아키텍처 참고) |
| BYOK AI | OpenAI / Anthropic Claude / Google Gemini — 사용자 본인 API 키, 기본값은 플래그십 모델 |
| 한국 법령 연동 | MCP 클라이언트 + [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) 기본 번들 (국가법령정보센터 Open API, 무료 `LAW_OC` 키) |
| 한국 사이트 확장 | [awesome-mcp-korea](https://github.com/darjeeling/awesome-mcp-korea)의 MCP 서버를 플러그인처럼 연결 |
| OTA 업데이트 | npm 배포 + 자동 업데이트 체크 (무료) |
| 시각 미리보기/편집 | v2(GUI)에서 [rhwp](https://github.com/edwardkim/rhwp) `@rhwp/editor` 임베드 — v1 CLI는 텍스트/구조 diff로 승인 |

## 설계 원칙

- **미리보기 + 승인**: 에이전트는 수정안을 스테이징에만 생성하고, 사용자가 diff를 확인·승인해야만 저장. 저장 전 원본 자동 백업. 코드 레벨에서 강제 (프롬프트 의존 아님)
- **코어/UI 분리**: 에이전트 코어는 UI 비종속 라이브러리. v1은 CLI, v2에서 같은 코어 위에 데스크톱 GUI
- **MCP 생태계**: 한국 사이트 자동화는 개별 구현 대신 MCP 서버 연결로 확장

## 저장소 구조 (예정)

```
packages/
├── shared/      # 공용 타입, zod 스키마
├── core/        # 에이전트 루프, 프로바이더, 툴 레지스트리, MCP 클라이언트, 세션
├── doc-tools/   # kordoc/rhwp 래퍼, 스테이징/백업/diff
└── cli/         # kodocagent CLI (TUI, 승인 프롬프트, 온보딩, 업데이트)
```

## 로드맵

- **M0** 모노레포 스캐폴딩 → **M1** 에이전트 루프 + BYOK 채팅 → **M2** 문서 툴 + 승인 플로우 → **M3** MCP + 법령 연동 → **M4** OTA + 첫 npm 배포 → **M5** GUI (v1 이후)

자세한 마일스톤·검증 기준은 [docs/PLAN.md](docs/PLAN.md) 참고.

## License

MIT
