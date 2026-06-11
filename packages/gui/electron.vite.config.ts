import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    // externalizeDeps: true (기본값) — node_modules는 자동 외부화
    // workspace 패키지도 외부화되므로 빌드 시 node_modules에서 로드됨
  },
  preload: {
    // preload는 sandbox 환경이므로 externalizeDeps 설정 유지
  },
  renderer: {
    plugins: [react()],
  },
});
