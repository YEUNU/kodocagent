# design-sync notes — kodocagent GUI

프로젝트: **kodocagent GUI** (`fcfd7109-602e-4bab-9d46-47a24f9acf54`)
https://claude.ai/design/p/fcfd7109-602e-4bab-9d46-47a24f9acf54

## Shape: off-script hand-authored gallery
- `design/` 는 빌드 가능한 컴포넌트 라이브러리/Storybook 이 아니라 **손수 작성한 정적 HTML 갤러리**다.
  스킬의 converter(package/storybook) 경로는 적용되지 않는다.
- 카드 = `design/**/*.html` (각 파일 첫 줄 `<!-- @dsCard group/name/subtitle/width/height -->` 마커).
- 토큰/스타일 = `design/assets/ds.css`, 아이콘 = `design/assets/icons.html`.
- 진입점 `styles.css` 를 합성 업로드(`@import "./assets/ds.css";`) — 디자인 에이전트의 렌더에 토큰을 공급한다.

## Upload mapping
- 프로젝트 경로 = `design/` 상대경로(접두 제거): `shell/workspace.html`, `assets/ds.css` 등.
  카드의 상대 CSS 링크(`../assets/ds.css`, `./assets/ds.css`, `./ds.css`)가 그대로 해석된다.
- `_ds_sync.json` 미생성(hand-authored — 정식 recipe 계산 불가). 다음 sync 는 전수 재업로드(23 카드, 가벼움).

## Re-sync 방법
- 카드/토큰을 바꾸면 `design/` 갱신 후 같은 mapping 으로 재업로드.
- **인증**: claude.ai 구독 `/login` 또는 `/design-login` 이 되는 **대화형 `claude` 세션**에서 `/design-sync`.
  이 저장소가 흔히 열리는 데스크톱/웹 환경에선 `/design-login` 명령 자체가 없어 동기화 불가([[kodocagent-gui-design-system]]).
