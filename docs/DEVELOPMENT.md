# 개발 / 배포 전략

> 2026-06-10 확정. 장기간 AI 협업 개발에서 결과물 일관성을 보장하기 위한 운영 규칙.

## 1. 역할 분리 — 구현자 / 검증자

| 역할 | 담당 | 책임 |
|---|---|---|
| **오케스트레이터/검증자** | Claude Fable 5 (또는 유지보수자) | 마일스톤 범위 정의, 구현 결과 검증, 코드 리뷰, git 커밋/푸시, 릴리스 |
| **구현자** | Claude Sonnet 4.6 서브에이전트 (마일스톤당 1개) | SPEC 기반 구현 + 단위 테스트 작성, 자체 빌드/테스트 통과 후 결과 보고 |

구현과 검증을 분리하는 이유: 장기간 여러 세션/에이전트에 걸친 작업에서 스펙 드리프트(drift)를 막는 것은 "구현자의 기억"이 아니라 **문서와 게이트**다.

## 2. 일관성 보장 장치

1. **단일 소스 오브 트루스**: [SPEC.md](SPEC.md)가 유일한 설계 기준. 구현 중 SPEC과 충돌하는 발견(API 변경 등)이 있으면 코드를 우회하지 말고 **SPEC을 먼저 수정**하고 그 커밋에 포함한다.
2. **마일스톤 게이트**: 각 마일스톤은 SPEC §12 수용 기준을 통과해야만 커밋된다. 부분 구현은 커밋하지 않는다.
3. **검증 체크리스트** (커밋 전 필수, 검증자가 직접 실행):
   ```
   pnpm install          # lockfile 정합성
   pnpm build            # 4패키지 빌드
   pnpm -r typecheck     # 타입 무결성
   pnpm test             # 단위 테스트
   pnpm lint             # Biome
   node packages/cli/dist/index.js --version   # 스모크
   + 마일스톤별 수용 기준 (SPEC §12)
   + 핵심 파일 코드 리뷰 (승인 게이트·경로 검증·키 저장 등 보안 경로는 라인 단위)
   ```
4. **불변 원칙** (모든 구현자 프롬프트에 포함):
   - core는 터미널 import / `console` 출력 금지 (UI 비종속)
   - `requiresApproval` 툴은 ApprovalHandler 승인 없이 파일을 쓰는 코드 경로가 없어야 함
   - LLM 요청에 샘플링 파라미터(temperature 등) 설정 금지
   - 사용자 노출 메시지는 한국어 (원인 + 해결 방법)
   - 외부 라이브러리 API는 추측 금지 — `node_modules`의 `.d.ts`를 직접 확인
   - 경로는 NFC 정규화 + cwd 이하 검증
   - **테스트는 실제 `~/.kodocagent`에 절대 쓰지 않는다** — `vitest.setup.ts`가 `KODOCAGENT_HOME`을 임시 디렉터리로 강제하며, 새 코드도 이 경로 체계(`KODOC_PATHS`)만 사용할 것

## 3. Git 전략

- **v1 개발 중**: `main` 직접 커밋, 단위는 **마일스톤(또는 그 명확한 하위 단계)**. 모든 게이트 통과 시에만.
- **첫 npm 배포(v0.1.0) 이후**: feature 브랜치 + PR + CI 통과 후 머지.
- 커밋 메시지: `M<n>: <한 줄 요약>` + 본문에 산출물·검증 결과. 푸시는 커밋 직후 (원격 = 백업).
- 태그: npm 배포 버전과 동일한 `v*` 태그는 changesets/CI가 생성.

## 4. 의존성 정책 — 최신 유지

- 모든 의존성은 **caret(^) 범위 + 최신 안정판**으로 선언. 보안/버그 픽스를 자동 수용.
- **Dependabot 주간 업데이트** ([.github/dependabot.yml](../.github/dependabot.yml)): npm + GitHub Actions. CI 통과 시 머지.
- **pnpm 공급망 보호**: `minimumReleaseAge`(pnpm 11 기본)로 갓 배포된 패키지의 즉시 설치를 지연 — 탈취 패키지 방어. 신뢰 패키지는 `pnpm-workspace.yaml`의 `minimumReleaseAgeExclude`에 명시.
- 마일스톤 시작 시 `pnpm up -r --latest` 후 게이트 재검증 (메이저 업은 변경로그 확인 후).
- `pnpm audit`를 CI lint 잡에 포함.

## 5. 릴리스(배포) 파이프라인

```
개발 머신                                  GitHub                       npm
─────────                                 ──────                       ───
pnpm changeset version (버전 산출) ──▶ main 푸시
                                       └▶ release.yml
                                          └─ 로컬 버전 ≠ 발행 버전이면 ──▶ kodocagent publish + 태그
사용자: npx kodocagent@latest ◀── OTA 업데이트 체크(24h)가 새 버전 감지 ──┘
```

저장소의 Actions PR 생성 권한이 비활성화되어 있어 changesets/action(Version PR 자동 생성) 대신 **로컬에서 `pnpm changeset version`을 실행해 버전을 산출·커밋**하고, 워크플로는 토큰 인증으로 직접 발행한다(멱등 — 이미 발행된 버전이면 건너뜀). PR 권한이 켜지면 changesets/action 방식으로 되돌릴 수 있다.

- 워크플로: [.github/workflows/release.yml](../.github/workflows/release.yml)
- **필요 시크릿**: 저장소 Settings → Secrets에 `NPM_TOKEN` — npm **자동화(classic automation) 토큰** 권장. Granular 토큰이라면 신규 unscoped 패키지 발행 권한(전체 패키지 쓰기)이 있어야 함
- **배포 패키지**: `kodocagent` 단일 패키지만 publish. `@kodocagent/core`, `@kodocagent/doc-tools`, `@kodocagent/shared`는 `"private": true`로 표시된 워크스페이스 전용 패키지 — changesets가 자동으로 publish 대상에서 제외하며, 빌드 시 CLI에 번들링됨.
- **npm 조직 불필요**: 스코프 패키지를 배포하지 않으므로 `@kodocagent` npm 조직을 생성할 필요가 없다.
- 버전 정책: 0.x 동안 minor=기능, patch=수정. 내부 패키지는 버전 관리 불필요(워크스페이스 전용).
- npm 첫 배포 전 확인: `kodocagent` 이름 미점유 (2026-06-10 확인 완료)

## 6. 마일스톤 운영 절차 (반복)

```
1. (검증자) 의존성 최신화: pnpm up -r --latest → 게이트 재검증
2. (검증자) 서브에이전트에 위임: SPEC 해당 절 + 불변 원칙 + 수용 기준을 프롬프트에 명시
3. (구현자) 구현 + 단위 테스트 + 자체 게이트 실행 → 결과/일탈 사항 보고
4. (검증자) 전체 게이트 + 코드 리뷰 + 수용 기준 검증. 미달 시 수정 지시(컨텍스트 유지된 같은 에이전트에 후속 지시)
5. (검증자) SPEC 일탈이 있었으면 SPEC 갱신 → changeset 작성 → 커밋 → 푸시
```
