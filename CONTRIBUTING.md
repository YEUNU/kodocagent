# 기여 가이드 (Contributing)

kodocagent에 기여해 주셔서 감사합니다. 이 문서는 개발 환경 설정과 PR 절차를 안내합니다.

> 보안 취약점은 이슈/PR로 올리지 말고 [SECURITY.md](SECURITY.md)의 비공개 신고 경로를 사용해 주세요.

## 요구 사항

- Node.js 20 이상 (개발 도구인 pnpm은 Node 22.13 이상 권장)
- [pnpm](https://pnpm.io) (`packageManager` 필드에 고정된 버전)

이 저장소는 pnpm 워크스페이스 모노레포입니다. 빌드 시 내부 패키지(`shared`/`core`/`doc-tools`)는
`@kodocagent/cli` 단일 패키지로 인라인 번들됩니다.

## 개발 환경 설정

```bash
# 의존성 설치
pnpm install

# 전체 빌드 (4개 패키지)
pnpm -r build

# 단위 테스트
pnpm exec vitest run

# 린트 (Biome)
pnpm exec biome check

# 린트 자동 수정 (안전 픽스만)
pnpm exec biome check --write

# 타입 체크
pnpm -r typecheck

# CLI 스모크 테스트
node packages/cli/dist/index.js --version
```

## 기술 스택

- **TypeScript** (ESM, `target`/`module` 최신 — TS 6)
- **vitest** 단위 테스트
- **Biome** 린트·포매팅 (들여쓰기 2칸, 라인 폭 100, 큰따옴표)

> 테스트는 절대 실제 `~/.kodocagent`에 쓰지 않습니다. `vitest.setup.ts`가 `KODOCAGENT_HOME`을
> 임시 디렉터리로 강제하므로, 새 코드도 동일한 경로 체계만 사용하세요.

## PR 절차

1. 이슈를 먼저 열어 변경 방향을 논의하면 좋습니다(특히 큰 변경).
2. 브랜치에서 작업하고, 다음이 모두 green인지 확인하세요:
   - `pnpm -r build`
   - `pnpm exec vitest run`
   - `pnpm exec biome check`
   - `pnpm -r typecheck`
3. 동작 변경에는 테스트를 추가/수정하세요.
4. [PR 템플릿](.github/PULL_REQUEST_TEMPLATE.md)을 채워 PR을 올립니다.

## 커밋 메시지 관례

Conventional Commits 스타일을 권장합니다(본문은 한국어 허용):

```
feat(doc-tools): 표 셀 직접 수정 지원
fix(core): 세션 재개 시 빈 메시지 크래시 수정
docs: README 프라이버시 고지 추가
```

타입 예: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`.
스코프는 패키지명(`shared`/`core`/`doc-tools`/`cli`/`gui`) 또는 영역명을 사용합니다.

## 사용자 노출 메시지

CLI/GUI에서 사용자에게 보이는 메시지는 **한국어**로, **원인 + 해결 방법**을 함께 안내합니다.

## 관련 문서

- [기술 명세 (docs/SPEC.md)](docs/SPEC.md)
- [개발 전략 (docs/DEVELOPMENT.md)](docs/DEVELOPMENT.md)
