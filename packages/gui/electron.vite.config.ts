import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    // externalizeDeps: true (기본값) — node_modules는 자동 외부화
    // workspace 패키지도 외부화되므로 빌드 시 node_modules에서 로드됨
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
