import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// 모든 bare specifier(글자/@ 로 시작 — @kodocagent/*·kordoc·@modelcontextprotocol/sdk·
// electron·node 내장 등)를 외부화한다. 상대(./..)·절대(/)·가상(\0) 모듈만 번들된다.
// (이 electron-vite 는 Rolldown 기반이라 external 에 함수가 아닌 string|RegExp 만 받는다.)
//
// ⚠️ 크로스플랫폼 함정: Rolldown 은 external 정규식을 (1) 원본 specifier 와 (2) **해석된
// 절대경로** 양쪽에 적용한다. `./agent-bridge.js` 같은 상대 import 는 (1)에선 안 걸리지만
// 해석 후 경로가 Windows 에선 `C:\...\agent-bridge.ts` 로 시작 → 첫 글자 `C` 가 `[a-zA-Z@]`
// 에 매칭돼 **외부화**되고 확장자가 `.ts` 로 재작성된다(맥/리눅스는 `/Users/...` 라 `/` 로
// 시작 → 안 걸려 정상 번들). 결과: Windows 패키징 앱이 `index.js` 에서 `./agent-bridge.ts`
// 를 import → 실행 즉시 `ERR_MODULE_NOT_FOUND` 크래시(gui-v0.5.0 Windows 회귀).
// → 드라이브 문자 경로(`X:`)를 부정 룩어헤드로 제외해 상대 import 가 모든 OS 에서 번들되게 한다.
const EXTERNAL_BARE = /^(?![a-zA-Z]:)[a-zA-Z@]/;

export default defineConfig({
  main: {
    // 메인은 자기 소스(+상대 import)만 번들하고 npm·워크스페이스 의존은 전부 외부화한다.
    //
    // 이유: kordoc 등은 런타임에 동적 require(`require(변수)` — cfb·ajv 등)를 하므로 번들로
    // 잡히지 않는다. 번들하면 그런 동적 의존이 앱에서 누락돼 실행 시 `Cannot find module`
    // 크래시가 난다. 대신 전부 외부화하고, dist 스크립트의 `pnpm deploy` 가 @kodocagent/*
    // (빌드된 dist)와 전체 전이 npm 트리(kordoc·cfb·ajv·exceljs·MCP-sdk·iconv-lite…)를
    // 평탄 node_modules 로 풀어 electron-builder 가 안정 수집한다.
    build: {
      rollupOptions: {
        external: [EXTERNAL_BARE],
        output: {
          // ESM 출력. @kodocagent/* 패키지의 exports 맵은 "import" 조건만 정의하므로
          // 메인을 CJS(require)로 두면 ERR_PACKAGE_PATH_NOT_EXPORTED 가 난다. ESM import 면
          // 그 조건이 해석되고, ESM 은 외부화된 CJS 의존(kordoc 등)도 정상 import 한다.
          // (electron-vite 가 ESM 메인용 __dirname/__filename 을 주입한다.)
          format: "es",
          entryFileNames: "index.js",
        },
      },
    },
  },
  preload: {
    // 샌드박스 preload는 ESM 불가 → CommonJS(.cjs)로 출력해야 로드된다.
    // (package.json "type":"module" 이라 .js 는 ESM 으로 해석되므로 .cjs 확장자 사용)
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
