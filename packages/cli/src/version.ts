import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function cliVersion(): string {
  // dist/index.js 기준 ../package.json = 패키지 루트
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}
