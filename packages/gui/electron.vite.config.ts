import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// 모든 bare specifier(글자/@ 로 시작 — @kodocagent/*·kordoc·@modelcontextprotocol/sdk·
// electron·node 내장 등)를 외부화한다. 상대(./..)·절대(/)·가상(\0) 모듈만 번들된다.
// (이 electron-vite 는 Rolldown 기반이라 external 에 함수가 아닌 string|RegExp 만 받는다.)
const EXTERNAL_BARE = /^[a-zA-Z@]/;

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
