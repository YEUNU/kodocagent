#!/usr/bin/env node
// kodocagent GUI 패키징 — pnpm deploy 로 평탄(실) node_modules 를 만든 뒤 그 디렉터리에서
// electron-builder 를 실행한다.
//
// 왜 이렇게 하나: pnpm 워크스페이스의 심링크 node_modules 를 electron-builder 의 의존성
// 수집기가 "비결정적으로 누락"한다(예: ajv/sharp 중 일부만 포함 → 패키징 앱이 실행 시
// `Cannot find module` 크래시). `pnpm deploy --prod` 가 dependencies 만 평탄 실 디렉터리로
// 풀어주면 electron-builder 가 안정적으로 전부 수집한다. 자세한 배경은 docs/RELEASE-GUI.md.
//
// 메인은 자기 소스만 번들하고 모든 의존(@kodocagent/*·kordoc·@modelcontextprotocol/sdk·
// iconv-lite 등)을 외부화한다(kordoc 의 동적 require 를 번들이 못 잡기 때문). 따라서 전체
// 런타임 의존 트리가 deploy 의 평탄 node_modules 에 실제로 있어야 하며, pnpm deploy 가 그것을
// 만든다. 네이티브 플랫폼 바이너리(.node)만 deploy 가 빠뜨려 스토어에서 따로 보강한다.
//
// 사용: node scripts/package-app.mjs [electron-builder 인자...]
//   node scripts/package-app.mjs --dir              # 미압축 로컬 빌드
//   node scripts/package-app.mjs --publish never    # 설치파일(.dmg/.exe/.AppImage), 업로드 안 함

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const guiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(guiDir, "..", "..");
const builderArgs = process.argv.slice(2);

// 내부 pnpm 호출 시 verify-deps-before-run 을 끈다. 켜져 있으면 pnpm 이 메인 워크스페이스
// node_modules 를 prod 기준으로 "복구"하려다(= pnpm install --production) devDeps 를 purge 하려 하고,
// 비대화형(no-TTY)에서 중단되거나 워크스페이스를 망가뜨린다.
const pnpmEnv = { ...process.env, npm_config_verify_deps_before_run: "false" };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: repoRoot, shell: isWin, ...opts });
  if (r.status !== 0) {
    console.error(`\n[package-app] 실패: ${cmd} ${args.join(" ")} (exit ${r.status ?? "signal"})`);
    process.exit(r.status ?? 1);
  }
}

// 1) gui + 워크스페이스 의존(@kodocagent/core·doc-tools·shared)을 빌드한다.
//    메인이 @kodocagent/* 를 외부화하므로, deploy 가 그들의 빌드된 dist 를 포함하려면
//    먼저 빌드돼 있어야 한다. `--filter "@kodocagent/gui..."` = gui + 그 의존들.
run("pnpm", ["--filter", "@kodocagent/gui...", "build"], { env: pnpmEnv });

// 2) pnpm deploy --prod --legacy → <tmp> 에 평탄 node_modules + 패키지 파일(files: out·assets·yml).
//    반드시 워크스페이스 루트에서 --filter 로 실행해야 한다(패키지 디렉터리에서 실행하면 deploy 가
//    대상을 못 정해 tarball 을 만든다).
const deployDir = mkdtempSync(join(tmpdir(), "kodoc-gui-deploy-"));
try {
  run("pnpm", ["--filter", "@kodocagent/gui", "deploy", "--prod", "--legacy", deployDir], {
    env: pnpmEnv,
  });

  // 2-1) 네이티브 플랫폼 바이너리 보강. pnpm deploy --prod 는 플랫폼별 optional 패키지
  //      (@img/sharp-<plat>·@img/sharp-libvips-<plat>·@napi-rs/canvas-<plat> = 실제 .node)를
  //      빠뜨린다. 워크스페이스 스토어(.pnpm)에서 현재 설치된 플랫폼용을 deploy node_modules 로
  //      복사한다(pnpm 은 현재 플랫폼 바이너리만 설치하므로 각 CI 러너가 자기 것을 갖게 됨).
  const pnpmStore = join(repoRoot, "node_modules", ".pnpm");
  const deployNM = join(deployDir, "node_modules");
  for (const entry of readdirSync(pnpmStore)) {
    const scope = entry.startsWith("@img+")
      ? "@img"
      : entry.startsWith("@napi-rs+")
        ? "@napi-rs"
        : null;
    if (!scope) continue;
    const innerScopeDir = join(pnpmStore, entry, "node_modules", scope);
    let pkgNames;
    try {
      pkgNames = readdirSync(innerScopeDir);
    } catch {
      continue;
    }
    for (const name of pkgNames) {
      const dst = join(deployNM, scope, name);
      if (existsSync(dst)) continue; // 이미 deploy 된 JS 패키지(@img/colour 등)는 건드리지 않음
      cpSync(join(innerScopeDir, name), dst, { recursive: true, dereference: true });
    }
  }

  // 3) deploy 디렉터리에서 electron-builder 실행. electron(devDep)은 deploy 에 없으므로
  //    electron-builder.yml 의 electronVersion 으로 버전을 해결한다. 산출물은 gui/dist 로 직접
  //    출력한다(.app 을 사후 복사하면 macOS 프레임워크의 내부 심링크가 깨지므로 복사하지 않는다).
  // 서명: 코드사이닝 인증서(CSC_LINK/WIN_CSC_LINK)가 없으면 자동탐색을 꺼 미서명으로 빌드.
  const hasCert =
    process.env.CSC_LINK ||
    process.env.WIN_CSC_LINK ||
    process.env.CSC_IDENTITY_AUTO_DISCOVERY === "true";
  const env = { ...process.env };
  if (!hasCert) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const builderBin = join(
    guiDir,
    "node_modules",
    ".bin",
    isWin ? "electron-builder.cmd" : "electron-builder",
  );
  run(builderBin, [...builderArgs, `-c.directories.output=${join(guiDir, "dist")}`], {
    cwd: deployDir,
    env,
  });
} finally {
  rmSync(deployDir, { recursive: true, force: true });
}

console.log("[package-app] 완료 → packages/gui/dist");
