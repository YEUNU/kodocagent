import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // React 렌더러 테스트(.test.tsx)용 — JSX 변환. .test.ts(node)에는 영향 없음.
  plugins: [react()],
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // .test.ts는 기본(node) 환경, .test.tsx 렌더러 테스트는 파일 상단
    // `// @vitest-environment jsdom` 도크블록으로 파일 단위 jsdom 지정한다.
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**"],
      // 게이트(thresholds) 없음 — 가시화 전용(빌드 차단 방지).
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/dist/**", "**/*.d.ts"],
    },
  },
});
