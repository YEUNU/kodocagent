# GUI 패키징·서명·배포 (RELEASE-GUI)

`@kodocagent/gui`(Electron 데스크톱 앱)를 빌드·서명·배포하는 절차다.
패키징은 [electron-builder](https://www.electron.build/), 자동 업데이트는
[electron-updater](https://www.electron.build/auto-update)를 사용하며, 배포 대상은
**GitHub Releases**(`YEUNU/kodocagent`)다.

> 프라이버시 원칙: 자동 업데이트 확인은 **패키징된 앱(`app.isPackaged`)에서만**, GitHub
> Releases를 대상으로만 수행한다. 텔레메트리/크래시 외부 전송은 추가하지 않는다.
> dev/test(`app.isPackaged === false`)에서는 업데이트 점검이 비활성이다.

## 0. 사전 준비

```bash
pnpm install
```

빌드 산출물은 `packages/gui/out/`(electron-vite 번들), 패키징 산출물은
`packages/gui/dist/`(.dmg/.exe/AppImage)에 생성되며 둘 다 git에서 무시된다.

## 1. 미서명 로컬 빌드 (인증서 불필요)

코드사이닝 인증서 없이도 로컬에서 미서명 빌드를 만들 수 있다(개발/내부 테스트용):

```bash
# 현재 OS용 미서명 패키지를 dist/ 에 생성 (압축 안 함, 디렉터리만)
pnpm --filter @kodocagent/gui pack
```

- macOS: 미서명 `.app`은 Gatekeeper가 차단하므로 "우클릭 → 열기" 또는
  `xattr -dr com.apple.quarantine <app>` 로 실행한다.
- Windows: SmartScreen 경고가 뜰 수 있다("추가 정보 → 실행").

## 2. 서명·공증 배포 (인증서 필요)

```bash
# 빌드 + 서명/공증 + GitHub Release(draft/tag) 업로드
pnpm --filter @kodocagent/gui publish:gui
# 또는 업로드 없이 서명 산출물만:
pnpm --filter @kodocagent/gui dist
```

서명/공증은 **사용자 본인의 인증서**가 필요하다(이 저장소에 비밀값은 포함되지 않음).
아래 환경변수를 셸/CI 시크릿으로 주입한다.

### macOS (Apple Developer ID)

| env | 설명 |
| --- | --- |
| `CSC_LINK` | Developer ID Application 인증서(.p12)의 경로 또는 base64 |
| `CSC_KEY_PASSWORD` | .p12 비밀번호 |
| `APPLE_ID` | 공증용 Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID 앱 암호(앱 전용 비밀번호) |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

`electron-builder.yml`의 `mac.hardenedRuntime` / `mac.notarize` /
`mac.entitlements`(→ `assets/entitlements.mac.plist`) 키는 기본 **주석 처리**되어 있다.
인증서가 준비되면 주석을 해제한다. entitlements 스캐폴드는 V8 JIT 등 Electron 최소 권한만
부여하며, 네트워크 서버·카메라·마이크 등 민감 권한은 부여하지 않는다.

### Windows (코드사이닝)

| env | 설명 |
| --- | --- |
| `WIN_CSC_LINK` | 코드사이닝 인증서(.pfx)의 경로 또는 base64 |
| `WIN_CSC_KEY_PASSWORD` | .pfx 비밀번호 |

### GitHub Releases 업로드

| env | 설명 |
| --- | --- |
| `GH_TOKEN` | `repo` 권한 토큰(Release 생성·자산 업로드) |

`publish:gui`는 `-p onTagOrDraft`로 동작하므로, 태그 빌드 또는 draft Release가 있을 때만
업로드한다.

## 3. 자동 업데이트 동작

`packages/gui/src/main/index.ts`의 `maybeCheckForUpdates()`가 앱 준비 직후 호출되며:

- `app.isPackaged`가 아니면(=dev/test) 아무 동작도 하지 않는다.
- 패키징된 앱에서는 `autoUpdater.checkForUpdatesAndNotify()`로 GitHub Releases를 확인하고,
  새 버전이 있으면 OS 알림으로 사용자에게 알린다(다운로드/설치는 기본 notify 흐름).
- 점검 실패는 `logger.warn`으로 삼키며 절대 앱을 크래시시키지 않는다.

자동 업데이트가 실제로 동작하려면 **서명된** 빌드를 GitHub Releases에 올려야 한다
(미서명 빌드는 플랫폼이 업데이트 설치를 거부할 수 있음).

## 4. 주의 (이 작업 범위)

- 이 저장소에는 `electron-builder.yml`·스크립트·entitlements 스캐폴드만 추가되어 있고,
  **실제 패키징(`dist`/`pack`)은 플랫폼·인증서·네트워크가 필요해 CI/로컬에서 별도 실행**한다.
- `electron-updater`는 런타임(메인 프로세스)에서 import되므로 `dependencies`에 있다
  (electron-builder가 asar에 포함시켜야 함). `electron-builder`는 `devDependencies`.
