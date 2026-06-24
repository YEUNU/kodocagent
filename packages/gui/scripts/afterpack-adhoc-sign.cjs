// electron-builder afterPack 훅 — 미서명 macOS 빌드를 ad-hoc 로 "깊게" 재서명한다.
//
// 문제: 인증서 없이 빌드하면(package-app.mjs 가 CSC_IDENTITY_AUTO_DISCOVERY=false 설정)
// electron-builder 가 코드서명을 **통째로 건너뛴다**. 그러면 실행파일엔 링커가 넣은 ad-hoc
// Mach-O 서명만 남고 번들은 `_CodeSignature/CodeResources` 로 **봉인되지 않는다**(Sealed
// Resources=none). 이 내부 불일치 상태를 macOS Gatekeeper 는 "‘앱’이 손상되어 열 수 없음"
// 이라는 **우회 불가** 판정으로 처리한다(우클릭→열기도 안 먹힘). gui-v0.5.0/0.5.1 의 실제 증상.
//
// 해결: 번들 전체를 ad-hoc(`--sign -`)로 **깊게** 재서명해 CodeResources 봉인을 만든다.
// 그러면 판정이 "확인되지 않은 개발자"(우클릭→열기 가능)로 내려가고, 사용자가 quarantine 만
// 제거하면(`xattr -dr com.apple.quarantine ...`) 정상 실행된다. 정식 배포는 여전히
// Developer ID 서명+공증이 필요하지만, 미서명 빌드의 "손상" 오판은 이걸로 사라진다.
//
// 실 인증서가 주입된 경우(CSC_LINK 등)엔 electron-builder 의 정식 서명에 맡기고 건드리지 않는다.

const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  // macOS 빌드에만 적용 (win/linux 는 무관).
  if (context.electronPlatformName !== "darwin") return;
  // 정식 서명 인증서가 있으면 electron-builder 가 제대로 서명하므로 덮어쓰지 않는다.
  if (process.env.CSC_LINK || process.env.CSC_IDENTITY_AUTO_DISCOVERY === "true") return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${productFilename}.app`;
  // eslint-disable-next-line no-console
  console.log(`[afterPack] 미서명 빌드 — ad-hoc 깊은 재서명으로 번들 봉인: ${appPath}`);
  // --deep: 중첩된 프레임워크/헬퍼까지, --sign -: ad-hoc(인증서 불필요).
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
