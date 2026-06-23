import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node20",
  // Bundle all @kodocagent/* workspace packages into the CLI so the published
  // artifact is self-contained. 워크스페이스 패키지의 전이 CJS 의존(iconv-lite 등)도 인라인된다.
  noExternal: [/^@kodocagent\//],
  banner: {
    // 셰뱅 + createRequire 로 글로벌 `require` 정의. esbuild 의 ESM `__require` 셤은
    // `typeof require !== "undefined"` 면 실 require 를 쓰므로, 인라인된 CJS 의존
    // (iconv-lite → safer-buffer 의 `require("buffer")` 동적 require)이 ESM 번들에서도 동작한다.
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});
